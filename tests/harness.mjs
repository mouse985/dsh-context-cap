// Headless harness for the Client half: loads client.js the way the browser
// module loader does, drives renders with a stubbed React, and asserts the
// registration plus the exact `settings.mutate` this control issues.
//
// The stubs mirror the live Remote contract: `remote.session.modelCatalog()`
// and `remote.settings.describe()/mutate(ns, ops, expectedRevision)` answer
// `{ ok, value }`, so the harness fails if the plugin ever calls the shapes the
// running app does not serve.
// Dev-only; not shipped (package.json `files` excludes it).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

// --- React stub -----------------------------------------------------------------
// One store per mounted component: a late async write from an earlier mount must
// land in that mount's store, not in the store the next scenario just created.
let store = { slots: [], effects: [], cursor: 0 }

function useState(initial) {
  const local = store
  const index = local.cursor++
  if (!(index in local.slots)) local.slots[index] = initial
  const set = value => { local.slots[index] = typeof value === 'function' ? value(local.slots[index]) : value }
  return [local.slots[index], set]
}
function useEffect(effect) {
  const local = store
  local.effects[local.cursor++] = effect
}
function useRef(initial) { return { current: initial } }
function useCallback(fn) { return fn }
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
  return { type, props: { ...(props || {}), children: flat } }
}

const React = { useState, useEffect, useRef, useCallback, createElement }

globalThis.document = { addEventListener() {}, removeEventListener() {} }

// --- Network stub ----------------------------------------------------------------
// Node ships a real fetch, so leaving it live would make the HTTP fallback reach
// this machine's gateway. The default stub rejects; scenario 5 swaps in a recorder.
const fetchCalls = []
let fetchImpl = async (url, init) => {
  fetchCalls.push({ url, init })
  throw new Error('network disabled in harness')
}
globalThis.fetch = (url, init) => fetchImpl(url, init)

// --- Browser plumbing -----------------------------------------------------------
let registration
const registeredModules = new Map()

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registeredModules.set(id, () => factory(name => {
        if (name === 'react') return React
        throw new Error(`unexpected module ${name}`)
      }))
    },
  },
}

const locale = (() => {
  const dictionaries = new Map()
  return {
    register(ns, strings) { dictionaries.set(ns, strings) },
    bind(ns) {
      return (key, vars) => {
        const table = dictionaries.get(ns)
        const template = table.zh[key] ?? key
        return vars ? template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name])) : template
      }
    },
  }
})()

// --- Remote fixtures ------------------------------------------------------------
const state = {
  catalog: { default: { provider: 'llm-deepseek', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] },
  namespaces: [],
  writes: [],
  mutateResponse: null,
  describeError: null,
}

const sessionService = {
  modelCatalog: async () => ({ ok: true, value: state.catalog }),
}

/** Apply a settings op list to a namespace value the way the settings store does. */
function applyOps(value, ops) {
  const next = structuredClone(value)
  for (const op of ops) {
    const path = op.path
    let cursor = next
    for (const key of path.slice(0, -1)) {
      if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {}
      cursor = cursor[key]
    }
    if (op.op === 'unset') delete cursor[path.at(-1)]
    else cursor[path.at(-1)] = structuredClone(op.value)
  }
  return next
}

const settingsService = {
  describe: async () => {
    if (state.describeError) throw new Error(state.describeError)
    return { ok: true, value: { writable: true, hasDocument: true, namespaces: state.namespaces } }
  },
  mutate: async (ns, ops, expectedRevision) => {
    state.writes.push({ ns, ops, expectedRevision })
    if (state.mutateResponse) return state.mutateResponse
    state.namespaces = state.namespaces.map(view => view.ns === ns
      ? { ...view, revision: (view.revision ?? 0) + 1, value: applyOps(view.value, ops) }
      : view)
    return { ok: true, value: state.namespaces.find(view => view.ns === ns) }
  },
}

const serviceTables = {
  withServices: name => {
    if (name === 'remote.session') return sessionService
    if (name === 'remote.settings') return settingsService
    if (name === 'connection') return { api: { session: { modelCatalog: sessionService.modelCatalog }, settings: settingsService } }
    return undefined
  },
  withoutServices: () => undefined,
}

// --- Load + apply ---------------------------------------------------------------
new Function(source)()
const factory = registeredModules.get('dsh-context-cap')
assert.ok(factory, 'client.js must register the module under its package id')
const plugin = factory()
assert.equal(plugin.name, 'dsh-context-cap')
assert.deepEqual(plugin.inject, ['slots', 'locale'])

/** Mount the component against one service table and expose a render helper. */
function mount(getService) {
  const own = { slots: [], effects: [], cursor: 0 }
  let entry
  const slots = {
    registrations: [],
    inject(name, install) { install() },
    register(options, Component) {
      entry = { options, Component }
      slots.registrations.push(entry)
    },
  }
  plugin.apply({ effect: run => run(), get: getService, locale, slots })
  const injected = entry.options.inject('session-1')
  return {
    entry,
    injected,
    render(projection = () => undefined) {
      store = own
      own.cursor = 0
      own.effects = []
      const tree = entry.Component({ ...injected, useProjection: projection })
      for (const effect of own.effects) if (typeof effect === 'function') effect()
      return tree
    },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.props?.children ?? []) findAll(child, predicate, found)
  return found
}

const pillOf = tree => findAll(tree, node => node.type === 'button' && node.props.className === 'dcc-pill')[0]
const optionsOf = tree => findAll(tree, node => node.type === 'button' && node.props.className === 'dcc-opt')
const warningsOf = tree => findAll(tree, node => node.props?.className === 'dcc-warn').map(node => node.props.children)

/** Render until the read settles, then return the tree. */
async function ready(handle) {
  handle.render()
  await settle()
  return handle.render()
}

/** Open the panel if it is closed, then click one preset by its label. */
async function choose(handle, label) {
  let tree = handle.render()
  if (optionsOf(tree).length === 0) {
    pillOf(tree).props.onClick()
    tree = handle.render()
  }
  const options = optionsOf(tree)
  const option = options.find(node => node.props.children[0] === label)
  assert.ok(option, `the panel offers ${label}`)
  option.props.onClick()
  await settle()
  await settle()
  return handle.render()
}

// --- Scenario 1: catalog provider, whole-array write ----------------------------
// The catalog shape (`models: [...]`) is written as the whole array: a path write
// would materialize `models` as an index-keyed object when the user layer has no
// array yet, which the settings schema rejects.
state.catalog = { default: { provider: 'llm-deepseek', model: 'deepseek-v4-flash' }, routableProviders: ['llm-deepseek'], groups: [], failures: [] }
state.namespaces = [{
  ns: 'llm-deepseek',
  revision: 7,
  applies: 'live',
  value: { models: [{ id: 'deepseek-v4-pro', contextWindow: 1000000 }, { id: 'deepseek-v4-flash', contextWindow: 1000000 }] },
}]
state.writes.length = 0

const catalogHandle = mount(serviceTables.withServices)
assert.equal(catalogHandle.entry.options.name, 'conversation.input.right')
assert.equal(catalogHandle.entry.options.id, 'context-cap')
assert.equal(catalogHandle.entry.options.order, 30)
assert.equal(catalogHandle.injected.sessionId, 'session-1')
assert.equal(typeof catalogHandle.injected.call, 'function')

let tree = await ready(catalogHandle)
let pill = pillOf(tree)
assert.ok(pill, 'the pill button must render')
assert.ok(pill.props.children.includes('1M'), 'the pill shows the routed model window')

pill.props.onClick()
const labels = optionsOf(catalogHandle.render()).map(node => node.props.children[0])
assert.deepEqual(labels, ['32k', '64k', '128k', '256k', '512k', '1M', '恢复默认'])

// The settings entry is what a write can move and what `load()` re-reads, so it
// decides the number; the session projection refreshes only on the next step.
const projectedPill = pillOf(catalogHandle.render(() => ({ pressureTokens: 1000, contextWindow: 65536 })))
assert.ok(projectedPill.props.children.includes('1M'), 'the settings value stays authoritative after a write')

const afterWrite = await choose(catalogHandle, '128k')
assert.equal(state.writes.length, 1)
assert.equal(state.writes[0].ns, 'llm-deepseek')
assert.equal(state.writes[0].expectedRevision, 7)
assert.deepEqual(state.writes[0].ops, [{
  op: 'set',
  path: ['models'],
  value: [{ id: 'deepseek-v4-pro', contextWindow: 1000000 }, { id: 'deepseek-v4-flash', contextWindow: 131072 }],
}])

// The write must be visible without waiting for a new step: the read that follows
// it reports the new cap, and the matching preset is the active one.
assert.ok(pillOf(afterWrite).props.children.includes('128k'), 'the new cap shows immediately')
pillOf(catalogHandle.render()).props.onClick()
assert.equal(optionsOf(catalogHandle.render())[2].props['data-active'], true)

await choose(catalogHandle, '恢复默认')
assert.deepEqual(state.writes[1].ops, [{
  op: 'set',
  path: ['models'],
  value: [{ id: 'deepseek-v4-pro', contextWindow: 1000000 }, { id: 'deepseek-v4-flash' }],
}])

// --- Scenario 2: override entry present, patched by path ------------------------
// An entry that already exists is patchable by path; a model with no entry is
// capped through `defaultContextWindow`, which always accepts a bare number.
state.catalog = { default: { provider: 'deepseek-account', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] }
state.namespaces = [{
  ns: 'llm-deepseek-account',
  revision: 2,
  applies: 'live',
  value: { defaultContextWindow: 1000000, maxTokens: 256000, modelOverrides: { 'deepseek-v4-flash': { inputModalities: ['text'] } } },
}]
state.writes.length = 0
state.mutateResponse = null

const overrideHandle = mount(serviceTables.withServices)
tree = await ready(overrideHandle)
pill = pillOf(tree)
assert.ok(pill.props.children.includes('1M'), 'the override entry window is shown')
await choose(overrideHandle, '64k')
assert.equal(state.writes[0].ns, 'llm-deepseek-account')
assert.deepEqual(state.writes[0].ops, [{
  op: 'set',
  path: ['modelOverrides', 'deepseek-v4-flash', 'contextWindow'],
  value: 65536,
}])

// --- Scenario 3: no override entry, cap through defaultContextWindow -------------
state.namespaces = [{
  ns: 'llm-deepseek-account',
  revision: 4,
  applies: 'live',
  value: { defaultContextWindow: 1000000, modelOverrides: {} },
}]
state.writes.length = 0

const defaultHandle = mount(serviceTables.withServices)
tree = await ready(defaultHandle)
assert.ok(pillOf(tree).props.children.includes('1M'), 'the provider default window is shown')
await choose(defaultHandle, '256k')
assert.deepEqual(state.writes[0].ops, [{ op: 'set', path: ['defaultContextWindow'], value: 262144 }])
await choose(defaultHandle, '恢复默认')
assert.deepEqual(state.writes[1].ops, [{ op: 'unset', path: ['defaultContextWindow'] }])

// --- Scenario 4: a failing read must still render a visible pill ----------------
state.catalog = { default: null, routableProviders: [], groups: [], failures: [] }
state.namespaces = []

const failingHandle = mount(serviceTables.withServices)
tree = await ready(failingHandle)
pill = pillOf(tree)
assert.ok(pill, 'a failing read must still render the pill')
assert.ok(pill.props.children.includes('—'), 'the failed read shows a dash instead of a value')
pill.props.onClick()
assert.ok(
  warningsOf(failingHandle.render()).some(text => String(text).includes('读取失败')),
  'the panel names the failure',
)

// --- Scenario 5: same-origin HTTP carries the calls with no client service ------
// The primary transport reaches no service object at all, so a host that exposes
// none of the remote namespaces still reads and writes.
state.catalog = { default: { provider: 'deepseek-account', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] }
state.namespaces = [{
  ns: 'llm-deepseek-account',
  revision: 9,
  applies: 'live',
  value: { defaultContextWindow: 1000000, modelOverrides: {} },
}]
state.writes.length = 0
state.mutateResponse = null
fetchCalls.length = 0
fetchImpl = async (url, init) => {
  const body = JSON.parse(init.body)
  fetchCalls.push({ url, body })
  let value
  if (body.method === 'session/modelCatalog') value = state.catalog
  else if (body.method === 'settings/describe') value = { writable: true, hasDocument: true, namespaces: state.namespaces }
  else if (body.method === 'settings/mutate') {
    state.writes.push(body.payload)
    value = { ns: body.payload.ns, revision: 10, value: {}, user: {} }
  } else {
    return { ok: false, status: 404, async json() { return {} } }
  }
  return { ok: true, status: 200, async json() { return { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } } } }
}

const httpHandle = mount(serviceTables.withoutServices)
tree = await ready(httpHandle)
assert.ok(pillOf(tree).props.children.includes('1M'), 'HTTP alone supplies the window')
assert.equal(fetchCalls[0].url, '/api/session/modelCatalog')
assert.equal(fetchCalls[0].body.type, 'client-request')
assert.equal(fetchCalls[0].body.method, 'session/modelCatalog')
assert.deepEqual(fetchCalls[0].body.payload, {})
assert.equal(fetchCalls[1].body.method, 'settings/describe')

await choose(httpHandle, '128k')
const mutateCall = fetchCalls.filter(entry => entry.body.method === 'settings/mutate').at(-1)
assert.ok(mutateCall, 'the write goes over HTTP')
assert.equal(mutateCall.url, '/api/settings/mutate')
assert.equal(mutateCall.body.payload.ns, 'llm-deepseek-account')
assert.equal(mutateCall.body.payload.expectedRevision, 9)
assert.deepEqual(mutateCall.body.payload.ops, [{ op: 'set', path: ['defaultContextWindow'], value: 131072 }])

// --- Scenario 6: a stale revision reports the conflict, not a raw error ---------
state.catalog = { default: { provider: 'deepseek-account', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] }
state.namespaces = [{
  ns: 'llm-deepseek-account',
  revision: 11,
  applies: 'live',
  value: { defaultContextWindow: 1000000, modelOverrides: {} },
}]
state.writes.length = 0
state.mutateResponse = { ok: false, error: { code: 'settings-conflict', message: 'revision mismatch' } }

const conflictHandle = mount(serviceTables.withServices)
tree = await ready(conflictHandle)
tree = await choose(conflictHandle, '32k')
assert.ok(
  warningsOf(tree).some(text => String(text).includes('设置已被其他地方修改')),
  'a conflict is reported as a conflict',
)

// --- Scenario 7: a write the host accepts but does not reflect ------------------
// A raise must never look like a no-op: when the read-back still reports the old
// window, the panel stays open and names both numbers instead of closing on a
// number nothing confirmed.
state.catalog = { default: { provider: 'deepseek-account', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] }
state.namespaces = [{
  ns: 'llm-deepseek-account',
  revision: 12,
  applies: 'live',
  value: { defaultContextWindow: 1000000, modelOverrides: {} },
}]
state.writes.length = 0
state.mutateResponse = { ok: true, value: { ns: 'llm-deepseek-account', revision: 13, value: {} } }

const staleHandle = mount(serviceTables.withServices)
tree = await ready(staleHandle)
pill = pillOf(tree)
pill.props.onClick()
const staleTree = staleHandle.render()
const raise = optionsOf(staleTree).find(node => node.props.children[0] === '512k')
assert.ok(raise, 'the panel offers 512k')
raise.props.onClick()
await settle()
await settle()
await new Promise(resolve => setTimeout(resolve, 700))
const staleAfter = staleHandle.render()
assert.equal(
  optionsOf(staleAfter).length > 0,
  true,
  'the panel stays open when the read-back disagrees with the write',
)
assert.ok(
  warningsOf(staleAfter).some(text => String(text).includes('512k') && String(text).includes('1M')),
  'the panel names both the written and the read-back window',
)
state.mutateResponse = null

// --- Scenario 8: a channel that is not mounted yet asks for a restart -----------
// Installing or updating the plugin renders the control before the host half is
// composed. That is a wait, not a failure, so the panel offers a restart
// instruction and a retry instead of the transport stack trace.
state.catalog = { default: { provider: 'deepseek-account', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] }
state.namespaces = [{
  ns: 'llm-deepseek-account',
  revision: 14,
  applies: 'live',
  value: { defaultContextWindow: 1000000, modelOverrides: {} },
}]
state.describeError = 'Error: connection API unavailable'
// Both transports must be down: `call` falls back to same-origin HTTP whenever the
// client service throws, so a live recorder would mask the broken channel.
const liveFetch = fetchImpl
fetchImpl = async () => { throw new Error('fetch unavailable') }

const notReadyHandle = mount(serviceTables.withServices)
tree = await ready(notReadyHandle)
assert.ok(pillOf(tree).props.children.includes('—'), 'an unreachable host shows a dash')
pillOf(tree).props.onClick()
const notReadyTree = notReadyHandle.render()
assert.ok(
  warningsOf(notReadyTree).some(text => String(text).includes('重启 DSH')),
  'the panel asks for a DSH restart',
)
assert.ok(
  !warningsOf(notReadyTree).some(text => String(text).includes('connection API unavailable')),
  'the raw transport error stays out of the panel',
)
const retryButton = optionsOf(notReadyTree).find(node => node.props.children[0] === '重试')
assert.ok(retryButton, 'the panel offers a retry')
state.describeError = null
fetchImpl = liveFetch
retryButton.props.onClick()
await settle()
await settle()
assert.ok(
  optionsOf(notReadyHandle.render()).length > 0,
  'the retry reads the window once the channel is up',
)

console.log('@@RESULT@@' + JSON.stringify({ ok: true, writes: state.writes.length, scenarios: 8 }))

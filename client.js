// dsh-context-cap — Client half.
//
// A compact control in the composer tool row that reads the routed model's
// context window through the `settings` RPC and writes it back with
// `settings.mutate` — the field the Models settings page edits. Lowering it
// makes `dsh-compaction-basic` resolve a smaller capacity
// (`thresholdRatio` × window) and compact earlier, so a long conversation can
// no longer grow until one request fills the provider's real window.
//
// Plain browser module: the module loader evaluates this file as a classic
// script, so it registers itself and pulls React from the shared table.
(() => {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return

  window.__ModuleLoader__.load({
    id: 'dsh-context-cap',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports

      const React = require('react')
      const h = React.createElement

      /** Locale namespace owned by this plugin. */
      const NS = 'context-cap'

      /** Compaction fires at this fraction of the routed window (compaction-basic default). */
      const THRESHOLD_RATIO = 0.8

      /** Offered windows, in tokens; the last one matches the shipped DeepSeek default. */
      const PRESETS = [32768, 65536, 131072, 262144, 524288, 1048576]

      /**
       * Read attempts spent on a channel that is still mounting. A freshly
       * installed or updated plugin paints its control before the host half is
       * composed, so the first reads fail on a missing namespace; those are a
       * wait, and the wait outlasts a user reloading the window by hand.
       */
      const NOT_READY_RETRIES = 20

      /** Gateway transport prefix on the same origin (`packages/client/connection/src/index.ts`). */
      const API_PATH = '/api'

      /** Fallback counter for RPC ids when the runtime has no `crypto.randomUUID`. */
      let rpcCounter = 0

      const STRINGS = {
        zh: {
          'label': '上下文',
          'title': '上下文上限',
          'hint': '限制当前模型的上下文窗口；自动压缩在窗口的 80% 触发。',
          'note.title': '上限 = 模型的上下文窗口',
          'note.body':
            '写入该模型的 contextWindow，自动压缩阈值随之为窗口 × 80%。'
            + '它对该模型的所有会话生效，可随时改回。',
          'usage': '当前 ~{used} / {cap}',
          'compactAt': '压缩点 ~{at}',
          'noUsage': '暂无用量数据',
          'default': '恢复默认',
          'fixed': '提供方固定',
          'fixedBody': '该模型的上下文窗口不来自可编辑的设置项。',
          'loading': '读取中…',
          'busy': '写入中…',
          'conflict': '设置已被其他地方修改，已重新读取，请再试一次。',
          'error': '读取失败：{message}',
          'restart': '该提供方的设置在下一次启动后生效。',
          'restartNeeded': '界面已就绪，但宿主通道还没接上。重启 DSH 后这个控件才能真正读写设置。',
          'retry': '重试',
          'verifyMismatch': '已写入 {want}，但读回仍是 {got}：重启 DSH 后才会生效。',
          'verifyLag': '已写入 {want}；这一页回读仍是 {got}，下一轮请求按新值计算，重启 DSH 后再核对一次。',
          'unverified': '已写入 {want}；这一页暂时读不回来，新一轮开始时会按它算压缩点。',
        },
        en: {
          'label': 'Context',
          'title': 'Context cap',
          'hint': 'Cap this model’s context window; auto-compaction fires at 80% of it.',
          'note.title': 'The cap is the model’s context window',
          'note.body':
            'Writes the model’s contextWindow, so auto-compaction triggers at 80% of it. '
            + 'It applies to every conversation using that model and can be reverted here.',
          'usage': 'now ~{used} / {cap}',
          'compactAt': 'compacts at ~{at}',
          'noUsage': 'no usage yet',
          'default': 'Default',
          'fixed': 'provider-fixed',
          'fixedBody': 'This model’s window does not come from an editable setting.',
          'loading': 'Reading…',
          'busy': 'Writing…',
          'conflict': 'Settings changed elsewhere; reloaded. Try again.',
          'error': 'Read failed: {message}',
          'restart': 'This provider applies its settings on the next start.',
          'restartNeeded': 'The UI is ready but the host channel is not. Restart DSH before this control can read or write settings.',
          'retry': 'Retry',
          'verifyMismatch': 'Wrote {want}, but the read-back still reports {got}: a DSH restart makes it stick.',
          'verifyLag': 'Wrote {want}; this page still reads {got}. New turns use the new value — re-check after a DSH restart.',
          'unverified': 'Wrote {want}; this page cannot read it back yet. New turns use it for the compaction point.',
        },
      }

      /** Render a token count the way the model chip does: 32k / 128k / 1M. */
      function formatTokens(tokens) {
        if (!Number.isFinite(tokens) || tokens <= 0) return '—'
        if (tokens >= 950000) {
          const millions = tokens / 1000000
          return Math.abs(millions - Math.round(millions)) < 0.05
            ? `${Math.round(millions)}M`
            : `${millions.toFixed(1)}M`
        }
        if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`
        return String(tokens)
      }

      /** Whether a preset names the same window, allowing 1M vs 1048576 to agree. */
      function sameWindow(actual, preset) {
        return typeof actual === 'number' && Math.abs(actual - preset) <= preset * 0.05
      }

      /** Turn a locale key into text even when the locale service is unavailable. */
      function safeTranslate(t, key, vars) {
        if (typeof t === 'function') {
          try {
            const text = t(key, vars)
            if (typeof text === 'string' && text.length > 0) return text
          } catch {
            // Fall through to the raw key: a missing translation must not blank the control.
          }
        }
        return key
      }

      /**
       * Find the editable window of one routed model and how that window is
       * expressed. Three settings shapes reach this: a single catalog array
       * (`models`), a per-provider catalog (`providers.<route>.models`), and an
       * override map keyed by model id (`modelOverrides` over
       * `defaultContextWindow`).
       *
       * A catalog write targets the whole array, not `models.<i>.contextWindow`:
       * a path write would materialize `models` as an index-keyed object when the
       * user layer has no array yet, which the schema then rejects. An override
       * entry is patchable by path because the entry itself already exists; a
       * model without one is capped through `defaultContextWindow`, which always
       * accepts a bare number.
       */
      function locateModel(namespaces, selection) {
        if (!Array.isArray(namespaces)) return null
        let best = null
        const consider = (candidate, score) => {
          if (candidate !== null && (best === null || score > best.score)) best = { ...candidate, score }
        }
        for (const view of namespaces) {
          const value = view && view.value
          if (!value || typeof value !== 'object') continue
          const named = typeof view.ns === 'string' && typeof selection.provider === 'string'
            && view.ns.includes(selection.provider)
          const base = { ns: view.ns, revision: view.revision, applies: view.applies }
          const catalogs = []
          if (Array.isArray(value.models)) catalogs.push({ path: ['models'], rows: value.models })
          const providers = value.providers
          const route = providers && typeof providers === 'object' ? providers[selection.provider] : undefined
          if (route && Array.isArray(route.models)) {
            catalogs.push({ path: ['providers', selection.provider, 'models'], rows: route.models })
          }
          for (const catalog of catalogs) {
            const index = catalog.rows.findIndex(row => row && row.id === selection.model)
            if (index >= 0) {
              consider({
                ...base,
                kind: 'catalog',
                path: catalog.path,
                rows: catalog.rows,
                index,
                window: catalog.rows[index].contextWindow,
              }, named ? 3 : 2)
            }
          }
          const overrides = value.modelOverrides && typeof value.modelOverrides === 'object'
            ? value.modelOverrides
            : undefined
          const fallback = typeof value.defaultContextWindow === 'number' ? value.defaultContextWindow : undefined
          if (overrides === undefined && fallback === undefined) continue
          const entry = overrides === undefined ? undefined : overrides[selection.model]
          if (entry && typeof entry === 'object') {
            consider({
              ...base,
              kind: 'override',
              path: ['modelOverrides', selection.model, 'contextWindow'],
              window: typeof entry.contextWindow === 'number' ? entry.contextWindow : fallback,
            }, named ? 3 : 2)
          } else if (fallback !== undefined) {
            consider({ ...base, kind: 'default', path: ['defaultContextWindow'], window: fallback }, named ? 1 : 0)
          }
        }
        return best
      }

      /** Inline stylesheet: mounted with the component, so unmounting removes it. */
      const STYLES = `
.dcc-root { position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; }
.dcc-pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, #e4e4e4); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b6b6b);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
}
.dcc-pill:hover, .dcc-pill[aria-expanded="true"] {
  background: var(--dsw-alias-bg-layer-2, #f4f4f4);
  color: var(--dsw-alias-label-primary, #171717);
}
.dcc-pill:focus-visible { outline: 2px solid var(--dsw-alias-label-brand, #436ee8); outline-offset: 2px; }
.dcc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-brand, #436ee8); }
.dcc-dot[data-level="warn"] { background: #d97706; }
.dcc-dot[data-level="over"] { background: #dc2626; }
.dcc-dot[data-level="muted"] { background: var(--dsw-alias-border-l2, #c4c4c4); }
.dcc-panel {
  position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 40;
  width: 276px; box-sizing: border-box; padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1, #e4e4e4); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 12px 32px rgb(0 0 0 / 16%);
  color: var(--dsw-alias-label-primary, #171717);
  font: inherit; font-size: 12px; line-height: 1.5; text-align: left;
}
.dcc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dcc-head b { font-size: 13px; font-weight: 600; }
.dcc-sub { color: var(--dsw-alias-label-secondary, #6b6b6b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcc-usage { margin-top: 6px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dcc-track { position: relative; height: 4px; margin-top: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #eee); overflow: hidden; }
.dcc-fill { position: absolute; inset: 0 auto 0 0; background: var(--dsw-alias-label-brand, #436ee8); }
.dcc-fill[data-level="warn"] { background: #d97706; }
.dcc-fill[data-level="over"] { background: #dc2626; }
.dcc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
.dcc-opt {
  height: 30px; padding: 0; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #e4e4e4); background: transparent;
  color: inherit; font: inherit; font-size: 12px;
}
.dcc-opt:hover { background: var(--dsw-alias-bg-layer-2, #f4f4f4); }
.dcc-opt[data-active="true"] {
  border-color: var(--dsw-alias-label-brand, #436ee8);
  color: var(--dsw-alias-label-brand, #436ee8);
  background: var(--dsw-alias-bg-layer-2, #f4f4f4);
  font-weight: 600;
}
.dcc-opt:disabled { opacity: 0.5; cursor: default; }
.dcc-opt:focus-visible { outline: 2px solid var(--dsw-alias-label-brand, #436ee8); outline-offset: 1px; }
.dcc-note {
  margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1, #eee);
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dcc-note b { display: block; margin-bottom: 2px; color: var(--dsw-alias-label-primary, #171717); font-weight: 600; }
.dcc-warn { margin-top: 8px; color: #b45309; overflow-wrap: anywhere; }
`

      function CapControl(props) {
        const sessionId = props.sessionId
        const call = props.call
        const t = (key, vars) => safeTranslate(props.t, key, vars)

        // A projection read must never take the control down with it.
        let pressure
        try {
          pressure = typeof props.useProjection === 'function' ? props.useProjection('contextPressure') : undefined
        } catch {
          pressure = undefined
        }

        const [snapshot, setSnapshot] = React.useState({ status: 'loading' })
        const [open, setOpen] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const [pendingRestart, setPendingRestart] = React.useState(false)
        const rootRef = React.useRef(null)
        const requestRef = React.useRef(0)
        const attemptRef = React.useRef(0)

        /**
         * Read the routed model's window into the snapshot.
         * @returns The window the settings report now, or `undefined` when the
         * read failed — a write uses it to confirm what the host stored.
         */
        const load = React.useCallback(async () => {
          const ticket = ++requestRef.current
          try {
            const catalog = unwrap(await call('session', 'modelCatalog', []))
            const selection = catalog && catalog.default ? catalog.default : null
            if (!selection) throw new Error('modelCatalog reported no deployment default model')
            const view = unwrap(await call('settings', 'describe', []))
            if (ticket !== requestRef.current) return undefined
            const located = locateModel(view.namespaces, selection)
            attemptRef.current = 0
            if (located === null) {
              setSnapshot({ status: 'fixed', model: selection.model })
              return null
            }
            setSnapshot({
              status: 'ready',
              model: selection.model,
              kind: located.kind,
              ns: located.ns,
              revision: located.revision,
              applies: located.applies,
              path: located.path,
              rows: located.rows,
              index: located.index,
              window: typeof located.window === 'number' ? located.window : null,
            })
            return typeof located.window === 'number' ? located.window : null
          } catch (error) {
            if (ticket !== requestRef.current) return undefined
            setSnapshot({ status: 'error', message: messageOf(error) })
            return undefined
          }
        }, [call, sessionId])

        React.useEffect(() => {
          void load()
          return () => { requestRef.current += 1 }
        }, [load])

        // The connection service comes up after the first paint, and a plugin
        // installed or updated in this process mounts its control before the
        // host half is composed. Both are a wait, not a dead end: retry with a
        // growing delay instead of leaving the pill at `—` for good.
        React.useEffect(() => {
          if (snapshot.status !== 'error' || attemptRef.current >= NOT_READY_RETRIES) return
          const attempt = attemptRef.current
          attemptRef.current = attempt + 1
          const timer = setTimeout(() => { void load() }, Math.min(2000, 400 + attempt * 200))
          return () => clearTimeout(timer)
        }, [snapshot, load])

        /** Drop the retry budget and read again, for the panel's retry button. */
        const retry = React.useCallback(() => {
          attemptRef.current = 0
          setSnapshot({ status: 'loading' })
          setNotice(null)
          void load()
        }, [load])

        React.useEffect(() => {
          if (!open) return
          const onPointerDown = event => {
            if (event.target instanceof Node && rootRef.current && rootRef.current.contains(event.target)) return
            setOpen(false)
          }
          const onKeyDown = event => {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('pointerdown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open])

        /**
         * Write one window and confirm it landed. A catalog write sends the whole
         * array because a path write would materialize `models` as an
         * index-keyed object the schema rejects; an override entry is patchable by
         * path. The panel then re-reads instead of trusting the write: a number
         * the host did not store must not look like a number it did.
         * @param tokens Window in tokens, or null to drop the cap.
         */
        const write = React.useCallback(async tokens => {
          if (snapshot.status !== 'ready') return
          setBusy(true)
          setNotice(null)
          setPendingRestart(false)
          const nextRows = snapshot.kind === 'catalog'
            ? snapshot.rows.map((row, index) => {
              if (index !== snapshot.index) return row
              if (tokens === null) {
                const { contextWindow: _removed, ...rest } = row
                return rest
              }
              return { ...row, contextWindow: tokens }
            })
            : snapshot.rows
          try {
            const ops = snapshot.kind === 'catalog'
              ? [{ op: 'set', path: snapshot.path, value: nextRows }]
              : [tokens === null
                ? { op: 'unset', path: snapshot.path }
                : { op: 'set', path: snapshot.path, value: tokens }]
            const response = await call('settings', 'mutate', [snapshot.ns, ops, snapshot.revision])
            try {
              unwrap(response)
            } catch (error) {
              const code = errorCodeOf(response)
              setNotice(code === 'settings-conflict' ? t('conflict') : messageOf(error))
              await load()
              return
            }
            // The chosen number is what the user just decided, so show it at
            // once: the read-back below can lag a restart-only provider by a
            // whole process, and a raise must never look like a no-op.
            setSnapshot(previous => previous.status === 'ready'
              ? { ...previous, window: tokens, rows: nextRows }
              : previous)
            const confirmed = await load()
            if (tokens === null) {
              setOpen(false)
              return
            }
            if (confirmed !== undefined && confirmed !== null && sameWindow(confirmed, tokens)) {
              setOpen(false)
              return
            }
            if (confirmed === undefined) {
              setNotice(t('unverified', { want: formatTokens(tokens) }))
              return
            }
            // One settle read: a live provider can report the new value a moment
            // after accepting the write, and a mismatch here is otherwise
            // indistinguishable from "the write never landed".
            await new Promise(resolve => setTimeout(resolve, 500))
            const settled = await load()
            if (settled !== undefined && settled !== null && sameWindow(settled, tokens)) {
              setOpen(false)
              return
            }
            const got = settled === undefined ? confirmed : settled
            setPendingRestart(true)
            setNotice(got === null || got === undefined
              ? t('verifyMismatch', { want: formatTokens(tokens), got: t('fixed') })
              : t(snapshot.applies === 'restart' ? 'verifyMismatch' : 'verifyLag', {
                want: formatTokens(tokens),
                got: formatTokens(got),
              }))
          } catch (error) {
            setNotice(messageOf(error))
          } finally {
            setBusy(false)
          }
        }, [call, load, snapshot, t])

        // The settings value decides the number: `load()` re-reads the entry right
        // after a write, so the panel and the pill agree immediately. The session
        // projection only refreshes on the next step, so it is the fallback for a
        // provider whose window comes from no editable setting.
        const projected = typeof pressure?.contextWindow === 'number' && pressure.contextWindow > 0
          ? pressure.contextWindow
          : null
        const window = snapshot.status === 'ready'
          ? snapshot.window ?? projected
          : snapshot.status === 'fixed'
            ? projected
            : null
        const used = pressure && typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : null
        const percent = used !== null && window !== null && window > 0
          ? Math.min(100, Math.round(used / window * 100))
          : null
        const level = percent === null ? 'muted' : percent >= 100 ? 'over' : percent >= 80 ? 'warn' : 'ok'

        const pillText = snapshot.status === 'ready'
          ? formatTokens(window)
          : snapshot.status === 'fixed'
            ? t('fixed')
            : snapshot.status === 'error'
              ? '—'
              : t('loading')

        const panel = open && h('div', { className: 'dcc-panel', role: 'dialog', 'aria-label': t('title') },
          h('div', { className: 'dcc-head' },
            h('b', null, t('title')),
            h('span', { className: 'dcc-sub' }, snapshot.model ?? ''),
          ),
          snapshot.status === 'loading' && h('div', { className: 'dcc-usage' }, t('loading')),
          snapshot.status === 'error' && (isNotReady(snapshot.message)
            ? h('div', null,
              h('div', { className: 'dcc-warn' }, t('restartNeeded')),
              h('button', {
                type: 'button',
                className: 'dcc-opt',
                disabled: busy,
                onClick: retry,
              }, t('retry')),
            )
            : h('div', { className: 'dcc-warn' }, t('error', { message: snapshot.message }))),
          snapshot.status === 'fixed' && h('div', { className: 'dcc-warn' }, t('fixedBody')),
          snapshot.status === 'ready' && h('div', null,
            h('div', { className: 'dcc-usage' },
              used !== null
                ? t('usage', { used: formatTokens(used), cap: formatTokens(window) })
                : t('noUsage'),
            ),
            percent !== null && h('div', { className: 'dcc-track' },
              h('div', { className: 'dcc-fill', 'data-level': level, style: { width: `${percent}%` } }),
            ),
            h('div', { className: 'dcc-usage' },
              window !== null ? t('compactAt', { at: formatTokens(Math.floor(window * THRESHOLD_RATIO)) }) : '',
            ),
            h('div', { className: 'dcc-grid' },
              PRESETS.map(tokens => h('button', {
                key: tokens,
                type: 'button',
                className: 'dcc-opt',
                'data-active': sameWindow(window, tokens),
                disabled: busy,
                onClick: () => { void write(tokens) },
              }, formatTokens(tokens))),
              h('button', {
                key: 'default',
                type: 'button',
                className: 'dcc-opt',
                disabled: busy,
                onClick: () => { void write(null) },
              }, t('default')),
            ),
            busy && h('div', { className: 'dcc-usage' }, t('busy')),
            notice !== null && h('div', { className: 'dcc-warn' }, notice),
            snapshot.applies === 'restart' && h('div', { className: 'dcc-warn' }, t('restart')),
            pendingRestart && h('div', { className: 'dcc-warn' }, t('restart')),
          ),
          h('div', { className: 'dcc-note' },
            h('b', null, t('note.title')),
            t('note.body'),
          ),
        )

        return h('span', { ref: rootRef, className: 'dcc-root', 'data-plugin': 'dsh-context-cap' },
          h('style', null, STYLES),
          h('button', {
            type: 'button',
            className: 'dcc-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': t('hint'),
            title: t('hint'),
            onClick: () => setOpen(!open),
          },
            h('span', { className: 'dcc-dot', 'data-level': level, 'aria-hidden': true }),
            t('label'),
            ' ',
            pillText,
          ),
          panel,
        )
      }

      /**
       * Build the error one failed Remote result carries, keeping its code so a
       * caller can tell an optimistic-concurrency conflict from a real failure.
       * @param failure Failed Remote result or its `error` member.
       * @returns The error to throw.
       */
      function remoteErrorOf(failure) {
        const error = failure && typeof failure === 'object' && failure.error !== undefined ? failure.error : failure
        const message = error && typeof error.message === 'string' ? error.message : 'request failed'
        const wrapped = new Error(message)
        if (error && typeof error.code === 'string') wrapped.code = error.code
        return wrapped
      }

      /**
       * Read the failure code out of any face a call can fail through, without
       * deciding whether the call actually failed.
       * @param response Result of one call, in any of the accepted envelopes.
       * @returns The failure code when the response carries one.
       */
      function errorCodeOf(response) {
        if (!response || typeof response !== 'object') return undefined
        if (typeof response.code === 'string') return response.code
        const nested = response.result !== undefined ? response.result : response
        if (nested && typeof nested === 'object') {
          if (typeof nested.code === 'string') return nested.code
          const error = nested.error
          if (error && typeof error === 'object' && typeof error.code === 'string') return error.code
        }
        return undefined
      }

      /**
       * Accept every envelope a Remote call can answer with: the typed
       * `{ ok, value }` result, the `{ type, rpcId, result }` wire response
       * carrying it, and the bare value of a namespace method.
       * @param response Result of one call.
       * @returns The response value.
       */
      function unwrap(response) {
        if (!response || typeof response !== 'object' || Array.isArray(response)) return response
        if (typeof response.ok === 'boolean') {
          if (response.ok !== true) throw remoteErrorOf(response)
          return response.value
        }
        const nested = response.result
        if (nested && typeof nested === 'object') {
          if (typeof nested.ok === 'boolean') {
            if (nested.ok !== true) throw remoteErrorOf(nested)
            return nested.value
          }
          if ('result' in nested) return unwrap(nested.result)
        }
        return response
      }

      /** Error text for the panel, never a thrown value. */
      function messageOf(error) {
        if (error instanceof Error) return error.message
        try {
          return typeof error === 'string' ? error : JSON.stringify(error)
        } catch {
          return String(error)
        }
      }

      /** Markers of a host channel that has not mounted yet, not of a real refusal. */
      const NOT_READY_MARKERS = [
        'service unavailable',
        'without inject',
        'connection API unavailable',
        'has no models',
        'transport failure',
        'fetch unavailable',
        'HTTP 403',
        'HTTP 404',
      ]

      /**
       * Whether a failed read means "the host half is not composed in this
       * process yet" — the state right after installing or updating the plugin
       * and before DSH restarts. The user needs a restart instruction, not the
       * transport stack trace.
       * @param message Failure text produced by `call`.
       * @returns True when the channel, rather than the call, is missing.
       */
      function isNotReady(message) {
        if (typeof message !== 'string') return false
        return NOT_READY_MARKERS.some(marker => message.includes(marker))
      }

      /** Plugin body: one locale registration and one composer-slot registration. */
      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, STRINGS), 'context-cap locale')
        const t = ctx.locale.bind(NS)

        /** Read one property through the tracing guard; a denied read is `undefined`. */
        const pick = (object, key) => {
          try {
            if (!object || typeof object !== 'object') return undefined
            const value = object[key]
            return typeof value === 'function' ? value.bind(object) : value
          } catch {
            return undefined
          }
        }

        /**
         * Read one client service without the strict liveness gate: the caller
         * resolves on every call, so a provider that is still mounting is a
         * retry rather than a hard failure.
         */
        const serviceOf = key => {
          try {
            if (typeof ctx.get !== 'function') return undefined
            const value = ctx.get(key, false)
            return value && typeof value === 'object' ? value : undefined
          } catch {
            return undefined
          }
        }

        /** Remote namespace → the client service key that carries it. */
        const NAMESPACE_SERVICE = { session: 'remote.session', settings: 'remote.settings' }

        /** Wire names of the parameters this plugin passes, for the HTTP fallback. */
        const PARAMETER_NAMES = { 'settings.mutate': ['ns', 'ops', 'expectedRevision'] }

        /** Every callable method of one namespace service, read through the guard. */
        const methodsOf = service => {
          const names = []
          let keys
          try {
            keys = Object.keys(service)
          } catch {
            return names
          }
          for (const key of keys) if (methodOf(service, key).fn !== undefined) names.push(key)
          return names
        }

        /**
         * Read one method off a namespace service without throwing. The cordis
         * tracing proxy refuses property reads on a service the caller did not
         * inject, so the refusal is reported as data rather than propagated.
         */
        const methodOf = (service, method) => {
          try {
            const value = service[method]
            if (typeof value !== 'function') return { refusal: `not callable (${typeof value})` }
            return { fn: value.bind(service) }
          } catch (error) {
            return { refusal: messageOf(error) }
          }
        }

        /** One browser-side RPC id; the gateway only echoes it back. */
        const rpcId = () => {
          try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
          } catch {
            /* Fall through to the counter form. */
          }
          rpcCounter += 1
          return `context-cap-${String(Date.now())}-${String(rpcCounter)}`
        }

        /**
         * Call one Remote method over plain same-origin HTTP: the gateway routes
         * `POST ${API_PATH}/<namespace>/<method>` and validates the argument
         * record against that method's parameters. Both argument carriers are
         * tried because a wrong carrier is refused with an ordinary 4xx.
         * @param namespace Remote namespace.
         * @param method Method name.
         * @param record Positional arguments keyed by parameter name.
         * @returns The gateway response.
         */
        const postRpc = async (namespace, method, record) => {
          if (typeof fetch !== 'function') throw new Error('fetch unavailable')
          const endpoint = `${namespace}/${method}`
          const problems = []
          for (const payload of [record, { args: record }]) {
            const response = await fetch(`${API_PATH}/${endpoint}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method: endpoint, payload }),
              credentials: 'same-origin',
            })
            if (response.ok) return await response.json()
            problems.push(`HTTP ${String(response.status)}`)
          }
          throw new Error(`${problems.join('/')} for ${endpoint}`)
        }

        /** Positional arguments of one call as the parameter-keyed record the wire uses. */
        const recordOf = (namespace, method, args) => {
          const names = PARAMETER_NAMES[`${namespace}.${method}`] ?? []
          const record = {}
          names.forEach((name, index) => {
            if (index < args.length && args[index] !== undefined) record[name] = args[index]
          })
          return record
        }

        /**
         * One call to the host API: the typed `remote.<namespace>` client service
         * first, then same-origin HTTP. The service carries the assembled client
         * transport, so resolving it on every call keeps a late mount harmless.
         * @param namespace Remote namespace, e.g. `settings`.
         * @param method Method name, e.g. `mutate`.
         * @param args Positional arguments.
         * @returns The Remote result.
         */
        const call = async (namespace, method, args) => {
          const problems = []
          const key = NAMESPACE_SERVICE[namespace] ?? `remote.${namespace}`
          const service = serviceOf(key)
          if (service === undefined) {
            problems.push(`${key} service unavailable`)
          } else {
            const target = methodOf(service, method)
            if (target.fn === undefined) {
              problems.push(`${key}.${method}: ${target.refusal} (have ${methodsOf(service).join(', ') || 'none'})`)
            } else {
              try {
                return await target.fn(...args)
              } catch (error) {
                problems.push(`${key}.${method}: ${messageOf(error)}`)
              }
            }
          }
          try {
            return await postRpc(namespace, method, recordOf(namespace, method, args))
          } catch (error) {
            problems.push(`http(${namespace}/${method}): ${messageOf(error)}`)
          }
          throw new Error(problems.join(' | '))
        }

        /** Diagnostic hook for the panel's error text and for a live probe. */
        const probe = () => {
          const report = {}
          for (const [namespace, key] of Object.entries(NAMESPACE_SERVICE)) {
            const service = serviceOf(key)
            report[namespace] = {
              via: key,
              present: service !== undefined,
              methods: service === undefined ? [] : methodsOf(service),
            }
          }
          const connection = serviceOf('connection')
          report.transport = {
            http: typeof fetch === 'function',
            api: Boolean(pick(connection, 'api')),
            keys: connection ? Object.keys(connection) : [],
          }
          return report
        }
        try {
          window.__dshContextCap = { probe, call }
        } catch {
          /* Non-browser host: the probe is optional. */
        }

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'context-cap',
            order: 30,
            label: t('label'),
            inject: sessionId => ({ sessionId, t, call }),
          },
          CapControl,
        ))
      }

      exports.name = 'dsh-context-cap'
      // Only the two services this plugin registers into are declared: the Remote
      // namespaces are resolved with the non-strict registry read `ctx.get(key,
      // false)` on every call, so a namespace that mounts late — or not at all —
      // delays nothing and blocks no activation.
      exports.inject = ['slots', 'locale']
      exports.apply = apply
      return module.exports
    },
  })
})()

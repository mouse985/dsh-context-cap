/**
 * Node half of `dsh-context-cap`.
 *
 * The plugin has no Host service: the composer control reads and writes the
 * model catalog through the existing `settings` RPC, so this row only exists
 * to carry the bundle patch and the Client half. `apply` is intentionally
 * empty.
 *
 * @module dsh-context-cap
 */

export const name = 'context-cap'

export function apply() {}

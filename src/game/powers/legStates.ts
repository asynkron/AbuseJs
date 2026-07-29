/**
 * Which leg animation belongs on screen, given a power.
 *
 * DARNEL ships three parallel sets of ground and jump animations - the plain
 * one, `fast_*` and `fly_*` - and nothing in the lisp selects between them,
 * because the C++ mover picks the prefix from `special_power`. Both variant
 * sets are in `chars.json` with the right frame counts, so the choice is ours
 * to make and this is where it is made.
 */

/** The states that have `fast_` and `fly_` twins - lisp/people.lsp def_char DARNEL. */
const POWERED_LEG_STATES: ReadonlySet<string> = new Set([
  'stopped',
  'running',
  'start_run_jump',
  'run_jump',
  'run_jump_fall',
  'end_run_jump',
])

/**
 * The leg states the torso is drawn over - `top_draw_state` in
 * lisp/people.lsp. Climbing, flinching, dying and the powered leg sets all
 * hide it, which is why the cop has no gun while he is on a ladder.
 */
const TORSO_LEG_STATES: ReadonlySet<string> = new Set([
  'stopped',
  'running',
  'run_jump',
  'run_jump_fall',
  'end_run_jump',
])

/** True when the aiming torso belongs over these legs. */
export function drawsTorso(legState: string): boolean {
  return TORSO_LEG_STATES.has(legState)
}

/**
 * Maps a base leg state onto the variant a power uses, falling back when the
 * character has no such frames. `exists` is the asset layer's `hasState`;
 * leaving it out trusts the name.
 */
export function legStateFor(
  base: string,
  prefix: string | undefined,
  exists?: (state: string) => boolean,
): string {
  if (!prefix || !POWERED_LEG_STATES.has(base)) return base
  const variant = `${prefix}${base}`
  return !exists || exists(variant) ? variant : base
}

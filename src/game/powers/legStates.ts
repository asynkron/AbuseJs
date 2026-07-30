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
 * The leg states the torso is drawn over - `top_draw` in src/cop.cpp, which is
 * the live version of the commented-out `top_draw_state` in lisp/people.lsp.
 * Climbing, flinching and dying hide it, which is why the cop has no gun while
 * he is on a ladder.
 *
 * The `fast_` and `fly_` twins are deliberately not listed, and must not be:
 * see `drawsTorso`.
 */
const TORSO_LEG_STATES: ReadonlySet<string> = new Set([
  'stopped',
  'running',
  'run_jump',
  'run_jump_fall',
  'end_run_jump',
])

/** The prefixes `legStateFor` can put on a base state. */
const POWER_PREFIXES = ['fast_', 'fly_'] as const

/**
 * Strips a power prefix back off, so a state can be tested as the base one.
 *
 * In the original the powered art is never a state the cop is *in*. `bottom_draw`
 * saves `o->state`, swaps in `S_fast_running` or `S_fly_running` for the one
 * `player_draw` call, and puts the old state straight back (src/cop.cpp, the
 * FAST_POWER and FLY_POWER arms). The substitution lasts one draw and nothing
 * else ever sees it.
 */
function baseLegState(legState: string): string {
  for (const prefix of POWER_PREFIXES) {
    if (legState.startsWith(prefix)) return legState.slice(prefix.length)
  }
  return legState
}

/**
 * True when the aiming torso belongs over these legs.
 *
 * Tested against the base state, because this port keeps the powered variant in
 * `state` rather than swapping it in for a single draw. `top_draw` in the
 * original only ever sees the plain state, so holding a power has never hidden
 * the cop's torso - and it must not, since he can still aim and fire while
 * running fast or flying.
 */
export function drawsTorso(legState: string): boolean {
  return TORSO_LEG_STATES.has(baseLegState(legState))
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

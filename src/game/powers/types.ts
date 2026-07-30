/**
 * The vocabulary the powers subsystem is written in.
 *
 * A power is a small stateful object with three optional hooks - `hold`,
 * `release` and `visuals` - and no knowledge of the renderer, the level or the
 * player class. Everything it needs to touch arrives through `PowerHost`, so
 * the four powers compose into `Powers` rather than into a branch inside the
 * player's tick.
 */

/**
 * Which power is in hand. The original keeps this in a `special_power`
 * instance variable enumerated NO_POWER / FAST_POWER / FLY_POWER /
 * SNEAKY_POWER / HEALTH_POWER (lisp/people.lsp), with NO_POWER modelled here
 * as an absent effect rather than a fifth case.
 *
 * SHLAMP_POWER is the sixth entry in that enum and belongs to the fRaBs addon,
 * which ships art we do not convert, so it is left out.
 */
export type PowerKind = 'fast' | 'fly' | 'sneaky' | 'health'

/** 1 facing right, -1 facing left, matching `(direction)` in the scripts. */
export type Facing = 1 | -1

/** One movement axis: the `xm` and `ym` the original's mover takes. */
export type Axis = -1 | 0 | 1

/** Builds an axis from two held keys without the caller reaching for a cast. */
export function axis(negative: boolean, positive: boolean): Axis {
  if (negative === positive) return 0
  return positive ? 1 : -1
}

/**
 * The input triple a tick is driven with.
 *
 * `lisp/input.lsp get_local_input` builds `'(xv yv B1 B2 B3 mx my)` and
 * `cop_mover` reads bit 0 of the button mask as the special. Only the special
 * bit matters here; firing is the torso's business.
 */
export interface PowerInput {
  /** -1 left, 0 neither, 1 right. */
  readonly xm: Axis
  /** -1 up, 0 neither, 1 down. */
  readonly ym: Axis
  /** True while the special button is down - bit 0 of `but`. */
  readonly special: boolean
}

/**
 * What a power is allowed to do to the cop.
 *
 * The required members are the ones every port needs; the optional ones are
 * capabilities this engine does not have yet (there is no CLOUD character in
 * `chars.json`, and nothing implements ladders), so a power degrades quietly
 * instead of the integration having to stub them.
 */
export interface PowerHost {
  /** Anchor column, in world pixels. */
  x: number
  /** Feet, in world pixels. */
  y: number
  /** Vertical velocity in px/tick, positive downwards. */
  vy: number
  /** Which way the legs face. */
  readonly facing: Facing
  /** Height of the leg frame being drawn, for pinning a ghost torso to it. */
  readonly legHeight: number
  /** Name of the leg animation state, e.g. `running`. */
  readonly legState: string

  /**
   * Runs one complete movement step: the same work the tick would do on its
   * own, physics and animation included.
   *
   * FAST calls this an extra time per tick, which is literally how the
   * original doubles the cop's speed - `do_special_power` runs a whole second
   * `player_move` before `cop_mover` runs the usual one.
   */
  step(input: PowerInput): void

  /** Forces a leg animation state, as FLY does every tick it is held. */
  setLegState(state: string): void

  /**
   * Burns ticks off the weapon's cooldown. The original reaches into the
   * torso and decrements `fire_delay1` directly.
   */
  coolWeapon?(ticks: number): void

  /** Spawns FLY's exhaust puff at a world position. */
  spawnCloud?(x: number, y: number): void

  /**
   * FLY thrums every tick it is held and FAST chirps every sixteenth
   * (src/cop.cpp:471, :475). Optional, so a host with no audio still flies.
   */
  playSound?(name: 'FLY_SND' | 'SPEED_SND'): void

  /** `(game_tick)`, for the cadence FAST's sound is counted on. */
  readonly tick?: number

  /**
   * Runs `body` with ladder state held across it.
   *
   * `do_special_power` saves `in_climbing_area` around FAST's extra step and
   * writes it back afterwards, because the ladder re-asserts that variable
   * once per tick and a second mover call would consume it. Nothing climbs in
   * this engine yet, so the default is to just run the step.
   */
  withClimbPreserved?<T>(body: () => T): T
}

/** How the cop's own sprite should be painted this tick. */
export type BodyDraw =
  | { readonly mode: 'solid' }
  | { readonly mode: 'transparent'; readonly alpha: number }
  | { readonly mode: 'predator' }

/** A trailing copy of the cop, as FAST paints behind him. */
export interface Ghost {
  readonly x: number
  readonly y: number
  /** Sprite alpha, 0..1. */
  readonly alpha: number
  /** Where the torso goes for this ghost, or null when the legs hide it. */
  readonly torso: { readonly x: number; readonly y: number } | null
}

/**
 * Everything the draw pass needs from the power, as data. Nothing here touches
 * Pixi, so the same description drives the world sprites and the HUD.
 */
export interface PowerVisuals {
  readonly body: BodyDraw
  readonly ghosts: readonly Ghost[]
  /**
   * Key into `images.json` for the corner icon, or null when no power is held.
   * `bottom_draw` puts it at `(view_x2 - 20, view_y1 + 5)`.
   */
  readonly hudImage: string | null
}

/** What a power with nothing to say looks like. */
export const PLAIN_VISUALS: PowerVisuals = { body: { mode: 'solid' }, ghosts: [], hudImage: null }

/**
 * One special power.
 *
 * All three hooks are optional because the four powers genuinely differ in
 * shape: HEALTH has no per-tick behaviour at all, SNEAKY has no effect on
 * motion, and only FAST draws anything extra.
 */
export interface PowerEffect {
  readonly kind: PowerKind
  /** Corner icon key, from `art/misc.spe`. */
  readonly hudImage: string
  /** Health ceiling while this power is held - see `give_player_health`. */
  readonly healthCap: number

  /** Runs on every tick the special button is down, before the movement step. */
  hold?(host: PowerHost, input: PowerInput): void
  /** Runs on every tick the special button is up. */
  release?(): void
  /** How the cop draws this tick. */
  visuals?(host: PowerHost): PowerVisuals
  /**
   * How well hidden the cop is, 0..1. Only SNEAKY has an opinion; it is what
   * enemy sight checks should consult.
   */
  concealment?(): number
  /**
   * The prefix the leg animations take while this power is held: DARNEL ships
   * `fast_running` and `fly_running` sets alongside the plain ones.
   */
  readonly legPrefix?: string
}

/**
 * The two conversions that turn Abuse's numbers into this game's, plus the
 * handful of constants every creature in here shares.
 *
 * Abuse's monster tables are all in "units per engine tick" - run_top_speed 7,
 * jump_yvel -4, fire_delay 20. None of that transfers unless the tick rates
 * match, and they do not.
 */

/**
 * One of our ticks is a quarter of one of the original's.
 *
 * The original's engine steps its logic at 15Hz (`physics_update = 1000/15`,
 * src/sdlport/setup.cpp:119) and every number in its tables is per one of those
 * ticks. We step at 60Hz, so a quarter of each per-tick figure lands the same
 * distance in the same wall-clock time: an ant's `run_top_speed 7` is 105 px/s
 * either way, and a 20-tick delay is 1.33s either way. Motion comes out
 * smoother than the original's, because it is integrated four times per
 * original tick rather than once, but nothing moves or waits any faster.
 *
 * This was 2/3, back-derived from the cop's hand-tuned 6.0px per 60Hz tick
 * against his `run_top_speed 9`. That kept the monsters in proportion to *that
 * cop*, but it made the whole game - creatures, bullets, delays, animation -
 * run 2.67x the original's pace.
 *
 * Durations go the other way: a wait of N original ticks is 4N of ours.
 */
export const TICK_SCALE = 1 / 4

/** An original velocity (pixels per original tick) in pixels per our tick. */
export const speed = (original: number): number => original * TICK_SCALE

/**
 * An original acceleration - anything the scripts add to a velocity once per
 * tick, such as `(set_yvel (+ (yvel) 1))` - in our units. Accelerations carry
 * the scale twice, once for the velocity and once for the tick.
 */
export const accel = (original: number): number => original * TICK_SCALE * TICK_SCALE

/** A count of original ticks as a count of ours. */
export const ticks = (original: number): number => Math.round(original / TICK_SCALE)

/**
 * Downward acceleration for anything with gravity on.
 *
 * The original turns gravity on with `(set_gravity 1)` and adds that 1 to yvel
 * every tick, which is 225 px/s^2. Everything falls at this now, the cop
 * included, so nothing falls visibly faster than the thing beside it.
 */
export const GRAVITY = accel(1)

/**
 * A cap on falling speed. The original has none - `tick` just keeps adding
 * gravity - so this is only here to stop a long drop stepping further in one
 * tick than the collision sweep can resolve. Set well above anything a shipped
 * level can reach, so it never decides how the game plays.
 */
export const MAX_FALL = speed(48)

/**
 * Difficulty-selected values, on `hard`.
 *
 * startup.lsp line 20 falls back to `hard` when there is no hardness.lsp to
 * load, and there is not one here, so `hard` is the shipped default and the
 * only column this port needs.
 */
export const DIFFICULTY = {
  /** alien_wait_time in lisp/ant.lsp: ticks held in pounce_wait. */
  pounceWaitTicks: ticks(2),
  /** strait_rocket_ai in lisp/ant.lsp: the flyer round's speed. */
  straitRocketSpeed: speed(17),
  /** ant_damage in lisp/ant.lsp: 1 in N takes the ammo upgrade branch. */
  ammoDropDivisor: 8,
} as const

/** `(eq (random n) 0)` - the shape most of the AI's coin flips take. */
export const oneIn = (n: number): boolean => Math.floor(Math.random() * n) === 0

/** `(random n)` - a whole number in [0, n). */
export const random = (n: number): number => Math.floor(Math.random() * n)

/** 1 or -1, whichever points from `from` towards `to`. */
export const towards = (from: number, to: number): 1 | -1 => (to < from ? -1 : 1)

/**
 * The two conversions that turn Abuse's numbers into this game's, plus the
 * handful of constants every creature in here shares.
 *
 * Abuse's monster tables are all in "units per engine tick" - run_top_speed 7,
 * jump_yvel -4, fire_delay 20. None of that transfers unless the tick rates
 * match, and they do not.
 */

/**
 * One tick of ours is two thirds of one of the original's.
 *
 * Derived rather than guessed. The cop's own abilities are run_top_speed 9 and
 * jump_yvel -15 (lisp/people.lsp, def_char DARNEL); Player.ts runs him at
 * 6.0px per 60Hz tick. 6/9 is the factor that was chosen there, and every
 * monster velocity is quoted in the same units as that 9, so applying the same
 * factor keeps an ant's 7 in the right relation to the cop it is chasing.
 *
 * Durations go the other way: a wait of N original ticks is N * 3/2 of ours.
 */
const TICK_SCALE = 2 / 3

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
 * each tick, which converts to 0.44 here. Player.ts falls the cop at 0.55,
 * hand-tuned for feel, and a monster that falls visibly slower than the player
 * standing next to it reads as broken - so the port shares the cop's figure
 * rather than the derived one.
 */
export const GRAVITY = 0.55

/** Terminal velocity, matching the cop's in Player.ts. */
export const MAX_FALL = 12

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

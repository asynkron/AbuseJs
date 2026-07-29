import type { FlashOptions } from './lights'
import type { MoteSink } from './motes'
import { random } from './random'

/**
 * The light and the particles that go over an explosion's sprites.
 *
 * Abuse draws a blast as an animation and, for some of them, one flat
 * `EXP_LIGHT` that is on for five ticks and then gone. Every fireball in the
 * game therefore lights the room identically, and seven of the eleven light it
 * not at all - a JUGGER dies with nothing but a sound.
 *
 * This is one table of five sizes, so each blast site gains a single line and
 * the difference between a boulder and a hidden wall is a word rather than a
 * pile of tuned constants at the call site.
 *
 * `EXP_LIGHT`'s own figures - radius 100, five ticks - are what `medium` was
 * first built from, and they turned out to be nothing you notice: the fireball
 * sprite is already the brightest thing on screen, so a light of about its own
 * size under it reads as no change at all. The rows are scaled up from there
 * until the room visibly lights, and every number in them is invented.
 *
 * Deliberately absent: a shockwave ring. A expanding circle is not in Abuse's
 * visual language and would read instantly as a modern effect pasted over 1995
 * art. What sells the shove instead is the hold-then-fall on the light and the
 * radial ember spray - both of which are here.
 */

/** How much of an explosion this is. */
export type BlastSize = 'chip' | 'small' | 'medium' | 'large' | 'huge'

interface BlastRecipe {
  readonly outer: number
  readonly ticks: number
  readonly hold: number
  readonly peak: number
  readonly tint: number
  /** Radius of the white core flash, or 0 for none. */
  readonly core: number
  readonly embers: number
  readonly emberSpeed: number
  readonly smoke: number
  readonly debris: number
}

const RECIPES: Record<BlastSize, BlastRecipe> = {
  chip:   { outer: 40,  ticks: 2,  hold: 0, peak: 0.6, tint: 0xffd090, core: 0,   embers: 8,   emberSpeed: 4,   smoke: 1,  debris: 3 },
  small:  { outer: 80,  ticks: 4,  hold: 1, peak: 0.9, tint: 0xffc070, core: 34,  embers: 22,  emberSpeed: 5,   smoke: 4,  debris: 6 },
  medium: { outer: 130, ticks: 6,  hold: 2, peak: 1,   tint: 0xffb060, core: 55,  embers: 44,  emberSpeed: 6.5, smoke: 9,  debris: 11 },
  large:  { outer: 175, ticks: 8,  hold: 2, peak: 1,   tint: 0xffa850, core: 75,  embers: 66,  emberSpeed: 8,   smoke: 15, debris: 17 },
  huge:   { outer: 235, ticks: 11, hold: 3, peak: 1,   tint: 0xffa040, core: 100, embers: 95,  emberSpeed: 10,  smoke: 22, debris: 26 },
}

/** Anything a particular blast wants to say differently from its size. */
export interface BlastGlow {
  /** Overrides the recipe's warm orange - white for a disc, violet for the ray. */
  tint?: number
  /** Scales the ember count. 0 for rock, which does not burn. */
  embers?: number
  /** Ember colours. Defaults to the fire ramp. */
  emberColour?: number
  emberFade?: number
  /** Debris colour. Defaults to a dark ash. */
  debrisColour?: number
  /** Debris bounces off the level rather than sailing through it. */
  debrisCollides?: boolean
  /** Scales the smoke count. */
  smoke?: number
  /** Suppresses the light entirely - for a second blast on a body already lit. */
  noLight?: boolean
  /** Engine ticks before the flash appears, for a staged demolition. */
  delay?: number
}

/** Whatever can take a flash. `ExplosionLights` and the projectile host both do. */
export interface FlashSink {
  add(x: number, y: number, outer: number, options?: FlashOptions): void
}

/**
 * Ember colours, and they are deliberately not white.
 *
 * These draw additively, so anything near white comes out *as* white against
 * Abuse's dark art and the spray reads as confetti rather than as something
 * thrown out of a fire. Starting well into orange and falling to a deep red
 * keeps them hot without ever reaching the top of any channel.
 */
const FIRE_HOT = 0xffc040
const FIRE_COOL = 0x901000
const ASH = 0x4a4038
const SMOKE_NEAR = 0x8e8e8e
const SMOKE_FAR = 0x2f2f2f

export function applyBlastGlow(
  lights: FlashSink | null,
  motes: MoteSink | null,
  x: number,
  y: number,
  size: BlastSize,
  glow: BlastGlow = {},
): void {
  const recipe = RECIPES[size]

  if (lights && !glow.noLight) {
    lights.add(x, y, recipe.outer, {
      ticks: recipe.ticks,
      hold: recipe.hold,
      peak: recipe.peak,
      tint: glow.tint ?? recipe.tint,
      delay: glow.delay,
    })
    // A second, much smaller flash on top, white and gone in two ticks. The
    // wide warm one alone reads as the room brightening; this is the part that
    // reads as a detonation, and keeping the two apart is what lets the first
    // one linger without the whole thing looking like a lamp switching on.
    if (recipe.core > 0) {
      lights.add(x, y, recipe.core, {
        ticks: 2,
        hold: 1,
        peak: 1,
        tint: 0xffffff,
        delay: glow.delay,
      })
    }
  }

  if (!motes) return

  const embers = Math.round(recipe.embers * (glow.embers ?? 1))
  if (embers > 0) {
    // Straight up and 90 degrees either way is the whole circle, which is what
    // a blast throws - the cone form is for the directional emitters.
    //
    // Nearly no drag and real gravity: an ember has to travel far enough to
    // be followed and then arc down. Held back, they read as a sparkle over
    // the fireball rather than as debris thrown out of it.
    motes.burst(embers, x, y, 90, 180, recipe.emberSpeed, recipe.emberSpeed * 0.6, {
      life: 30 + random(40),
      gravity: 0.25,
      drag: 0.995,
      colour: glow.emberColour ?? FIRE_HOT,
      fadeTo: glow.emberFade ?? FIRE_COOL,
      size: 2,
      sizeTo: 1,
      blend: 'add',
    })
  }

  const smoke = Math.round(recipe.smoke * (glow.smoke ?? 1))
  if (smoke > 0) {
    motes.burst(smoke, x, y, 90, 110, 1.8, 1.1, {
      life: 70 + random(60),
      // Smoke rises, so the pull on it is upward and very slight.
      gravity: -0.012,
      drag: 0.95,
      colour: SMOKE_NEAR,
      fadeTo: SMOKE_FAR,
      size: 4,
      sizeTo: 16,
      alpha: 0.5,
      blend: 'normal',
    })
  }

  if (recipe.debris > 0) {
    // Debris bounces off the level by default. It is the one class here with
    // any weight to it, and something that sails through a floor reads as a
    // particle effect rather than as wreckage.
    motes.burst(recipe.debris, x, y, 90, 180, recipe.emberSpeed * 0.8, recipe.emberSpeed * 0.5, {
      life: 50 + random(50),
      gravity: 0.3,
      drag: 0.995,
      colour: glow.debrisColour ?? ASH,
      size: 2,
      alpha: 1,
      alphaTo: 1,
      collide: glow.debrisCollides ?? true,
      blend: 'normal',
    })
  }
}

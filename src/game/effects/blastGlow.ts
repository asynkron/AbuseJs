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
 * The `medium` row is the fidelity anchor: `outer` 100 and 5 ticks are
 * `EXP_LIGHT`'s own radius and `explo_light`'s own count, so the ordinary
 * `do_explo` still lights the room exactly as far as the original does and
 * gains only the falloff and a warm tint. Every other row is scaled from it
 * and invented.
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
  readonly embers: number
  readonly emberSpeed: number
  readonly smoke: number
  readonly debris: number
}

const RECIPES: Record<BlastSize, BlastRecipe> = {
  chip: { outer: 30, ticks: 2, hold: 0, peak: 0.5, tint: 0xffd090, embers: 4, emberSpeed: 2, smoke: 0, debris: 2 },
  small: { outer: 60, ticks: 3, hold: 0, peak: 0.8, tint: 0xffc070, embers: 10, emberSpeed: 2.5, smoke: 2, debris: 3 },
  medium: { outer: 100, ticks: 5, hold: 1, peak: 1, tint: 0xffb060, embers: 18, emberSpeed: 3.2, smoke: 4, debris: 5 },
  large: { outer: 140, ticks: 7, hold: 1, peak: 1, tint: 0xffa850, embers: 28, emberSpeed: 4, smoke: 7, debris: 8 },
  huge: { outer: 190, ticks: 9, hold: 2, peak: 1, tint: 0xffa040, embers: 40, emberSpeed: 5, smoke: 11, debris: 12 },
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

const FIRE_HOT = 0xfff0a0
const FIRE_COOL = 0xff5000
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
  }

  if (!motes) return

  const embers = Math.round(recipe.embers * (glow.embers ?? 1))
  if (embers > 0) {
    // Straight up and 90 degrees either way is the whole circle, which is what
    // a blast throws - the cone form is for the directional emitters.
    motes.burst(embers, x, y, 90, 180, recipe.emberSpeed, recipe.emberSpeed * 0.6, {
      life: 10 + random(14),
      gravity: 0.08,
      drag: 0.94,
      colour: glow.emberColour ?? FIRE_HOT,
      fadeTo: glow.emberFade ?? FIRE_COOL,
      size: 2,
      sizeTo: 1,
      blend: 'add',
    })
  }

  const smoke = Math.round(recipe.smoke * (glow.smoke ?? 1))
  if (smoke > 0) {
    motes.burst(smoke, x, y, 90, 90, 1.1, 0.7, {
      life: 40 + random(30),
      // Smoke rises, so the pull on it is upward and very slight.
      gravity: -0.012,
      drag: 0.93,
      colour: SMOKE_NEAR,
      fadeTo: SMOKE_FAR,
      size: 3,
      sizeTo: 9,
      alpha: 0.4,
      blend: 'normal',
    })
  }

  if (recipe.debris > 0) {
    motes.burst(recipe.debris, x, y, 90, 180, recipe.emberSpeed * 0.8, recipe.emberSpeed * 0.5, {
      life: 25 + random(25),
      gravity: 0.22,
      drag: 0.99,
      colour: glow.debrisColour ?? ASH,
      size: 2,
      alpha: 1,
      alphaTo: 1,
      collide: glow.debrisCollides ?? false,
      blend: 'normal',
    })
  }
}

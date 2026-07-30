import type { FlareKind } from './flares'
import type { FlashOptions } from './lights'
import type { MoteSink } from './motes'
import { SIM_TICKS_PER_TICK } from './clock'
import { random } from './random'
import type { PuffKind } from './sprites'

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
  /**
   * Which ramp the additive glow burns through. Defaults to `fire`; pass
   * `shock` for anything electrical and `white` for a blast with no heat in it.
   */
  flare?: FlareKind
  /** Suppresses the additive glow on its own, independently of `noLight`. */
  noFlare?: boolean
}

/** Whatever can take a flash. `ExplosionLights` and the projectile host both do. */
export interface FlashSink {
  add(x: number, y: number, outer: number, options?: FlashOptions): void
}

/** Whatever can take an additive glow. `Flares` does. */
export interface FlareSink {
  add(x: number, y: number, radius: number, kind: FlareKind, life: number, peak?: number): void
}

/** Whatever can spawn the authored one-shot sprites. `Particles` does. */
export interface PuffSink {
  spawn(kind: PuffKind, x: number, y: number, delay?: number, fade?: number): void
}

/**
 * The three places a blast writes to. One object rather than three positional
 * arguments, because two of the three are optional at some call sites and
 * trailing positionals are how the light lifetime went missing once already.
 */
export interface BlastSinks {
  readonly lights: FlashSink | null
  readonly motes: MoteSink | null
  readonly puffs: PuffSink | null
  readonly flares?: FlareSink | null
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

/** `set_fade_count` on the 0..15 scale - the same value rocket_ai's trail uses. */
const SMOKE_FADE = 9

/**
 * How far past the light's own radius the glow reaches.
 *
 * Above 1 because the light is sized to brighten a room and the glow is sized
 * to be seen - at exactly the light's radius the two edges coincide and the
 * result reads as one flat disc rather than a hot centre in a wash.
 */
const FLARE_REACH = 1.25

export function applyBlastGlow(
  sinks: BlastSinks,
  x: number,
  y: number,
  size: BlastSize,
  glow: BlastGlow = {},
): void {
  const recipe = RECIPES[size]
  const { lights, motes, puffs, flares } = sinks

  // The additive glow, sized off the light rather than the sprite so it reaches
  // past the fireball - which is the whole point of it. Same lifetime as the
  // wide flash, so the two agree instead of one outliving the other.
  if (flares && !glow.noFlare) {
    flares.add(
      x,
      y,
      recipe.outer * FLARE_REACH,
      glow.flare ?? 'fire',
      recipe.ticks * SIM_TICKS_PER_TICK,
      recipe.peak,
    )
  }

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

  const smoke = Math.round(recipe.smoke * (glow.smoke ?? 1))
  if (puffs && smoke > 0) {
    // The game's own cloud art, not a particle.
    //
    // Smoke was motes to begin with, and a mote is a flat square of one
    // colour - fine for an ember two pixels across, and a large grey block at
    // any size worth calling smoke. `SMALL_DARK_CLOUD` is `art/cloud.spe`'s
    // smo2, which is what a hit flyer trails and what the rocket lays behind
    // it, so this is the shape the rest of the game's smoke already has.
    // Scattered and staggered, because they do not move once placed and
    // arriving all at once reads as one shape rather than as a cloud growing.
    for (let i = 0; i < smoke; i++) {
      puffs.spawn(
        'SMALL_DARK_CLOUD',
        x + random(recipe.outer / 2) - recipe.outer / 4,
        y + random(recipe.outer / 3) - recipe.outer / 4,
        random(5),
        SMOKE_FADE,
      )
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

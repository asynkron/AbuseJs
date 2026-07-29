import type { RenderLight } from '../../assets/types'
import type { Projectile, ProjectileKind } from './Projectile'

/**
 * The light the weapons throw.
 *
 * All of it is invented. Abuse lights exactly two things: `EXP_LIGHT`, the
 * five-tick flash an explosion adds, and the addon's `QUICK_EXP_LIGHT`. A
 * plasma bolt crosses two hundred pixels of dark corridor and lights none of
 * it; nothing has a muzzle flash; a rocket flies through a black room without
 * casting anything.
 *
 * Two kinds of light, and keeping them apart is the whole design.
 *
 * A muzzle flash is an *event*: it happens at a point, the thing that caused
 * it is gone a frame later, and it belongs in `ExplosionLights` with the rest
 * of the timed flashes. Those go out through `ProjectileHost.addLight`.
 *
 * A rocket's nozzle or a plasma beam is *attached*: it belongs to something
 * alive and moving, and it has to be rebuilt from that object every frame.
 * Registering it as a timed flash does not work. A rocket at full speed covers
 * fourteen pixels a sim tick, so a flash placed at its position is fifty-six
 * pixels behind it by the time the effects clock next ticks; and re-adding a
 * one-tick flash at 60 Hz against a lifetime counted at 15 Hz stacks four of
 * them and comes out four times too bright. So this class holds no state
 * between frames at all: `collect` walks the live projectiles during the draw
 * pass, where the interpolated position has already been worked out, and
 * refills one pooled array.
 */

/** Pixels between the point lights strung along a beam. Invented. */
const BEAM_STEP = 48
/** However long the beam, never more than this many lights on it. */
const BEAM_MAX = 5

/**
 * Only the freshest ticks of a beam throw light.
 *
 * The plasma gun's fire delay is 2 and projectiles tick at 60 Hz, so it fires
 * thirty times a second and each decal lives six engine ticks - a dozen
 * overlapping beams, sixty lights, from one weapon held down. Past two ticks
 * the beam itself is down to two thirds and the light is not what the eye is
 * on, so this is where it gets cut.
 */
const BEAM_LIT_TICKS = 2

/**
 * Hard ceiling on the lights this contributes in one frame.
 *
 * The cost in the light layer is fill rate - one additive quad per visible
 * light, scaling with the square of the zoom - so the honest guard is a cap
 * rather than a count of sources. Filled in priority order: muzzle flashes
 * first, then the lights that travel with something, then beam segments, which
 * are what gets dropped.
 */
const MAX_GLOW_LIGHTS = 40

/** `pgun_draw`'s own fade: the beam's colour ramps down by this per tick. */
const PLASMA_FADE_STEP = 40

interface GlowSpec {
  readonly outer: number
  readonly tint: number
  readonly peak: number
}

/** The light a projectile carries with it while it is in the air. */
const TRAVELLING: Partial<Record<ProjectileKind, GlowSpec>> = {
  rocket: { outer: 46, tint: 0xffb060, peak: 0.85 },
  straitRocket: { outer: 34, tint: 0xffa060, peak: 0.6 },
  firebomb: { outer: 52, tint: 0xff8030, peak: 0.9 },
  disc: { outer: 30, tint: 0xffffff, peak: 0.5 },
  deathRay: { outer: 44, tint: 0xd2aaff, peak: 0.9 },
  // A tracer is small and there are thirty a second of them; big enough to
  // show the round travelling, small enough not to wash the room out.
  machineGun: { outer: 22, tint: 0xffe8a0, peak: 0.45 },
}

/** The beam weapons, lit along the segment rather than at a point. */
const BEAMS: Partial<Record<ProjectileKind, GlowSpec>> = {
  plasma: { outer: 56, tint: 0xc060ff, peak: 1 },
  lightSabre: { outer: 40, tint: 0x939bc3, peak: 0.8 },
}

/**
 * The muzzle flash per weapon slot, by the projectile the slot fires.
 *
 * The tints are the weapons' own where the original has one to borrow:
 * `pgun_draw` builds its beam from (c, c/2, c) which is violet, and
 * `lsaber_draw` is a literal rgb(147, 155, 195). The rest are chosen.
 */
export const MUZZLE: Partial<Record<ProjectileKind, GlowSpec & { ticks: number }>> = {
  machineGun: { outer: 30, tint: 0xffe8a0, peak: 0.7, ticks: 1 },
  rocket: { outer: 60, tint: 0xffb060, peak: 1, ticks: 2 },
  plasma: { outer: 45, tint: 0xc060ff, peak: 0.9, ticks: 2 },
  lightSabre: { outer: 40, tint: 0x939bc3, peak: 0.8, ticks: 1 },
  disc: { outer: 25, tint: 0xffffff, peak: 0.5, ticks: 1 },
  deathRay: { outer: 70, tint: 0xd2aaff, peak: 1, ticks: 2 },
  straitRocket: { outer: 24, tint: 0xffe8a0, peak: 0.55, ticks: 1 },
  // Thrown, not fired. Nothing lights at the hand.
}

interface MutableLight {
  x: number
  y: number
  inner: number
  outer: number
  type: number
  xshift: number
  yshift: number
  intensity: number
  tint: number
}

export class WeaponGlow {
  private readonly pool: MutableLight[] = []
  private readonly live: MutableLight[] = []

  /**
   * Rebuilds this frame's list from the live projectiles. `at` is the
   * interpolated position the caller has already computed for drawing.
   */
  begin(): void {
    this.live.length = 0
  }

  /** Whatever light this projectile is throwing right now, at (x, y). */
  collect(projectile: Projectile, x: number, y: number): void {
    const travelling = TRAVELLING[projectile.kind]
    if (travelling) {
      this.add(x, y, travelling.outer, travelling.tint, travelling.peak)
      return
    }

    const beam = BEAMS[projectile.kind]
    if (!beam || projectile.age > BEAM_LIT_TICKS) return
    if (projectile.kind !== 'plasma' && projectile.kind !== 'lightSabre') return

    // The light dies with the pixels rather than on a curve of its own: this
    // is `pgun_draw`'s own ramp, and the sabre borrows it.
    const fade = Math.max(0, 255 - projectile.age * PLASMA_FADE_STEP) / 255
    this.strip(projectile.fromX, projectile.fromY, x, y, beam, fade)
  }

  /** This frame's lights. Valid until the next `begin`. */
  get lights(): readonly RenderLight[] {
    return this.live
  }

  /**
   * Point lights stepped along a segment.
   *
   * Not a light shape of its own. `LightLayer` is built entirely around one
   * gradient texture sampled through nine axis-aligned sub-rectangles, culled
   * as rectangles; an oriented capsule needs a rotation, a second gradient on
   * a different falloff and a rotated-bounds cull, which is a rewrite of the
   * layer for the sake of two weapons. Spaced at two thirds of their own
   * radius, the points overlap enough to read as a tube rather than as beads.
   */
  private strip(x0: number, y0: number, x1: number, y1: number, spec: GlowSpec, fade: number): void {
    const length = Math.hypot(x1 - x0, y1 - y0)
    const count = Math.min(BEAM_MAX, Math.max(1, Math.round(length / BEAM_STEP) + 1))
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1)
      this.add(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, spec.outer, spec.tint, spec.peak * fade)
    }
  }

  private add(x: number, y: number, outer: number, tint: number, intensity: number): void {
    if (this.live.length >= MAX_GLOW_LIGHTS) return

    const light = this.pool[this.live.length] ?? {
      x: 0,
      y: 0,
      inner: 1,
      outer: 0,
      type: 0,
      xshift: 0,
      yshift: 0,
      intensity: 1,
      tint: 0xffffff,
    }
    this.pool[this.live.length] = light

    light.x = x
    light.y = y
    light.outer = outer
    light.tint = tint
    light.intensity = intensity
    this.live.push(light)
  }
}

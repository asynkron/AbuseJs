import { Container, Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../../assets/loader'
import type { Blood } from './Blood'
import { bounceMove, type MovingBox } from './bounce'
import type { TickClock } from './clock'
import type { BloodProfile } from './gore'
import { random } from './random'
import { placeAnchored, sequenceFrameName } from './sprites'
import type { BlastSource, Terrain } from './types'

/**
 * Body parts.
 *
 * `create_dead_parts` (lisp/ant.lsp) is the game's whole gore budget, and the
 * ants and the cop share it verbatim. Five actors are thrown from the dying
 * body: two distinct parts and three copies of a third, the copies started one,
 * two and three frames into their tumble so they do not move in lockstep - the
 * original's own comment for it is ";; unsync the animations".
 *
 * There is no blood anywhere in Abuse. The red on screen when you are hit is
 * `tint_palette`, a full-screen ramp the player's damage handler drives, and
 * it belongs with the player rather than here.
 *
 * That is still true of the original, and this file now breaks it on purpose.
 * The parts themselves are untouched - same art, same five actors, same
 * unsynced tumble - but a creature that bleeds gets a burst as it comes apart,
 * a dotted trail off each part while it flies, and a mark where each one
 * lands. All three are inventions; see Blood.ts. The point of the first is
 * that the frame where the body is replaced by five cutouts is the ugliest one
 * in the game, and something has to be in front of it.
 */

/** Which set of art a corpse comes apart into. */
export type GibSet = 'ant' | 'cop'

/**
 * `get_dead_part` (lisp/ant.lsp) picks the flavour from the otype of whatever
 * fired the killing shot. The enum has a fourth entry, `decay_part` at index
 * 0, which nothing can select - dead art.
 */
export type GibFlavour = 'flaming' | 'electric' | 'normal'

export function gibFlavourFor(from: BlastSource | null): GibFlavour {
  switch (from?.type) {
    case 'GRENADE':
    case 'ROCKET':
    case 'FIREBOMB':
      return 'flaming'
    case 'PLASMAGUN_BULLET':
    case 'LSABER_BULLET':
      return 'electric'
    default:
      return 'normal'
  }
}

interface GibArt {
  file: string
  /** Three sequence bases per flavour, in the order create_dead_parts spawns them. */
  bases: Record<GibFlavour, readonly [string, string, string]>
}

/**
 * The two part tables, from lisp/ant.lsp:584-588 and lisp/people.lsp:27-31.
 * The cop's source comment labels the triple "head / arm / leg"; the ant's
 * names suggest body / head / leg. Four frames each (make_dead_part).
 */
const GIB_ART: Record<GibSet, GibArt> = {
  ant: {
    file: 'art/ant.spe',
    bases: {
      flaming: ['adaf', 'adah', 'adlf'],
      electric: ['adbe', 'adhe', 'adle'],
      normal: ['adan', 'adhn', 'adln'],
    },
  },
  cop: {
    file: 'art/cop.spe',
    bases: {
      flaming: ['4dhf', '4daf', '4dbf'],
      electric: ['4dae', '4dle', '4dbe'],
      normal: ['4dhn', '4dan', '4dbn'],
    },
  },
}

/** `(seq base 1 4)` in make_dead_part - lisp/ant.lsp. */
const GIB_FRAMES = 4

/** `(set_yvel (+ (yvel) 3))` in head_ai - three times the boulder's fall rate. */
const GIB_GRAVITY = 3

/**
 * Invented. The parts are small and the original collides them with their own
 * picture box; a 4x4 box keeps them landing on the floor rather than hovering
 * a sprite-height above it, and is small enough to fall through the gaps the
 * original's would.
 */
const GIB_HALF_WIDTH = 2
const GIB_HEIGHT = 4

/**
 * Invented safety valve. `head_ai` returns `(or (< (state_time) 15) (not
 * (frame_panic)))`, so with frame panic never set a part lives until it lands
 * - and a part that leaves the map never does. The engine culls objects that
 * fall out of the world; we have no world bounds here, so cap the fall at
 * eight seconds of engine time instead.
 */
const MAX_GIB_TICKS = 120

interface Gib extends MovingBox {
  sprite: Sprite
  frames: Frame[]
  frame: number
  prevX: number
  prevY: number
  ticks: number
  /** Set on the tick it hits the floor; head_ai's aistate 1 returns nil the tick after. */
  landed: boolean
  /** What this part bleeds, cleared once it has left its mark. Invented. */
  bleed: BloodProfile | null
  /** Engine ticks of trail left in it. Invented. */
  trail: number
}

/**
 * Engine ticks a part keeps bleeding after it is thrown.
 *
 * Invented. Eight, not the part's whole life: a gib still pumping four seconds
 * into a fall reads as a leak rather than a wound, and the trail is there to
 * give the eye something to follow through the tumble, which it has stopped
 * needing by then.
 */
const GIB_TRAIL_TICKS = 8

/** Sprites kept for reuse. Five per corpse, and corpses come in batches. */
const POOL_LIMIT = 40

export class DeathEffects {
  readonly container = new Container()

  private readonly live: Gib[] = []
  private readonly pool: Sprite[] = []
  private readonly frames = new Map<string, Frame[]>()

  constructor(
    private readonly assets: GameAssets,
    private readonly terrain: Terrain,
    private readonly clock: TickClock,
    private readonly blood: Blood,
  ) {}

  /**
   * `create_dead_parts`: five parts from (x, y), thrown in the facing
   * direction at 0-9 px/tick and upward at 0-24.
   *
   * `tintIndex` is the aitype the original passes through to the part's draw
   * function - the ant's own colour variant for `ant_draw`, the player number
   * for `dead_cop_part_draw`. Index 0 draws untinted in both.
   */
  createDeadParts(
    x: number,
    y: number,
    direction: number,
    set: GibSet,
    flavour: GibFlavour,
    tintIndex = 0,
    bleed: BloodProfile | null = null,
  ): void {
    // Before the parts, not after: the burst has to be on screen on the same
    // frame the body disappears.
    this.blood.burst(x, y - GIB_HEIGHT, bleed)

    const bases = GIB_ART[set].bases[flavour]
    // Two distinct parts, then the third three times, each started a frame
    // further into its tumble.
    this.spawnPart(x, y, direction, set, bases[0], tintIndex, 0, bleed)
    this.spawnPart(x, y, direction, set, bases[1], tintIndex, 0, bleed)
    this.spawnPart(x, y, direction, set, bases[2], tintIndex, 1, bleed)
    this.spawnPart(x, y, direction, set, bases[2], tintIndex, 2, bleed)
    this.spawnPart(x, y, direction, set, bases[2], tintIndex, 3, bleed)
  }

  /** One engine tick of falling, tumbling and landing - `head_ai` (lisp/ant.lsp). */
  advance(): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const gib = this.live[i]

      // aistate 1 does nothing but return nil, so a part that landed last tick
      // goes now.
      if (gib.landed) {
        this.retire(i)
        continue
      }

      gib.prevX = gib.x
      gib.prevY = gib.y
      gib.frame = (gib.frame + 1) % gib.frames.length
      gib.vy += GIB_GRAVITY

      if (gib.bleed && gib.trail > 0) {
        gib.trail--
        this.blood.trail(gib.x, gib.y - GIB_HEIGHT / 2, gib.vx, gib.vy, gib.bleed)
      }

      const blocked = bounceMove(this.terrain, gib)
      // Only the down stub does anything in the original; left, right and up
      // just bounce.
      if (blocked.down) gib.landed = true

      // head_ai removes the part the tick after it lands, so without this a
      // corpse leaves nothing behind at all. One mark per part, not one per
      // bounce - hence clearing the profile.
      if (gib.bleed && (blocked.down || blocked.up || blocked.left || blocked.right)) {
        const surface = blocked.down ? 'floor' : blocked.up ? 'ceiling' : 'wall'
        this.blood.splat(gib.x, gib.y, surface, gib.bleed)
        gib.bleed = null
      }

      if (++gib.ticks >= MAX_GIB_TICKS) this.retire(i)
    }
  }

  draw(alpha: number): void {
    const t = this.clock.fraction(alpha)
    for (const gib of this.live) {
      const frame = gib.frames[gib.frame]
      if (!frame) continue
      gib.sprite.visible = true
      // create_dead_parts never sets the part's direction, so they always draw
      // facing right however the body was facing.
      placeAnchored(
        gib.sprite,
        frame,
        gib.prevX + (gib.x - gib.prevX) * t,
        gib.prevY + (gib.y - gib.prevY) * t,
      )
    }
  }

  clear(): void {
    while (this.live.length) this.retire(this.live.length - 1)
  }

  get liveCount(): number {
    return this.live.length
  }

  private spawnPart(
    x: number,
    y: number,
    direction: number,
    set: GibSet,
    base: string,
    tintIndex: number,
    startFrame: number,
    bleed: BloodProfile | null,
  ): void {
    const frames = this.framesFor(set, base, tintIndex)
    if (!frames.length) return

    const sprite = this.pool.pop() ?? new Sprite()
    sprite.visible = true
    this.container.addChild(sprite)
    this.live.push({
      sprite,
      frames,
      frame: startFrame % frames.length,
      x,
      y,
      prevX: x,
      prevY: y,
      halfWidth: GIB_HALF_WIDTH,
      height: GIB_HEIGHT,
      vx: direction * random(10),
      vy: -random(25),
      ticks: 0,
      landed: false,
      bleed,
      trail: GIB_TRAIL_TICKS,
    })
  }

  /**
   * Gib frames, tinted to match whoever they came off.
   *
   * `ant_draw` is `(if (eq 0 (aitype)) (draw) (draw_tint (aref ant_tints
   * (aitype))))` and `dead_cop_part_draw` the same with player_tints, so index
   * 0 means untinted in both. The baked variants are in the atlas under
   * `art/ant.spe@3#adan0001.pcx` and the like; anything without one falls back
   * to the plain frame.
   */
  private framesFor(set: GibSet, base: string, tintIndex: number): Frame[] {
    const key = `${set}:${base}:${tintIndex}`
    const cached = this.frames.get(key)
    if (cached) return cached

    const file = GIB_ART[set].file
    const tint = tintIndex > 0 ? tintIndex : undefined
    const frames: Frame[] = []
    for (let i = 1; i <= GIB_FRAMES; i++) {
      const name = sequenceFrameName(base, i)
      const frame = this.assets.frame(file, name, tint) ?? this.assets.frame(file, name)
      if (frame) frames.push(frame)
    }

    this.frames.set(key, frames)
    return frames
  }

  private retire(index: number): void {
    const gib = this.live[index]
    this.live.splice(index, 1)
    this.container.removeChild(gib.sprite)
    gib.sprite.visible = false
    if (this.pool.length < POOL_LIMIT) this.pool.push(gib.sprite)
  }
}

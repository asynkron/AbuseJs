import { Graphics } from 'pixi.js'

import type { LevelObjectData } from '../assets/types'
import type { Level } from './Level'
import { moveAndCollide, type Body } from './collision'

/**
 * The force fields - the thing the blue "FF" markers stand for.
 *
 * `FORCE_FIELD`'s only art is a small `force_field` glyph in `art/misc.spe`,
 * and `ff_draw` in the original's lisp/doors.lsp opens with
 * `(if (edit_mode) (draw))` - the sprite is the editor's marker and is never
 * meant to reach the screen. What you are supposed to see is four scattered
 * vertical lines, drawn straight after:
 *
 *   (ascatter_line (x) (y) (x) end_y (find_rgb 151 139 151) (find_rgb 75 69 75) 3)
 *   (ascatter_line (x) (y) (x) end_y (find_rgb 139 147 191) (find_rgb 69 73 95) 2)
 *   (ascatter_line (x) (y) (x) end_y (find_rgb  39  55  71) (find_rgb 19 27 35) 2)
 *   (ascatter_line (x) (y) (x) end_y (find_rgb  39  55  71) (find_rgb 20 26 35) 2)
 *
 * `end_y` comes from `ff_ai`, which finds the floor with `(try_move 0 (+ (y)
 * 200))` and keeps the result. It also plays FF_SND every fourth tick and
 * shoves the player out with `(ff_push (first_focus) 35)`.
 *
 * Ours draws the same four passes with the same colours and widths, jittered
 * per segment rather than per pixel, and pushes the player clear.
 */

/** How far down `ff_ai` looks for the floor. */
const FLOOR_PROBE = 200
/** Segment height the scatter is quantised to. */
const SEGMENT = 3
/**
 * `(ff_push (first_focus) 35)` - and 35 is a clearance, not a strength.
 *
 * `ff_push` computes `35 - dx` on the right, or `-(35 - |dx|)` on the left, and
 * hands that to `try_move`: one tick puts the player at exactly 35px from the
 * beam, as far as the geometry allows. Nudging 3.2px within 14px instead let a
 * player stand well inside a live field.
 */
const PUSH_CLEARANCE = 35
/** `(<= bgy (+ end_y 20))` - how far past the floor end the band still acts. */
const SPAN_SLACK = 20
/** Ticks between FF_SND, from `(eq (mod (game_tick) 4) 0)`. */
const SOUND_EVERY = 4

/** The four passes, outer to inner, as {from, to, width}. */
const PASSES: readonly { from: number; to: number; width: number }[] = [
  { from: 0x978b97, to: 0x4b454b, width: 3 },
  { from: 0x8b93bf, to: 0x45495f, width: 2 },
  { from: 0x273747, to: 0x131b23, width: 2 },
  { from: 0x273747, to: 0x141a23, width: 2 },
]

export class ForceField {
  readonly x: number
  readonly y: number
  /** Where the beam lands, found once - the level's floors do not move. */
  readonly endY: number
  readonly objectIndex: number

  /** Set by the world each tick from the signal network. */
  active = true

  private phase = 0

  constructor(
    data: LevelObjectData,
    objectIndex: number,
    private readonly level: Level,
  ) {
    this.x = data.x
    this.y = data.y
    this.objectIndex = objectIndex
    this.endY = findFloor(level, data.x, data.y)
  }

  /**
   * Pushes the player away from the beam and reports whether the field wants
   * its sound this tick.
   */
  update(tick: number, player: Body): boolean {
    this.phase++
    if (!this.active) return false

    // `(and (>= bgy (y)) (<= bgy (+ end_y 20)))` - measured at the feet, so a
    // player whose head clips the beam but whose feet are above it is missed,
    // exactly as the original misses them.
    const withinSpan = player.y >= this.y && player.y <= this.endY + SPAN_SLACK
    const dx = player.x - this.x
    if (withinSpan && Math.abs(dx) < PUSH_CLEARANCE) {
      const amount = dx > 0 ? PUSH_CLEARANCE - dx : -(PUSH_CLEARANCE - Math.abs(dx))
      moveAndCollide(this.level, player, amount, 0)
    }

    return tick % SOUND_EVERY === 0
  }

  /** Draws the four passes into a shared Graphics, in world space. */
  draw(g: Graphics): void {
    if (!this.active) return

    for (const pass of PASSES) {
      // `ascatter_line` scatters between two colours along its length; per
      // segment is close enough at this scale and costs a fraction as much.
      for (let y = this.y; y < this.endY; y += SEGMENT) {
        const t = fract(Math.sin((y + this.phase) * 12.9898) * 43758.5453)
        const height = Math.min(SEGMENT, this.endY - y)
        g.rect(this.x - pass.width / 2, y, pass.width, height)
        g.fill({ color: t < 0.5 ? pass.from : pass.to, alpha: 0.85 })
      }
    }
  }
}

function fract(value: number): number {
  return value - Math.floor(value)
}

/** `(try_move 0 (+ (y) 200))` - straight down until something stops it. */
function findFloor(level: Level, x: number, y: number): number {
  const cx = Math.floor(x / level.tileW)
  for (let probe = y; probe < y + FLOOR_PROBE; probe += level.tileH) {
    const cy = Math.floor(probe / level.tileH)
    const span = level.spanInRange(cx, cy, x - 2, x + 2)
    if (span && span.top > y) return span.top
  }
  return y + FLOOR_PROBE
}

/** Builds the force fields, taking their editor markers out of the prop list. */
export function buildForceFields(
  objects: LevelObjectData[],
  props: { data: LevelObjectData }[],
  level: Level,
): ForceField[] {
  const fields: ForceField[] = []

  objects.forEach((object, index) => {
    if (object.type !== 'FORCE_FIELD') return

    fields.push(new ForceField(object, index, level))
    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  return fields
}

/**
 * The line primitives the beam weapons are drawn with.
 *
 * Four of the eight weapons have no real sprite at all - what you see is
 * `draw_line`, `scatter_line` and `ascatter_line` straight into the world:
 * the machine gun's five-line streak, the plasma bolt's fading violet beam,
 * the light sabre's white slash and the death ray's tendrils. ForceField.ts
 * already scatters lines the same way, so the approximation is the one this
 * project has settled on: jitter per short segment rather than per pixel,
 * which reads the same at this scale for a fraction of the cost.
 */

import type { Graphics } from 'pixi.js'

/** Segment length the scatter is quantised to. */
const SEGMENT = 2

export function drawLine(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  colour: number,
  width = 1,
): void {
  g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width, color: colour, alpha: 1 })
}

function jitter(amount: number): number {
  return amount === 0 ? 0 : (Math.random() * 2 - 1) * amount
}

/**
 * `scatter_line (x1 y1 x2 y2 colour amount)` - a line whose points wander by
 * up to `amount` pixels. Amount 0 is a clean line, which is how the plasma
 * bolt gets a solid core inside its halo.
 */
export function scatterLine(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  colour: number,
  amount: number,
): void {
  if (amount === 0) {
    drawLine(g, x1, y1, x2, y2, colour)
    return
  }

  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / SEGMENT))
  let px = x1
  let py = y1
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const nx = x1 + (x2 - x1) * t + jitter(amount)
    const ny = y1 + (y2 - y1) * t + jitter(amount)
    drawLine(g, px, py, nx, ny, colour)
    px = nx
    py = ny
  }
}

/**
 * `ascatter_line (x1 y1 x2 y2 c1 c2 amount)` - the same, alternating between
 * two colours along its length. The force fields use it too (lisp/doors.lsp,
 * ff_draw), so the reading is shared.
 */
export function ascatterLine(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  first: number,
  second: number,
  amount: number,
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / SEGMENT))
  let px = x1
  let py = y1
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const nx = x1 + (x2 - x1) * t + jitter(amount)
    const ny = y1 + (y2 - y1) * t + jitter(amount)
    drawLine(g, px, py, nx, ny, i % 2 === 0 ? second : first)
    px = nx
    py = ny
  }
}

/** `(find_rgb r g b)` - the scripts' colours are plain RGB triples. */
export function rgb(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

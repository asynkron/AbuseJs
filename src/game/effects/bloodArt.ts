import { Rectangle, Texture } from 'pixi.js'

/**
 * The art the blood is drawn from, generated rather than loaded.
 *
 * None of it comes out of Abuse, because Abuse has none of it. A droplet is
 * one white pixel and a mark is one of eight hand-generated masks, all tinted
 * at draw time from the victim's own palette (see gore.ts).
 *
 * The one rule that matters: **every pixel is fully opaque or fully absent**.
 * No anti-aliasing, no gradient, no soft edge. The scene is nearest-neighbour
 * pixel art at an integer zoom under a CRT filter, and a mark with a feathered
 * alpha edge stops looking like part of the game and starts looking like a
 * layer pasted over it. The masks are also never rotated and never scaled by a
 * fraction, for the same reason.
 *
 * Built once for the page rather than per level. LightLayer builds its
 * gradient per instance, but a World is thrown away on every level change and
 * these masks are identical every time; a per-instance copy would either leak
 * or need a teardown path the subsystem does not otherwise have.
 */

/** Cells across and down the mask sheet. Four floor, two ceiling, two wall. */
const COLUMNS = 4
const ROWS = 2
const CELL_W = 32
const CELL_H = 32

/** Which cells are which. `splatFrames` returns them grouped this way. */
export type SplatShape = 'floor' | 'ceiling' | 'wall'

export interface BloodArt {
  /** One white pixel, scaled to a droplet's size at draw time. */
  readonly droplet: Texture
  /** Marks by the surface they stuck to. */
  readonly splats: Record<SplatShape, readonly Texture[]>
}

/**
 * A fixed-seed integer generator.
 *
 * The masks have to come out the same on every run or the same corpse would
 * paint a different wall each time the level reloads, which reads as a bug
 * long before it reads as variety.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** Fills one pixel of the sheet, opaque white. Out-of-cell writes are dropped. */
function plot(
  data: Uint8ClampedArray,
  width: number,
  cellX: number,
  cellY: number,
  x: number,
  y: number,
): void {
  if (x < 0 || y < 0 || x >= CELL_W || y >= CELL_H) return
  const offset = ((cellY * CELL_H + y) * width + (cellX * CELL_W + x)) * 4
  data[offset] = 255
  data[offset + 1] = 255
  data[offset + 2] = 255
  data[offset + 3] = 255
}

/** A flattened blob: wide, shallow, with a ragged edge and a few outliers. */
function drawPuddle(
  data: Uint8ClampedArray,
  width: number,
  cellX: number,
  cellY: number,
  rng: () => number,
): void {
  const cx = CELL_W / 2
  const cy = CELL_H / 2
  const halfW = 3 + Math.floor(rng() * 4)
  const halfH = 1 + Math.floor(rng() * 2)

  for (let x = -halfW; x <= halfW; x++) {
    // A half-ellipse, roughened by up to a pixel either way so the outline is
    // chewed rather than geometric.
    const span = Math.round(halfH * Math.sqrt(Math.max(0, 1 - (x / halfW) ** 2)))
    const jitter = rng() < 0.3 ? 1 : 0
    for (let y = -span - jitter; y <= span + jitter; y++) plot(data, width, cellX, cellY, cx + x, cy + y)
  }

  const speckles = 1 + Math.floor(rng() * 3)
  for (let i = 0; i < speckles; i++) {
    const sx = cx + Math.round((rng() * 2 - 1) * (halfW + 4))
    const sy = cy + Math.round((rng() * 2 - 1) * (halfH + 3))
    plot(data, width, cellX, cellY, sx, sy)
    if (rng() < 0.5) plot(data, width, cellX, cellY, sx + 1, sy)
  }
}

/** A blob on a ceiling with two or three drips hanging off it. */
function drawDrip(
  data: Uint8ClampedArray,
  width: number,
  cellX: number,
  cellY: number,
  rng: () => number,
): void {
  const cx = CELL_W / 2
  const top = CELL_H / 2 - 3
  const halfW = 3 + Math.floor(rng() * 3)

  for (let x = -halfW; x <= halfW; x++) {
    const span = Math.round(1.5 * Math.sqrt(Math.max(0, 1 - (x / halfW) ** 2)))
    for (let y = 0; y <= span; y++) plot(data, width, cellX, cellY, cx + x, top + y)
  }

  const drips = 2 + Math.floor(rng() * 2)
  for (let i = 0; i < drips; i++) {
    const dx = cx + Math.round((rng() * 2 - 1) * halfW)
    const length = 2 + Math.floor(rng() * 4)
    for (let y = 0; y < length; y++) plot(data, width, cellX, cellY, dx, top + 2 + y)
    plot(data, width, cellX, cellY, dx, top + 2 + length)
    plot(data, width, cellX, cellY, dx + 1, top + 2 + length)
  }
}

/** A tall smear on a wall with a run trailing down out of it. */
function drawRun(
  data: Uint8ClampedArray,
  width: number,
  cellX: number,
  cellY: number,
  rng: () => number,
): void {
  const cx = CELL_W / 2
  const cy = CELL_H / 2 - 5
  const halfH = 2 + Math.floor(rng() * 3)

  for (let y = -halfH; y <= halfH; y++) {
    const span = Math.round(2 * Math.sqrt(Math.max(0, 1 - (y / halfH) ** 2)))
    for (let x = -span; x <= span; x++) plot(data, width, cellX, cellY, cx + x, cy + y)
  }

  const length = 4 + Math.floor(rng() * 7)
  for (let y = 0; y < length; y++) {
    plot(data, width, cellX, cellY, cx, cy + halfH + y)
    if (rng() < 0.35) plot(data, width, cellX, cellY, cx + 1, cy + halfH + y)
  }
}

let cached: BloodArt | null = null

export function bloodArt(): BloodArt {
  if (cached) return cached

  const width = COLUMNS * CELL_W
  const height = ROWS * CELL_H
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(width, height)

  const rng = seeded(0x5eed)
  // Row 0 is the four floor puddles; row 1 is two ceiling drips then two wall
  // runs. Cell order is what `splatFrames` slices below.
  for (let i = 0; i < 4; i++) drawPuddle(image.data, width, i, 0, rng)
  for (let i = 0; i < 2; i++) drawDrip(image.data, width, i, 1, rng)
  for (let i = 0; i < 2; i++) drawRun(image.data, width, 2 + i, 1, rng)

  ctx.putImageData(image, 0, 0)

  const sheet = Texture.from(canvas)
  sheet.source.scaleMode = 'nearest'

  const cell = (cx: number, cy: number): Texture =>
    new Texture({
      source: sheet.source,
      frame: new Rectangle(cx * CELL_W, cy * CELL_H, CELL_W, CELL_H),
    })

  const droplet = document.createElement('canvas')
  droplet.width = 1
  droplet.height = 1
  const dctx = droplet.getContext('2d')!
  dctx.fillStyle = '#ffffff'
  dctx.fillRect(0, 0, 1, 1)
  const dropletTexture = Texture.from(droplet)
  dropletTexture.source.scaleMode = 'nearest'

  cached = {
    droplet: dropletTexture,
    splats: {
      floor: [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0)],
      ceiling: [cell(0, 1), cell(1, 1)],
      wall: [cell(2, 1), cell(3, 1)],
    },
  }
  return cached
}

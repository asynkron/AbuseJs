import type { GameAssets } from '../assets/loader'
import type { LevelData, LevelObjectData, TileMeta } from '../assets/types'

/** Tile id bits, straight from the original fgmap encoding. */
const TILE_MASK = 0x3fff
/** Drawn after entities, as a foreground overlay. */
const ABOVE_FLAG = 0x4000

function decodeCells(base64: string): Uint16Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
}

export interface SolidBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * A loaded level: two tile grids plus the object list.
 *
 * Foreground cells are the collision world. A tile is solid exactly when the
 * original art carried a collision outline (see tools/convert.ts); we use that
 * outline's bounding box, so slopes currently behave as full blocks.
 */
export class Level {
  readonly fgWidth: number
  readonly fgHeight: number
  readonly bgWidth: number
  readonly bgHeight: number
  readonly fgCells: Uint16Array
  readonly bgCells: Uint16Array
  readonly objects: LevelObjectData[]

  readonly tileW: number
  readonly tileH: number
  readonly backW: number
  readonly backH: number

  /** Per-tile-id collision box, or null when the tile is passable. */
  private readonly solidBoxes: (SolidBox | null)[] = []
  /** Per-tile-id column spans, for ramps. Undefined means "use the box". */
  private readonly solidColumns: (([number, number] | null)[] | undefined)[] = []

  constructor(
    readonly data: LevelData,
    assets: GameAssets,
  ) {
    this.fgWidth = data.fg.w
    this.fgHeight = data.fg.h
    this.bgWidth = data.bg.w
    this.bgHeight = data.bg.h
    this.fgCells = decodeCells(data.fg.cells)
    this.bgCells = decodeCells(data.bg.cells)
    this.objects = data.objects

    const fore = assets.tileSet('fore')
    const back = assets.tileSet('back')
    this.tileW = fore.cellW
    this.tileH = fore.cellH
    this.backW = back.cellW
    this.backH = back.cellH

    for (const [id, meta] of Object.entries(fore.tiles) as [string, TileMeta][]) {
      const index = Number(id)
      this.solidBoxes[index] = meta.bb
        ? { x0: meta.bb[0], y0: meta.bb[1], x1: meta.bb[2], y1: meta.bb[3] }
        : null
      this.solidColumns[index] = meta.cols
    }
  }

  get widthPx(): number {
    return this.fgWidth * this.tileW
  }

  get heightPx(): number {
    return this.fgHeight * this.tileH
  }

  get name(): string {
    return this.data.firstName
  }

  get bgScroll() {
    return this.data.bgScroll
  }

  get lighting() {
    return this.data.lighting ?? { minLight: 63, lights: [] }
  }

  /** Per object, the indices of the objects it is wired to. */
  get links(): number[][] {
    return this.data.links ?? []
  }

  /** Raw foreground cell, flags included. Out of bounds reads as solid rock. */
  fgCell(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.fgWidth || cy >= this.fgHeight) return -1
    return this.fgCells[cy * this.fgWidth + cx]
  }

  fgTile(cx: number, cy: number): number {
    const cell = this.fgCell(cx, cy)
    return cell < 0 ? -1 : cell & TILE_MASK
  }

  isAbove(cx: number, cy: number): boolean {
    const cell = this.fgCell(cx, cy)
    return cell > 0 && (cell & ABOVE_FLAG) !== 0
  }

  bgTile(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.bgWidth || cy >= this.bgHeight) return -1
    return this.bgCells[cy * this.bgWidth + cx]
  }

  /**
   * Collision box of a cell in world pixels, or null when nothing blocks.
   * Cells outside the map block, so nothing can walk off the edge.
   */
  solidAt(cx: number, cy: number): SolidBox | null {
    if (cx < 0 || cy < 0 || cx >= this.fgWidth || cy >= this.fgHeight) {
      return { x0: cx * this.tileW, y0: cy * this.tileH, x1: (cx + 1) * this.tileW, y1: (cy + 1) * this.tileH }
    }
    const tile = this.fgCells[cy * this.fgWidth + cx] & TILE_MASK
    const box = this.solidBoxes[tile]
    if (!box) return null
    return {
      x0: cx * this.tileW + box.x0,
      y0: cy * this.tileH + box.y0,
      x1: cx * this.tileW + box.x1,
      y1: cy * this.tileH + box.y1,
    }
  }

  /**
   * The solid vertical span of one cell, restricted to the world-x range
   * `[xFrom, xTo)`, in world coordinates. Null when nothing there blocks.
   *
   * Shaped tiles (ramps) carry a solid span per pixel column; this collapses
   * the columns the body actually overlaps into the highest top and lowest
   * bottom, which is what a swept AABB needs. Flat tiles skip the loop.
   */
  spanInRange(cx: number, cy: number, xFrom: number, xTo: number): { top: number; bottom: number } | null {
    if (cx < 0 || cy < 0 || cx >= this.fgWidth || cy >= this.fgHeight) {
      // Outside the map is solid, so nothing walks off the edge.
      return { top: cy * this.tileH, bottom: (cy + 1) * this.tileH }
    }

    const tile = this.fgCells[cy * this.fgWidth + cx] & TILE_MASK
    const box = this.solidBoxes[tile]
    if (!box) return null

    const cellX = cx * this.tileW
    const cellY = cy * this.tileH
    const columns = this.solidColumns[tile]

    if (!columns) {
      // Flat tile: the box is the whole story, but still respect its x range.
      if (xTo <= cellX + box.x0 || xFrom >= cellX + box.x1) return null
      return { top: cellY + box.y0, bottom: cellY + box.y1 }
    }

    const first = Math.max(0, Math.floor(xFrom) - cellX)
    const last = Math.min(columns.length - 1, Math.ceil(xTo) - 1 - cellX)

    let top = Infinity
    let bottom = -Infinity
    for (let i = first; i <= last; i++) {
      const span = columns[i]
      if (!span) continue
      if (span[0] < top) top = span[0]
      if (span[1] > bottom) bottom = span[1]
    }

    if (top === Infinity) return null
    // Spans are inclusive; collision works in half-open ranges.
    return { top: cellY + top, bottom: cellY + bottom + 1 }
  }

  /** First object of the given type, or undefined. */
  findObject(...types: string[]): LevelObjectData | undefined {
    for (const type of types) {
      const found = this.objects.find((o) => o.type === type)
      if (found) return found
    }
    return undefined
  }
}

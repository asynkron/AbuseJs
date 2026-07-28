/**
 * Reader for the Abuse SPEC container format and the records stored inside it.
 *
 * Everything here was derived from the original engine sources and verified
 * against the shipped data files:
 *   container  - src/imlib/specs.cpp, spec_directory::startup
 *   image      - src/imlib/image.cpp, image::image(bFILE *, spec_entry *)
 *   palette    - src/imlib/palette.cpp, palette::palette(bFILE *)
 *   tiles/figs - src/items.cpp, backtile/foretile/figure constructors
 *
 * All integers are little-endian. This is the only file in the project that
 * knows about byte offsets - keep it dumb and literal.
 */

export const SpecType = {
  COLOR_TABLE: 1,
  PALETTE: 2,
  IMAGE: 4,
  FORETILE: 5,
  BACKTILE: 6,
  CHARACTER: 7,
  MORPH_POINTS_8: 8,
  MORPH_POINTS_16: 9,
  EXTERN_SFX: 11,
  NORMAL_FILE: 14,
  VECTOR_IMAGE: 16,
  LIGHT_LIST: 17,
  GRUE_FGMAP: 18,
  GRUE_BGMAP: 19,
  DATA_ARRAY: 20,
  CHARACTER2: 21,
  PARTICLE: 22,
} as const

/** Tag byte prefixing the packed per-object arrays in a level file. */
export const RC_8 = 0
export const RC_16 = 1
export const RC_32 = 2

export interface SpecEntry {
  type: number
  name: string
  flags: number
  size: number
  offset: number
}

export interface SpecFile {
  buf: Buffer
  entries: SpecEntry[]
  byName: Map<string, SpecEntry>
}

const SIGNATURE = 'SPEC1.0'

export function readSpecFile(buf: Buffer): SpecFile {
  if (buf.length < 10 || buf.toString('latin1', 0, 7) !== SIGNATURE) {
    throw new Error('not a SPEC file')
  }

  let p = 8
  const count = buf.readUInt16LE(p)
  p += 2

  const entries: SpecEntry[] = []
  const byName = new Map<string, SpecEntry>()

  for (let i = 0; i < count; i++) {
    const type = buf.readUInt8(p)
    const nameLen = buf.readUInt8(p + 1)
    p += 2
    // Names are stored with their trailing NUL included in nameLen.
    const name = buf.toString('latin1', p, p + nameLen).replace(/\0+$/, '')
    p += nameLen
    const flags = buf.readUInt8(p)
    p += 1
    // The modern engine ignores SPEC_FLAG_LINK and always reads size+offset.
    const size = buf.readUInt32LE(p)
    const offset = buf.readUInt32LE(p + 4)
    p += 8

    const entry: SpecEntry = { type, name, flags, size, offset }
    entries.push(entry)
    if (!byName.has(name)) byName.set(name, entry)
  }

  return { buf, entries, byName }
}

export function isSpecFile(buf: Buffer): boolean {
  return buf.length >= 10 && buf.toString('latin1', 0, 7) === SIGNATURE
}

/* ------------------------------------------------------------------ */
/* records                                                             */
/* ------------------------------------------------------------------ */

export interface PalettizedImage {
  width: number
  height: number
  /** width*height palette indices. */
  pixels: Buffer
  /** Byte offset just past the image data. */
  end: number
}

export function readImage(buf: Buffer, offset: number): PalettizedImage {
  const width = buf.readUInt16LE(offset)
  const height = buf.readUInt16LE(offset + 2)
  const start = offset + 4
  const end = start + width * height
  return { width, height, pixels: buf.subarray(start, end), end }
}

export interface Palette {
  /** ncolors * 3 bytes, RGB. */
  rgb: Buffer
  count: number
}

export function readPalette(buf: Buffer, offset: number): Palette {
  const count = buf.readUInt16LE(offset)
  return { rgb: buf.subarray(offset + 2, offset + 2 + count * 3), count }
}

export interface PointList {
  /** Flat [x0, y0, x1, y1, ...] in tile/sprite-local pixels. */
  points: number[]
  end: number
}

export function readPointList(buf: Buffer, offset: number): PointList {
  const count = buf.readUInt8(offset)
  const start = offset + 1
  const end = start + count * 2
  const points: number[] = []
  for (let i = start; i < end; i++) points.push(buf.readUInt8(i))
  return { points, end }
}

export interface BackTile {
  image: PalettizedImage
  /** Id of the next tile in an animation cycle, 0 when static. */
  next: number
}

export function readBackTile(buf: Buffer, offset: number): BackTile {
  const image = readImage(buf, offset)
  return { image, next: buf.readUInt16LE(image.end) }
}

export interface ForeTile {
  image: PalettizedImage
  next: number
  damage: number
  /** Collision outline, unused by the current mechanics but exported for later. */
  boundary: number[]
}

export function readForeTile(buf: Buffer, offset: number): ForeTile {
  const image = readImage(buf, offset)
  let p = image.end
  const next = buf.readUInt16LE(p)
  p += 2
  const damage = buf.readUInt8(p)
  p += 1
  const boundary = readPointList(buf, p)
  return { image, next, damage, boundary: boundary.points }
}

export interface Figure {
  image: PalettizedImage
  hitDamage: number
  /**
   * Anchor column within the frame. The engine blits at `x - xcfg` facing
   * right and `x - (width - xcfg - 1)` facing left (src/objects.cpp).
   */
  xcfg: number
  /** Per-frame root motion in pixels; only CHARACTER2 frames carry it. */
  advance: number
  damageBoundary: number[]
  hitPoints: number[]
}

export function readFigure(buf: Buffer, offset: number, type: number): Figure {
  const image = readImage(buf, offset)
  let p = image.end
  const hitDamage = buf.readUInt8(p)
  p += 1
  const xcfg = buf.readUInt8(p)
  p += 1

  let advance = 0
  if (type === SpecType.CHARACTER) {
    // Legacy frames store an (ignored) point list where advance would be.
    p = readPointList(buf, p).end
  } else {
    advance = buf.readInt8(p)
    p += 1
  }

  const damage = readPointList(buf, p)
  const hit = readPointList(buf, damage.end)

  return {
    image,
    hitDamage,
    xcfg,
    advance,
    damageBoundary: damage.points,
    hitPoints: hit.points,
  }
}

/* ------------------------------------------------------------------ */
/* level records                                                       */
/* ------------------------------------------------------------------ */

export interface TileMap {
  width: number
  height: number
  /** Raw cells; foreground cells still carry the 0x4000/0x8000 flag bits. */
  cells: Uint16Array
}

export function readTileMap(buf: Buffer, offset: number): TileMap {
  const width = buf.readUInt32LE(offset)
  const height = buf.readUInt32LE(offset + 4)
  const cells = new Uint16Array(width * height)
  let p = offset + 8
  for (let i = 0; i < cells.length; i++, p += 2) cells[i] = buf.readUInt16LE(p)
  return { width, height, cells }
}

export interface LightSource {
  x: number
  y: number
  /** Power-of-two squash: the light's reach is `outer >> shift` on that axis. */
  xshift: number
  yshift: number
  inner: number
  outer: number
  /** Which quadrants around the centre the light covers; see light.cpp, calc_range. */
  type: number
}

export interface LightList {
  /** Ambient floor, 0..63. Everything in the level sits at least this bright. */
  minLight: number
  lights: LightSource[]
}

/** Reads a level's `lights` entry (src/light.cpp, read_lights). */
export function readLightList(buf: Buffer, offset: number): LightList {
  const count = buf.readUInt32LE(offset)
  const minLight = buf.readUInt32LE(offset + 4)
  const lights: LightSource[] = []
  let p = offset + 8
  for (let i = 0; i < count; i++, p += 25) {
    lights.push({
      x: buf.readInt32LE(p),
      y: buf.readInt32LE(p + 4),
      xshift: buf.readInt32LE(p + 8),
      yshift: buf.readInt32LE(p + 12),
      inner: buf.readInt32LE(p + 16),
      outer: buf.readInt32LE(p + 20),
      type: buf.readUInt8(p + 24),
    })
  }
  return { minLight, lights }
}

export const FG_TILE_MASK = 0x3fff
/** Tile is drawn after entities, as a foreground overlay. */
export const FG_ABOVE = 0x4000

/**
 * Reads one of the packed per-object arrays (`x`, `y`, `type`, ...): a single
 * tag byte giving the element width, then `count` values.
 */
export function readTaggedArray(buf: Buffer, offset: number, count: number): number[] {
  const tag = buf.readUInt8(offset)
  const out: number[] = new Array(count)
  let p = offset + 1
  for (let i = 0; i < count; i++) {
    switch (tag) {
      case RC_8:
        out[i] = buf.readUInt8(p)
        p += 1
        break
      case RC_16:
        out[i] = buf.readUInt16LE(p)
        p += 2
        break
      case RC_32:
        out[i] = buf.readInt32LE(p)
        p += 4
        break
      default:
        throw new Error(`unknown RC tag ${tag}`)
    }
  }
  return out
}

/**
 * Reads `count` length-prefixed latin1 strings starting at `offset`.
 *
 * The stored length includes the trailing NUL, which we strip - so callers
 * must use the returned `end` rather than re-deriving it from string lengths.
 */
export function readNameList(
  buf: Buffer,
  offset: number,
  count: number,
): { names: string[]; end: number } {
  const names: string[] = []
  let p = offset
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt8(p)
    p += 1
    names.push(buf.toString('latin1', p, p + len).replace(/\0+$/, ''))
    p += len
  }
  return { names, end: p }
}

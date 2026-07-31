import type { LevelData, LevelObjectData, LightSource, TileMeta } from '../../assets/types'
import { generateMaze, ROOM_H, ROOM_W, type Room } from './maze'
import { crossSignature, learnTileModel, ringSignature, type TileSource } from './tileModel'

/**
 * Builds a whole playable level out of a maze and a tile model.
 *
 * The art all comes from one shipped level, which is the point: the model in
 * tileModel.ts learns where that level's artists put each tile, and this asks
 * it the same questions about a layout they never drew. Nothing here invents a
 * tile, picks a colour or places a pixel - it only decides which cells are rock.
 */

/** The id that means "make one up". Also works as a deep link: `#random/maze`. */
export const RANDOM_LEVEL_ID = 'random/maze'

/**
 * Which level teaches the tiles.
 *
 * It has to match the *structure* being generated, and that is the loop this
 * went round twice. Rooms-with-thin-walls came out 27% solid, so level01 at 82%
 * taught it badly and the fix looked like changing teacher - to level05, 20%
 * solid, which matched the numbers and produced thin platforms in open space.
 * That is Donkey Kong, not Abuse.
 *
 * The structure was the thing to change. maze.ts now cuts passages out of solid
 * rock and lands near 70%, so the warren levels teach it properly and level01
 * is back. Its own rock is the same tile nine times in ten, which is what makes
 * a corridor read as cut through something rather than assembled from parts.
 */
const TEACHER = 'levels/level01'

/**
 * Maze size in rooms: 73x49 tiles, or 2190x735 world pixels.
 *
 * Smaller than a shipped level (level01 is 100x120) on purpose. A maze has no
 * set pieces to break up the walking, so the same floor area reads as much
 * longer than a hand-built level does, and 72 rooms is already a few minutes
 * of it.
 */
const COLS = 9
const ROWS = 8

/** `minLight` on the 0..63 scale. The shipped levels sit at 35. */
const AMBIENT = 35

/** Roughly one light per room, so the place is lit without being flat. */
const LIGHT_INNER = 40
const LIGHT_OUTER = 210

/** Enemies per room, past the first - the start room is left clear. */
const ANT_CHANCE = 0.45
/** An ant already on its feet: `PHASE_BY_AISTATE[2]` is `running`. */
const ANT_GROUND_AISTATE = 2

const HEALTH_CHANCE = 0.25
const AMMO_CHANCE = 0.3
const GRENADE_CHANCE = 0.12

/** Tile size, for placing objects in world pixels. */
const TILE_W = 30
const TILE_H = 15

/** mulberry32 - small, fast, and good enough that a seed gives a level back. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * What `Level` reads as the tile id.
 *
 * A shipped cell carries flags above this - 0x4000 marks a tile drawn over the
 * entities, and level01 also sets bit 15, which the port ignores entirely. The
 * teacher is masked down to the id on the way in, so a generated cell is only
 * ever a plain tile: an overlay tile in a maze would draw in front of the cop
 * for reasons no one chose.
 */
const TILE_MASK = 0x3fff

function decodeCells(base64: string): Uint16Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1)
}

/** A copy with every flag stripped - see TILE_MASK. */
function maskTileIds(cells: Uint16Array): Uint16Array {
  const out = new Uint16Array(cells.length)
  for (let i = 0; i < cells.length; i++) out[i] = cells[i] & TILE_MASK
  return out
}

function encodeCells(cells: Uint16Array): string {
  const bytes = new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength)
  let bin = ''
  // In chunks: `String.fromCharCode(...bytes)` on a whole level overflows the
  // argument limit and throws.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * Copies the teacher's background, wrapped.
 *
 * The background is decoration that scrolls at a fraction of the world's speed,
 * so there is nothing structural to get right and no reason to synthesise it -
 * lifting a real one wholesale guarantees it looks like the game. Wrapping from
 * a random offset stops every generated level opening on the same wall.
 */
function backdrop(
  source: { w: number; h: number; cells: Uint16Array },
  width: number,
  height: number,
  random: () => number,
): Uint16Array {
  const out = new Uint16Array(width * height)
  const offsetX = Math.floor(random() * source.w)
  const offsetY = Math.floor(random() * source.h)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = (x + offsetX) % source.w
      const sy = (y + offsetY) % source.h
      out[y * width + x] = source.cells[sy * source.w + sx]
    }
  }
  return out
}

/**
 * Somewhere inside a chamber with floor under it, in world pixels.
 *
 * The floor cannot be assumed: a shaft cuts straight down through it, so a
 * column picked blind may be the hole. Putting the exit over one leaves it
 * hanging in mid-air, and putting the start over one drops the player into the
 * level below before they have touched a key.
 */
function floorSpot(
  room: Room,
  standable: (tx: number, ty: number) => boolean,
  reachable: (tx: number, ty: number) => boolean,
  random: () => number,
): { x: number; y: number } {
  // Every foothold in the chamber, preferring the ones the cop can get to.
  const spots: { tx: number; ty: number }[] = []
  const anywhere: { tx: number; ty: number }[] = []
  for (let i = 0; i < ROOM_W; i++) {
    for (let dy = ROOM_H - 1; dy >= 0; dy--) {
      const tx = room.x + i
      const ty = room.y + dy
      if (!standable(tx, ty)) continue
      anywhere.push({ tx, ty })
      if (reachable(tx, ty)) spots.push({ tx, ty })
    }
  }
  const pool = spots.length > 0 ? spots : anywhere
  const at = pool.length > 0 ? pool[Math.floor(random() * pool.length)] : { tx: room.x + 1, ty: room.y + ROOM_H - 1 }
  return {
    // Feet rest on top of the tile below the one being stood in.
    x: at.tx * TILE_W + TILE_W / 2,
    y: (at.ty + 1) * TILE_H,
  }
}

export interface GenerateOptions {
  /** The teacher's foreground grid and tile table. */
  readonly teacherFg: TileSource
  readonly teacherBg: { w: number; h: number; cells: Uint16Array }
  readonly bgScroll: LevelData['bgScroll']
  readonly tiles: Record<string, TileMeta>
  readonly seed?: number
}

/** Builds a `LevelData` the rest of the game cannot tell from a shipped one. */
export function generateLevel(options: GenerateOptions): LevelData {
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff)
  const random = seededRandom(seed)

  const isSolid = (id: number): boolean => {
    const meta = options.tiles[String(id & TILE_MASK)]
    return !!meta?.bb
  }

  // Masked here rather than at the call site: a caller that forgot would get a
  // level sprinkled with overlay tiles drawing in front of the cop, and the
  // failure would look like a rendering bug rather than a missing `& MASK`.
  const teacher: TileSource = {
    width: options.teacherFg.width,
    height: options.teacherFg.height,
    cells: maskTileIds(options.teacherFg.cells),
  }
  const model = learnTileModel([teacher], isSolid)
  const maze = generateMaze({ cols: COLS, rows: ROWS, random })
  const { width, height, solid } = maze

  // --- foreground -------------------------------------------------------
  // Out of bounds reads as solid, matching `Level.fgCell`, so the shell gets
  // the same edge tiles the teacher uses along its own border.
  const solidAt = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height ? true : solid[y * width + x] === 1

  // Left to right, top to bottom, so the tiles to the west and north are
  // already placed when each cell is chosen - see PickContext.
  const fg = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      fg[y * width + x] = model.pick({
        solid: solidAt(x, y),
        ring: ringSignature(solidAt, x, y),
        cross: crossSignature(solidAt, x, y),
        left: x > 0 ? fg[y * width + x - 1] : -1,
        up: y > 0 ? fg[(y - 1) * width + x] : -1,
        random,
      })
    }
  }

  // --- background -------------------------------------------------------
  // The shipped levels run about a third of the foreground's dimensions, which
  // is what their scroll divisor works out to.
  const bgW = Math.max(1, Math.ceil(width / 3))
  const bgH = Math.max(1, Math.ceil(height / 3))
  const bg = backdrop(options.teacherBg, bgW, bgH, random)

  // --- objects ----------------------------------------------------------
  const standable = (tx: number, ty: number): boolean => !solidAt(tx, ty) && solidAt(tx, ty + 1)
  const walkableAt = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < width && ty < height && maze.walkable[ty * width + tx] === 1
  const objects: LevelObjectData[] = []
  const blank = { direction: 1, hp: 0, aistate: 0, aitype: 0, xvel: 0, yvel: 0, xacel: 0, yacel: 0 }
  const place = (type: string, x: number, y: number, extra: Partial<LevelObjectData> = {}): void => {
    objects.push({ type, state: 'stopped', x, y, ...blank, ...extra })
  }

  const startAt = floorSpot(maze.start, standable, walkableAt, random)
  place('START', startAt.x, startAt.y)

  const exitAt = floorSpot(maze.exit, standable, walkableAt, random)
  // `next_level_ai` keeps the destination in aistate; main.ts sends an exit
  // taken in a generated level to a freshly generated one instead.
  place('NEXT_LEVEL', exitAt.x, exitAt.y, { aistate: 1 })

  const lights: LightSource[] = []
  for (const room of maze.rooms) {
    lights.push({
      x: (room.x + ROOM_W / 2) * TILE_W,
      y: (room.y + ROOM_H / 2) * TILE_H,
      xshift: 0,
      yshift: 0,
      inner: LIGHT_INNER,
      outer: LIGHT_OUTER,
      type: 0,
    })

    // The start room stays empty: dropping the player onto an ant before they
    // have their bearings reads as a bug rather than as difficulty.
    if (room === maze.start) continue

    if (random() < ANT_CHANCE) {
      const at = floorSpot(room, standable, walkableAt, random)
      place('ANT_ROOF', at.x, at.y, { aistate: ANT_GROUND_AISTATE })
    }
    if (random() < HEALTH_CHANCE) {
      const at = floorSpot(room, standable, walkableAt, random)
      place('HEALTH', at.x, at.y)
    }
    if (random() < AMMO_CHANCE) {
      const at = floorSpot(room, standable, walkableAt, random)
      place('MBULLET_ICON20', at.x, at.y)
    }
    if (random() < GRENADE_CHANCE) {
      const at = floorSpot(room, standable, walkableAt, random)
      place('GRENADE_ICON10', at.x, at.y)
    }
  }

  return {
    id: RANDOM_LEVEL_ID,
    firstName: `maze ${seed.toString(16)}`,
    fg: { w: width, h: height, cells: encodeCells(fg) },
    bg: { w: bgW, h: bgH, cells: encodeCells(bg) },
    bgScroll: options.bgScroll,
    lighting: { minLight: AMBIENT, lights },
    objects,
    links: objects.map(() => []),
    lightLinks: objects.map(() => []),
  }
}

/**
 * Fetches the teacher and builds a level from it.
 *
 * The teacher is fetched rather than baked in at build time: it is one file the
 * game already ships, the cost lands only when someone asks for a random level,
 * and it keeps the whole feature in one place instead of half of it in a build
 * step.
 */
export async function loadGeneratedLevel(
  fetchLevel: (id: string) => Promise<LevelData>,
  tiles: Record<string, TileMeta>,
  seed?: number,
): Promise<LevelData> {
  const teacher = await fetchLevel(TEACHER)
  return generateLevel({
    teacherFg: {
      width: teacher.fg.w,
      height: teacher.fg.h,
      cells: decodeCells(teacher.fg.cells),
    },
    teacherBg: { w: teacher.bg.w, h: teacher.bg.h, cells: decodeCells(teacher.bg.cells) },
    bgScroll: teacher.bgScroll,
    tiles,
    seed,
  })
}

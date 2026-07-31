/**
 * The shape of a generated level: tunnels cut through solid rock.
 *
 * This started as rooms separated by thin walls, which is what a maze usually
 * means, and it was wrong twice over. Thin walls in open space read as
 * platforms, so the result looked like Donkey Kong rather than Abuse; and
 * because it came out only 27% solid it could not be taught by the levels that
 * actually look like Abuse - the warrens - which are 82% solid. Chasing that
 * led to picking a girder level as the teacher, which made the resemblance
 * worse rather than better.
 *
 * So it is inverted: the map starts as rock and passages are cut out of it.
 * That lands near 70% solid, matching the levels whose art it borrows, and it
 * gives corridors and shafts instead of ledges hanging in the dark.
 *
 * Every dimension below comes off the cop's jump. A foreground tile is 30x15
 * and his apex is 112px, so no climb may exceed seven tiles. The shafts are
 * taller than that, which is why they are fitted with staggered ledges - one
 * hop each, the way a real level does it.
 */

/** Chamber cut at each maze cell, in foreground tiles. */
export const ROOM_W = 6
export const ROOM_H = 3

/** Cell pitch. The difference from the chamber size is the rock left between. */
const PITCH_X = 10
const PITCH_Y = 8

/** Head height of a corridor. Three tiles is 45px against the cop's 28. */
const CORRIDOR_H = 3
/**
 * Width of a vertical shaft, and how far apart its footholds are.
 *
 * A shaft cuts straight through the chamber floor, so it has to be narrow
 * enough to leave floor either side of it to stand on. The rungs are what make
 * it climbable: an open shaft is connected air, which is why checking air
 * connectivity said the level was fine while a walking player was stuck at the
 * bottom of it. Three tiles between rungs is 45px against a 112px jump.
 */
const SHAFT_W = 2
const RUNG_SPACING = 3

/**
 * Kept for the callers that place things, and for the jump check: the tallest
 * unbroken climb in the level is a shaft between two ledges, not the pitch.
 */
export const WALL = PITCH_Y - ROOM_H

/**
 * Extra passages knocked through after the maze is built, as a fraction of the
 * walls that survived.
 *
 * A perfect maze is a tree: one route between any two points, and every wrong
 * turn a dead end to walk back out of. A few loops make it somewhere you can
 * move around in.
 */
const LOOP_FRACTION = 0.18

/** Chance a horizontal corridor descends as it goes, instead of running level. */
const SLOPE_CHANCE = 0.45

/** Chance a chamber gets a ledge in it, for cover and to break up the box. */
const LEDGE_CHANCE = 0.4

export interface Room {
  readonly cx: number
  readonly cy: number
  /** Chamber interior, in foreground tiles. */
  readonly x: number
  readonly y: number
  /** Steps from the start chamber, over the maze graph. */
  readonly depth: number
}

export interface MazeLevel {
  readonly width: number
  readonly height: number
  /** 1 for rock, 0 for air. */
  readonly solid: Uint8Array
  readonly rooms: Room[]
  readonly start: Room
  readonly exit: Room
  /**
   * Footholds the cop can actually reach from the start, walking and jumping.
   *
   * Published because placing anything that must be visited - the exit above
   * all - is only safe against this. Connected air is not enough: gravity makes
   * some routes one-way.
   */
  readonly walkable: Uint8Array
}

interface Options {
  readonly cols: number
  readonly rows: number
  readonly random: () => number
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

/**
 * Whether the cop can get from one foothold to another in one move.
 *
 * His apex is 112px against a 15px tile, so seven tiles up; five across is
 * well inside what a run-up covers. The arc is stood in for by an L - up then
 * across, or across then up - and either being clear is about what a jump can
 * thread.
 */
const JUMP_UP = 7
const JUMP_ACROSS = 5

interface Grid {
  readonly width: number
  readonly height: number
  readonly solid: Uint8Array
}

function footReach(grid: Grid, from: { x: number; y: number }): Uint8Array {
  const { width, height, solid } = grid
  const rock = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height ? true : solid[y * width + x] === 1
  const stands = (x: number, y: number): boolean => !rock(x, y) && rock(x, y + 1)
  const canPass = (ax: number, ay: number, bx: number, by: number): boolean => {
    const lo = (a: number, b: number): number => Math.min(a, b)
    const hi = (a: number, b: number): number => Math.max(a, b)
    let ok = true
    for (let y = lo(ay, by); y <= hi(ay, by) && ok; y++) if (rock(ax, y)) ok = false
    for (let x = lo(ax, bx); x <= hi(ax, bx) && ok; x++) if (rock(x, by)) ok = false
    if (ok) return true
    ok = true
    for (let x = lo(ax, bx); x <= hi(ax, bx) && ok; x++) if (rock(x, ay)) ok = false
    for (let y = lo(ay, by); y <= hi(ay, by) && ok; y++) if (rock(bx, y)) ok = false
    return ok
  }

  const seen = new Uint8Array(width * height)
  if (!stands(from.x, from.y)) return seen
  const queue = [from]
  seen[from.y * width + from.x] = 1
  while (queue.length > 0) {
    const at = queue.pop() as { x: number; y: number }
    for (let dx = -JUMP_ACROSS; dx <= JUMP_ACROSS; dx++) {
      // Up only as far as he jumps; down as far as the level goes, since a
      // fall costs nothing.
      for (let dy = -JUMP_UP; dy <= height; dy++) {
        const nx = at.x + dx
        const ny = at.y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        if (seen[ny * width + nx] || !stands(nx, ny)) continue
        if (!canPass(at.x, at.y, nx, ny)) continue
        seen[ny * width + nx] = 1
        queue.push({ x: nx, y: ny })
      }
    }
  }
  return seen
}

export function generateMaze({ cols, rows, random }: Options): MazeLevel {
  const cellCount = cols * rows
  const doors = new Uint8Array(cellCount)
  const seen = new Uint8Array(cellCount)

  const SIDES = [
    { bit: 1, dx: 0, dy: -1, opposite: 4 },
    { bit: 2, dx: 1, dy: 0, opposite: 8 },
    { bit: 4, dx: 0, dy: 1, opposite: 1 },
    { bit: 8, dx: -1, dy: 0, opposite: 2 },
  ] as const

  // Recursive backtracker, with an explicit stack - the recursive form blows up
  // on a large maze and this is the same algorithm.
  const stack: number[] = [0]
  seen[0] = 1
  while (stack.length > 0) {
    const current = stack[stack.length - 1]
    const cx = current % cols
    const cy = Math.floor(current / cols)

    const options = shuffle([...SIDES], random).filter((side) => {
      const nx = cx + side.dx
      const ny = cy + side.dy
      return nx >= 0 && ny >= 0 && nx < cols && ny < rows && !seen[ny * cols + nx]
    })

    if (options.length === 0) {
      stack.pop()
      continue
    }

    const side = options[0]
    const next = (cy + side.dy) * cols + (cx + side.dx)
    doors[current] |= side.bit
    doors[next] |= side.opposite
    seen[next] = 1
    stack.push(next)
  }

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const here = cy * cols + cx
      if (cx + 1 < cols && !(doors[here] & 2) && random() < LOOP_FRACTION) {
        doors[here] |= 2
        doors[here + 1] |= 8
      }
      if (cy + 1 < rows && !(doors[here] & 4) && random() < LOOP_FRACTION) {
        doors[here] |= 4
        doors[here + cols] |= 1
      }
    }
  }

  // --- cut it out of the rock -------------------------------------------
  const margin = 2
  const width = cols * PITCH_X + margin * 2
  const height = rows * PITCH_Y + margin * 2
  const solid = new Uint8Array(width * height).fill(1)

  const roomX = (cx: number): number => margin + cx * PITCH_X
  const roomY = (cy: number): number => margin + cy * PITCH_Y

  const carve = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        solid[y * width + x] = 0
      }
    }
  }
  const fill = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < width && y < height) solid[y * width + x] = 1
  }

  /** Floor level of a chamber - the row of rock its feet rest on. */
  const floorOf = (cy: number): number => roomY(cy) + ROOM_H

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      carve(roomX(cx), roomY(cy), ROOM_W, ROOM_H)
    }
  }

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bits = doors[cy * cols + cx]

      // East: a corridor from this chamber to the next, sometimes descending a
      // step at a time. A sloped run is what gives the level diagonals - a
      // staircase of single tiles, which the tile model then dresses with the
      // corner and ramp art the source uses for exactly that shape.
      if (bits & 2) {
        const from = roomX(cx) + ROOM_W
        const to = roomX(cx + 1)
        const sloped = random() < SLOPE_CHANCE
        // Only descend, and only as far as the next chamber's headroom allows,
        // so the corridor always arrives somewhere the player can stand.
        const drop = sloped ? Math.min(ROOM_H - 1, Math.floor(random() * 3) + 1) : 0
        const span = Math.max(1, to - from)
        for (let i = 0; i < span; i++) {
          const step = Math.round((drop * i) / span)
          carve(from + i, roomY(cy) + step, 1, CORRIDOR_H)
        }
        // The far end has to meet the chamber, whatever the slope did.
        carve(to - 1, roomY(cy + 0), 1, CORRIDOR_H)
      }

      // South: a shaft down to the chamber below, rungs the whole way.
      //
      // Alternating single tiles, so each one is standable and the next is
      // within a jump of it, and a two-wide shaft always keeps one column open
      // to pass through. This is a ladder cut into rock rather than a hole.
      if (bits & 4) {
        const x = roomX(cx) + Math.floor((ROOM_W - SHAFT_W) / 2)
        const top = floorOf(cy)
        const bottom = roomY(cy + 1)
        carve(x, top, SHAFT_W, bottom - top)

        let side = random() < 0.5 ? 0 : SHAFT_W - 1
        for (let y = top + RUNG_SPACING - 1; y < bottom - 1; y += RUNG_SPACING) {
          fill(x + side, y)
          side = SHAFT_W - 1 - side
        }
      }
    }
  }

  // Ledges last but before nothing: a chamber ledge may not close a shaft, so
  // it is kept away from the middle columns the shaft uses.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (random() >= LEDGE_CHANCE) continue
      if (ROOM_H < 3) continue
      const y = roomY(cy) + 1
      const x = roomX(cx) + (random() < 0.5 ? 0 : ROOM_W - 1)
      fill(x, y)
    }
  }

  // --- make sure it can actually be walked ------------------------------
  //
  // Connected air is not the same as a traversable level: gravity makes some
  // routes one-way, and a maze whose passages only ever drop leaves most of
  // itself behind a climb the cop cannot make. Rather than try to prove each
  // carve correct - the carves are where the bugs were - the level is measured
  // and then repaired, which holds however the geometry is later changed.
  const standsAt = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && solid[y * width + x] === 0 &&
    (y + 1 >= height || solid[(y + 1) * width + x] === 1)

  /**
   * Any foothold in a chamber, or null when it has none.
   *
   * Not one fixed cell: a shaft cuts through the middle of the floor and a
   * ledge may sit on the rest, so the obvious representative is sometimes not
   * standable - and then the chamber can never register as reached, and the
   * repair below spends every attempt on the one chamber it can never satisfy
   * while the rest stay stranded.
   */
  const footOf = (cx: number, cy: number): { x: number; y: number } | null => {
    for (let i = 0; i < ROOM_W; i++) {
      const x = roomX(cx) + i
      for (let dy = ROOM_H - 1; dy >= 0; dy--) {
        const y = roomY(cy) + dy
        if (standsAt(x, y)) return { x, y }
      }
    }
    return null
  }

  const grid = { width, height, solid }
  const NEIGHBOURS = [[-1, 0], [0, -1], [1, 0], [0, 1]] as const

  const startFoot = footOf(0, 0)
  for (let attempt = 0; startFoot && attempt < cellCount; attempt++) {
    const reach = footReach(grid, startFoot)
    // A chamber counts as reached if *any* of its footholds is, and one with
    // none at all counts as reached so it cannot stall the loop - there is
    // nowhere in it to stand anyway.
    const reached = (cx: number, cy: number): boolean => {
      let anyFoothold = false
      for (let i = 0; i < ROOM_W; i++) {
        const x = roomX(cx) + i
        for (let dy = ROOM_H - 1; dy >= 0; dy--) {
          const y = roomY(cy) + dy
          if (!standsAt(x, y)) continue
          anyFoothold = true
          if (reach[y * width + x] === 1) return true
        }
      }
      // No foothold anywhere in it: nothing to strand, so never a repair target.
      return !anyFoothold
    }

    // Pick a stranded chamber that *borders* the reachable part. Taking the
    // first stranded one instead stalls the moment it happens to be in the
    // middle of an island, and the level ships with half of itself cut off -
    // which is exactly what 8 seeds in 40 did.
    let target: { cx: number; cy: number; dx: number; dy: number } | null = null
    for (let cy = 0; cy < rows && !target; cy++) {
      for (let cx = 0; cx < cols && !target; cx++) {
        if (reached(cx, cy)) continue
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          if (!reached(nx, ny)) continue
          target = { cx, cy, dx, dy }
          break
        }
      }
    }
    if (!target) break

    // Cut the passage that should have been there: a corridor sideways, a
    // rung-fitted shaft downwards.
    const { cx, cy, dx, dy } = target
    if (dy === 0) {
      const left = Math.min(cx, cx + dx)
      carve(roomX(left) + ROOM_W, roomY(cy), PITCH_X - ROOM_W, CORRIDOR_H)
    } else {
      const upper = Math.min(cy, cy + dy)
      const x = roomX(cx) + Math.floor((ROOM_W - SHAFT_W) / 2)
      const top = roomY(upper) + ROOM_H
      const bottom = roomY(upper + 1)
      carve(x, top, SHAFT_W, bottom - top)
      let side = 0
      for (let y = top + RUNG_SPACING - 1; y < bottom - 1; y += RUNG_SPACING) {
        fill(x + side, y)
        side = SHAFT_W - 1 - side
      }
    }
  }

  // --- rooms, by distance from the start --------------------------------
  const depth = new Int32Array(cellCount).fill(-1)
  depth[0] = 0
  const queue = [0]
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head]
    const cx = here % cols
    const cy = Math.floor(here / cols)
    for (const side of SIDES) {
      if (!(doors[here] & side.bit)) continue
      const nx = cx + side.dx
      const ny = cy + side.dy
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
      const next = ny * cols + nx
      if (depth[next] >= 0) continue
      depth[next] = depth[here] + 1
      queue.push(next)
    }
  }

  const rooms: Room[] = []
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      rooms.push({ cx, cy, x: roomX(cx), y: roomY(cy), depth: depth[cy * cols + cx] })
    }
  }

  const walkable = startFoot ? footReach(grid, startFoot) : new Uint8Array(width * height)
  const hasFoothold = (room: Room): boolean => {
    for (let i = 0; i < ROOM_W; i++) {
      for (let dy = ROOM_H - 1; dy >= 0; dy--) {
        const x = room.x + i
        const y = room.y + dy
        if (standsAt(x, y) && walkable[y * width + x]) return true
      }
    }
    return false
  }

  // Furthest from the start *that can be got to*. Taking the deepest chamber
  // outright puts the exit somewhere the repair pass could not join, and the
  // level becomes unfinishable in a way nothing on screen explains.
  const start = rooms[0]
  let exit = start
  for (const room of rooms) {
    if (room.depth > exit.depth && hasFoothold(room)) exit = room
  }

  return { width, height, solid, rooms, start, exit, walkable }
}

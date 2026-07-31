/**
 * The shape of a generated level: a maze of rooms carved out of solid rock.
 *
 * A textbook maze of one-cell corridors is the wrong thing for this game.
 * Abuse is a platformer with gravity, so the walls between vertically stacked
 * cells are not obstacles to route around - they are the floors you stand on,
 * and the gaps in them are the only way down or up. That makes the room
 * geometry a physics problem before it is a topology one.
 *
 * The numbers below all come off the cop's jump. A foreground tile is 30x15,
 * and `PHYSICS.jumpVelocity` against gravity gives him a 112px apex, so the
 * climb from one room's floor to the next room up - `ROOM_H + WALL` tiles, 90px
 * - clears it with room to spare, and a taller room would strand the player at
 * the bottom of a shaft with the exit above.
 */

/** Interior of one room, in foreground tiles. */
export const ROOM_W = 7
export const ROOM_H = 5
/** Rock between rooms. One tile, so a floor is one tile thick. */
export const WALL = 1

/** Width of the hole knocked through a floor or ceiling. */
const VERTICAL_GAP = 3

/**
 * Extra doors knocked through after the maze is built, as a fraction of the
 * walls that survived.
 *
 * A perfect maze is a tree: exactly one route between any two rooms, and every
 * wrong turn is a dead end you have to walk back out of. A few loops turn it
 * into something you can move around in.
 */
const LOOP_FRACTION = 0.18

/** Chance a room gets a ledge in it, for cover and to break up the boxes. */
const LEDGE_CHANCE = 0.35

export interface Room {
  /** Maze coordinates. */
  readonly cx: number
  readonly cy: number
  /** Interior, in foreground tiles. */
  readonly x: number
  readonly y: number
  /** Steps from the start room, over the maze graph. */
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
}

interface Options {
  /** Maze size in rooms. */
  readonly cols: number
  readonly rows: number
  readonly random: () => number
}

/** Fisher-Yates, on the caller's generator so a seed reproduces the level. */
function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

export function generateMaze({ cols, rows, random }: Options): MazeLevel {
  const cellCount = cols * rows
  /** Open sides per cell, as N/E/S/W bits. */
  const doors = new Uint8Array(cellCount)
  const seen = new Uint8Array(cellCount)

  const SIDES = [
    { bit: 1, dx: 0, dy: -1, opposite: 4 },
    { bit: 2, dx: 1, dy: 0, opposite: 8 },
    { bit: 4, dx: 0, dy: 1, opposite: 1 },
    { bit: 8, dx: -1, dy: 0, opposite: 2 },
  ] as const

  // Recursive backtracker, iteratively - a recursive one blows the stack on a
  // large maze and the explicit stack is the same algorithm.
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

  // Loops. Only east and south are considered, so each wall is offered once.
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

  // --- to tiles ---------------------------------------------------------
  const pitchX = ROOM_W + WALL
  const pitchY = ROOM_H + WALL
  // One wall all the way round, so the level has an outer shell.
  const width = cols * pitchX + WALL
  const height = rows * pitchY + WALL
  const solid = new Uint8Array(width * height).fill(1)

  const roomX = (cx: number): number => WALL + cx * pitchX
  const roomY = (cy: number): number => WALL + cy * pitchY
  const carve = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y++) {
      if (y < 0 || y >= height) continue
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || x >= width) continue
        solid[y * width + x] = 0
      }
    }
  }

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      carve(roomX(cx), roomY(cy), ROOM_W, ROOM_H)
    }
  }

  // Ledges before the doorways, so a doorway always wins over a ledge that
  // would have stood in it.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (random() >= LEDGE_CHANCE) continue
      const w = 2 + Math.floor(random() * 2)
      const x = roomX(cx) + 1 + Math.floor(random() * (ROOM_W - w - 1))
      // Never the top or bottom row: a ledge on the floor is a bump, and one
      // against the ceiling is a lid.
      const y = roomY(cy) + 2 + Math.floor(random() * Math.max(1, ROOM_H - 3))
      for (let i = 0; i < w; i++) solid[y * width + x + i] = 1
    }
  }

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bits = doors[cy * cols + cx]
      // East: the full room height, so it is a doorway you walk through rather
      // than a window you have to jump into.
      if (bits & 2) carve(roomX(cx) + ROOM_W, roomY(cy), WALL, ROOM_H)
      // South: a hole in the floor, which is also the ceiling below it.
      if (bits & 4) {
        const gap = Math.min(VERTICAL_GAP, ROOM_W)
        const x = roomX(cx) + Math.floor((ROOM_W - gap) / 2)
        carve(x, roomY(cy) + ROOM_H, gap, WALL)
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

  // The exit goes as far from the start as the maze allows, so the level is a
  // journey rather than a room with a door in it.
  let exit = rooms[0]
  for (const room of rooms) if (room.depth > exit.depth) exit = room

  return { width, height, solid, rooms, start: rooms[0], exit }
}

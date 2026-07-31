/**
 * Learning which tile belongs where, from the levels the game already ships.
 *
 * The maze is the easy half. The hard half is that Abuse's foreground set has
 * 1109 tiles and only a handful of them are "floor seen from above" or "inner
 * corner, rock to the north and east" - pick at random and you get confetti.
 *
 * The trick used here is to condition on *structure* rather than on the
 * neighbouring tile ids. For every cell in a source level we record which of
 * its eight neighbours are solid, as one byte, together with whether the cell
 * itself is solid; that pair is the key, and the value is a tally of the tiles
 * the artists actually used there. Generating then goes the other way: the
 * maze already fixes which cells are solid, so every cell's key is known before
 * a single tile is chosen, and each one is drawn from the distribution the real
 * levels show for that exact situation.
 *
 * Conditioning on neighbouring *tiles* - the usual Markov formulation, and the
 * first thing tried here - is strictly worse for this job. It has to be solved
 * as a constraint problem, because a choice made in one cell restricts its
 * neighbours and can paint into a corner with no legal tile left; it needs
 * backtracking, it can fail, and none of that work buys anything, because the
 * thing we want the tiles to agree with is the geometry, and the geometry is
 * already known. Structure-conditioned sampling is one pass, cannot fail, and
 * gets floors, ceilings, edges and corners right by construction.
 *
 * Measured over the shipped levels: 169 distinct keys, a median of 3 different
 * tiles per key, and the most common tile in a key accounting for 73% of its
 * uses. So the geometry really does pin the art down.
 */

/** The eight neighbours, in the bit order the signature packs them. */
const RING: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

/** The four that decide most of the art, for the coarser fallback. */
const CROSS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/** A grid of tile ids to learn from. */
export interface TileSource {
  readonly width: number
  readonly height: number
  /** Tile ids, already masked clear of the above-layer flag. */
  readonly cells: Uint16Array
}

/** Weighted tiles for one situation, kept as parallel arrays for cheap sampling. */
interface Bucket {
  ids: number[]
  weights: number[]
  total: number
}

export interface TileModel {
  /**
   * A tile for a cell, given whether it and its neighbours are solid.
   *
   * Falls back from the eight-neighbour key to the four-neighbour one and then
   * to "any tile of the right solidity", so a situation the source level never
   * happened to contain still produces something structurally correct.
   */
  pick(solid: boolean, ring: number, cross: number, random: () => number): number
  /** How many eight-neighbour situations were observed. Diagnostics only. */
  readonly detail: number
}

/** Packs the eight-neighbour solidity of one cell into a byte. */
export function ringSignature(solidAt: (x: number, y: number) => boolean, x: number, y: number): number {
  let bits = 0
  for (let i = 0; i < RING.length; i++) {
    if (solidAt(x + RING[i][0], y + RING[i][1])) bits |= 1 << i
  }
  return bits
}

/** The same for the four orthogonal neighbours. */
export function crossSignature(solidAt: (x: number, y: number) => boolean, x: number, y: number): number {
  let bits = 0
  for (let i = 0; i < CROSS.length; i++) {
    if (solidAt(x + CROSS[i][0], y + CROSS[i][1])) bits |= 1 << i
  }
  return bits
}

function tally(map: Map<string, Map<number, number>>, key: string, id: number): void {
  let counts = map.get(key)
  if (!counts) {
    counts = new Map()
    map.set(key, counts)
  }
  counts.set(id, (counts.get(id) ?? 0) + 1)
}

function freeze(map: Map<string, Map<number, number>>): Map<string, Bucket> {
  const out = new Map<string, Bucket>()
  for (const [key, counts] of map) {
    const ids: number[] = []
    const weights: number[] = []
    let total = 0
    for (const [id, n] of counts) {
      ids.push(id)
      weights.push(n)
      total += n
    }
    out.set(key, { ids, weights, total })
  }
  return out
}

function draw(bucket: Bucket, random: () => number): number {
  let roll = random() * bucket.total
  for (let i = 0; i < bucket.ids.length; i++) {
    roll -= bucket.weights[i]
    if (roll <= 0) return bucket.ids[i]
  }
  return bucket.ids[bucket.ids.length - 1]
}

/**
 * Builds the model from one or more source grids.
 *
 * One source is usually the right answer: two levels drawn by different hands
 * use different rock, and sampling across both gives a wall that changes
 * material halfway along. The parameter takes a list anyway, because a set of
 * levels that *do* share a tileset is more data for the same look.
 *
 * Out of bounds counts as solid, which is how `Level.fgCell` reads it - so the
 * tiles along a level's edge are learned as the edge cases they are.
 */
export function learnTileModel(sources: readonly TileSource[], isSolid: (id: number) => boolean): TileModel {
  const rings = new Map<string, Map<number, number>>()
  const crosses = new Map<string, Map<number, number>>()
  const anySolid = new Map<string, Map<number, number>>()

  for (const source of sources) {
    const { width, height, cells } = source
    const solidAt = (x: number, y: number): boolean =>
      x < 0 || y < 0 || x >= width || y >= height ? true : isSolid(cells[y * width + x])

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = cells[y * width + x]
        const self = isSolid(id) ? 1 : 0
        tally(rings, `${self}:${ringSignature(solidAt, x, y)}`, id)
        tally(crosses, `${self}:${crossSignature(solidAt, x, y)}`, id)
        tally(anySolid, String(self), id)
      }
    }
  }

  const ringBuckets = freeze(rings)
  const crossBuckets = freeze(crosses)
  const anyBuckets = freeze(anySolid)

  /**
   * For every situation the source never contained, the closest one it did.
   *
   * A maze puts cells in arrangements no shipped level happens to have - about
   * one cell in six, measured against level01 - and the obvious fallback, the
   * four-neighbour key, throws away everything the diagonals said. Nearest by
   * Hamming distance keeps as much of the situation as the source can answer:
   * a corner it has never seen is answered by the most similar corner it has,
   * not by a generic wall.
   *
   * 256 signatures against at most 256 observed ones, twice - small enough to
   * precompute once and never think about again.
   */
  const nearest = [new Int32Array(256).fill(-1), new Int32Array(256).fill(-1)]
  for (const self of [0, 1]) {
    const known: number[] = []
    for (let sig = 0; sig < 256; sig++) if (ringBuckets.has(`${self}:${sig}`)) known.push(sig)
    for (let sig = 0; sig < 256; sig++) {
      let best = -1
      let bestDistance = 99
      for (const candidate of known) {
        // Bits differing between the two, i.e. neighbours that disagree.
        let diff = sig ^ candidate
        let distance = 0
        while (diff) {
          distance += diff & 1
          diff >>= 1
        }
        if (distance < bestDistance) {
          bestDistance = distance
          best = candidate
        }
      }
      nearest[self][sig] = best
    }
  }

  return {
    detail: ringBuckets.size,
    pick(solid, ring, cross, random) {
      const self = solid ? 1 : 0
      const near = nearest[self][ring & 0xff]
      const bucket =
        ringBuckets.get(`${self}:${ring}`) ??
        (near >= 0 ? ringBuckets.get(`${self}:${near}`) : undefined) ??
        crossBuckets.get(`${self}:${cross}`) ??
        anyBuckets.get(String(self))
      // A source with no solid tiles at all would leave this empty; 0 is the
      // empty tile, which is the safe thing to draw either way.
      return bucket ? draw(bucket, random) : 0
    },
  }
}

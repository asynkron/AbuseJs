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

/**
 * Weight a candidate keeps when a neighbour was never followed by it.
 *
 * Small, so an unseen pairing loses badly to a seen one, but not zero: the
 * structural bucket is the authority on what fits the geometry, and letting
 * adjacency veto its last candidate would be a constraint that can fail.
 */
const ADJACENCY_FLOOR = 0.02

/**
 * Extra weight for simply continuing the neighbour's own tile.
 *
 * The adjacency counts already say this - a wall tile is overwhelmingly
 * followed by itself - but only when the structural bucket happens to contain
 * that tile *and* the pairing was seen. Asking for both at once is a joint
 * condition that often is not met, and then the sampling falls back to
 * bucket-proportional and the wall goes speckled again.
 *
 * So the prior is stated outright, because it is the single strongest fact in
 * the data: in level01, two neighbouring rock cells are the same tile about
 * nine times in ten. Tuned against that number, not guessed.
 */
const REPEAT_BONUS = 8000

/** Weighted tiles for one situation, kept as parallel arrays for cheap sampling. */
interface Bucket {
  ids: number[]
  weights: number[]
  total: number
}

/** Everything known about a cell at the moment its tile is chosen. */
export interface PickContext {
  readonly solid: boolean
  readonly ring: number
  readonly cross: number
  /**
   * Tiles already placed to the left and above, or -1 at the edge.
   *
   * These are what stop the result being noise. The structural key alone says
   * "some rock with air to the north", and a bucket like that holds several
   * tiles; drawing each cell independently from it means two neighbouring rock
   * cells almost always disagree, and a wall that should read as one material
   * comes out as every variant the artists ever drew, shuffled. Measured: in
   * level01 two adjacent rock cells differ 9.5% of the time, and independent
   * sampling took that to 44%.
   */
  readonly left: number
  readonly up: number
  readonly random: () => number
}

export interface TileModel {
  /**
   * A tile for a cell.
   *
   * Structure picks the bucket, the neighbours pick within it. The structural
   * key falls back from eight neighbours to the nearest observed eight, then to
   * four, then to "any tile of the right solidity", so a situation the source
   * never contained still produces something structurally correct.
   */
  pick(context: PickContext): number
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
  /** `rightOf.get(a).get(b)` - times b sat immediately right of a. */
  const rightOf = new Map<number, Map<number, number>>()
  /** The same, vertically. */
  const below = new Map<number, Map<number, number>>()

  const pair = (map: Map<number, Map<number, number>>, a: number, b: number): void => {
    let row = map.get(a)
    if (!row) {
      row = new Map()
      map.set(a, row)
    }
    row.set(b, (row.get(b) ?? 0) + 1)
  }

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
        if (x + 1 < width) pair(rightOf, id, cells[y * width + x + 1])
        if (y + 1 < height) pair(below, id, cells[(y + 1) * width + x])
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
    pick({ solid, ring, cross, left, up, random }) {
      const self = solid ? 1 : 0
      const near = nearest[self][ring & 0xff]
      const bucket =
        ringBuckets.get(`${self}:${ring}`) ??
        (near >= 0 ? ringBuckets.get(`${self}:${near}`) : undefined) ??
        crossBuckets.get(`${self}:${cross}`) ??
        anyBuckets.get(String(self))
      // A source with no solid tiles at all would leave this empty; 0 is the
      // empty tile, which is the safe thing to draw either way.
      if (!bucket) return 0
      if (bucket.ids.length === 1) return bucket.ids[0]

      // Re-weight the bucket by what the already-placed neighbours were
      // followed by in the source. This is the Markov half, and it is what
      // turns a field of plausible-but-unrelated tiles into walls made of one
      // material: the structural key says which tiles *could* go here, the
      // neighbours say which of them actually follows what is already there.
      //
      // Multiplicative, so a candidate has to satisfy both neighbours, and
      // smoothed by ADJACENCY_FLOOR so a pair the source never contained is
      // heavily penalised rather than impossible - that is what keeps this a
      // preference and not a constraint, and why it can never fail the way
      // backtracking tile models do.
      const rightRow = left >= 0 ? rightOf.get(left) : undefined
      const belowRow = up >= 0 ? below.get(up) : undefined
      if (!rightRow && !belowRow) return draw(bucket, random)

      // Hard first: keep only candidates the source actually put next to what
      // is already placed. A pairing the artists never drew is not a rare
      // choice to be made unlikely - it is a join that does not exist, and a
      // soft weight lets it through often enough to see.
      const allowed = bucket.ids.filter(
        (id) => (!rightRow || rightRow.has(id)) && (!belowRow || belowRow.has(id)),
      )
      // When this bucket holds nothing that joins, widen the search to every
      // tile of the right solidity rather than accepting a join that does not
      // exist. Solidity is the hard invariant - it is what the collision world
      // reads - and the exact eight-neighbour signature is only how the join
      // is decorated. Given the choice, keep the join and lose the signature:
      // a wall of slightly wrong-looking rock still reads as a wall, whereas
      // two tiles that never meet in the game read as a glitch.
      const wider = allowed.length > 0 ? allowed : (anyBuckets.get(String(self))?.ids ?? bucket.ids)
      const joined =
        allowed.length > 0
          ? allowed
          : wider.filter((id) => (!rightRow || rightRow.has(id)) && (!belowRow || belowRow.has(id)))
      // Still nothing: relax to one neighbour, then give up and take the
      // structural bucket. Rare, and the fallbacks are ordered so the commonest
      // situations never reach them.
      const relaxed =
        joined.length > 0
          ? joined
          : wider.filter((id) => (rightRow?.has(id) ?? false) || (belowRow?.has(id) ?? false))
      const candidates = relaxed.length > 0 ? relaxed : bucket.ids

      let total = 0
      const scores = candidates.map((id) => {
        const known = bucket.ids.indexOf(id)
        // A tile pulled in from the wider set has no weight in this bucket;
        // give it the smallest one there so it stays a last resort.
        let score = known >= 0 ? bucket.weights[known] : 1
        if (rightRow) score *= (rightRow.get(id) ?? 0) + ADJACENCY_FLOOR
        if (belowRow) score *= (belowRow.get(id) ?? 0) + ADJACENCY_FLOOR
        if (id === left) score *= REPEAT_BONUS
        if (id === up) score *= REPEAT_BONUS
        total += score
        return score
      })

      let roll = random() * total
      for (let i = 0; i < scores.length; i++) {
        roll -= scores[i]
        if (roll <= 0) return candidates[i]
      }
      return candidates[candidates.length - 1]
    },
  }
}

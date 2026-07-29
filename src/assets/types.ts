/** Shapes of the JSON emitted by tools/convert.ts. */

export interface TileMeta {
  /** Atlas page index. */
  p: number
  x: number
  y: number
  w: number
  h: number
  /** Next tile in an animation cycle, 0 when static. */
  next: number
  damage?: number
  /** Collision box [x0, y0, x1, y1] in tile-local pixels. Absent means passable. */
  bb?: [number, number, number, number]
  /**
   * Per-column solid span `[top, bottom]`, inclusive, or null for an empty
   * column. Present only for ramps and other tiles whose outline is not just
   * its bounding box.
   */
  cols?: ([number, number] | null)[]
  /** Original collision outline, kept for slope support later. */
  boundary?: number[]
}

export interface TileSet {
  cellW: number
  cellH: number
  pages: string[]
  tiles: Record<string, TileMeta>
}

export interface TilesManifest {
  fore: TileSet
  back: TileSet
}

/** [page, x, y, w, h, xcfg, advance] */
export type FrameMeta = [number, number, number, number, number, number, number]

export interface CharacterManifest {
  /** The .spe file this character's frames live in. */
  file: string
  range?: [number, number]
  states: Record<string, string[]>
  /**
   * Only drawn inside the level editor - markers, logic gates, ambient sound
   * emitters and the like. Invisible while playing.
   */
  editorOnly?: boolean
  /**
   * Cycles its frames while idle - fire, lava, water. Everything else holds a
   * frame until something acts on it.
   */
  idleAnimated?: boolean
  /**
   * Name of the tint array this character indexes with its `aitype` to pick a
   * colour variant, e.g. `ant_tints`.
   */
  tints?: string
  /** `(abilities ...)` from the character definition, e.g. `start_hp`. */
  abilities?: Record<string, number>
}

export interface CharsManifest {
  pages: string[]
  frames: Record<string, FrameMeta>
  characters: Record<string, CharacterManifest>
  /** Per tint array, which indices have baked variants (1) and which do not. */
  tintArrays: Record<string, (number | null)[]>
}

export interface LevelObjectData {
  type: string
  state: string
  x: number
  y: number
  direction: number
  hp: number
  aistate: number
  aitype: number
  /**
   * Level objects reuse the velocity slots as configuration - AMBIENT_SOUND
   * keeps its repeat delay in `xvel`, volume in `yvel`, random spread in
   * `xacel`.
   */
  xvel: number
  yvel: number
  xacel: number
}

export interface ImagesManifest {
  pages: string[]
  /** [page, x, y, w, h] for atlased images, or a standalone PNG path. */
  images: Record<string, number[] | string>
}

export interface LightSource {
  x: number
  y: number
  /** Power-of-two squash: the light's reach is `outer >> shift` on that axis. */
  xshift: number
  yshift: number
  inner: number
  outer: number
  /** Which quadrants around the centre the light covers. */
  type: number
}

export interface LightingData {
  /** Ambient floor, 0..63. */
  minLight: number
  lights: LightSource[]
}

export interface LevelData {
  id: string
  firstName: string
  fg: { w: number; h: number; cells: string }
  bg: { w: number; h: number; cells: string }
  bgScroll: { xmul: number; xdiv: number; ymul: number; ydiv: number }
  lighting: LightingData
  objects: LevelObjectData[]
  /** Per object, the indices of the objects it is wired to. */
  links: number[][]
}

export interface LevelIndexEntry {
  id: string
  name: string
  width: number
  height: number
  objects: number
}

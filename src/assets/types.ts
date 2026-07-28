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
}

export interface CharsManifest {
  pages: string[]
  frames: Record<string, FrameMeta>
  characters: Record<string, CharacterManifest>
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
}

export interface LevelIndexEntry {
  id: string
  name: string
  width: number
  height: number
  objects: number
}

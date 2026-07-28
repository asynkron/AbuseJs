import { Assets, Rectangle, Texture } from 'pixi.js'

import type {
  CharsManifest,
  FrameMeta,
  ImagesManifest,
  LevelData,
  LevelIndexEntry,
  TileMeta,
  TileSet,
  TilesManifest,
} from './types'

const BASE = 'assets'

/** One animation frame: the texture plus the anchor data the engine stored. */
export interface Frame {
  texture: Texture
  width: number
  height: number
  /** Anchor column - the sprite is blitted at `x - xcfg` when facing right. */
  xcfg: number
  /** Root motion in pixels for this frame; unused so far. */
  advance: number
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`)
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

/** Levels are stored flat, with their source path folded into the filename. */
export function levelFileName(id: string): string {
  return `${id.split('/').join('__')}.json`
}

export class GameAssets {
  private constructor(
    readonly tiles: TilesManifest,
    readonly chars: CharsManifest,
    readonly images: ImagesManifest,
    readonly levels: LevelIndexEntry[],
    private readonly tilePages: { fore: Texture[]; back: Texture[] },
    private readonly charPages: Texture[],
    private readonly imagePages: Texture[],
  ) {}

  private readonly tileCache = new Map<string, Texture>()
  private readonly frameCache = new Map<string, Frame>()
  private readonly imageCache = new Map<string, Texture | null>()

  static async load(onProgress?: (label: string) => void): Promise<GameAssets> {
    onProgress?.('manifests')
    const [tiles, chars, images, levels] = await Promise.all([
      json<TilesManifest>('tiles.json'),
      json<CharsManifest>('chars.json'),
      json<ImagesManifest>('images.json'),
      json<LevelIndexEntry[]>('levels.json'),
    ])

    onProgress?.('textures')
    const loadPages = (pages: string[]) => Promise.all(pages.map((p) => Assets.load<Texture>(`${BASE}/${p}`)))
    const [forePages, backPages, charPages, imagePages] = await Promise.all([
      loadPages(tiles.fore.pages),
      loadPages(tiles.back.pages),
      loadPages(chars.pages),
      loadPages(images.pages),
    ])

    // The art is 1995-era pixel art shown at integer zoom - never smooth it.
    for (const tex of [...forePages, ...backPages, ...charPages, ...imagePages]) {
      tex.source.scaleMode = 'nearest'
    }

    return new GameAssets(
      tiles,
      chars,
      images,
      levels,
      { fore: forePages, back: backPages },
      charPages,
      imagePages,
    )
  }

  private sub(page: Texture, x: number, y: number, w: number, h: number): Texture {
    return new Texture({ source: page.source, frame: new Rectangle(x, y, w, h) })
  }

  tileMeta(kind: 'fore' | 'back', id: number): TileMeta | undefined {
    return this.tiles[kind].tiles[String(id)]
  }

  tileSet(kind: 'fore' | 'back'): TileSet {
    return this.tiles[kind]
  }

  tileTexture(kind: 'fore' | 'back', id: number): Texture | undefined {
    const key = `${kind}:${id}`
    const cached = this.tileCache.get(key)
    if (cached) return cached

    const meta = this.tileMeta(kind, id)
    if (!meta) return undefined
    const page = this.tilePages[kind][meta.p]
    if (!page) return undefined

    const texture = this.sub(page, meta.x, meta.y, meta.w, meta.h)
    this.tileCache.set(key, texture)
    return texture
  }

  /**
   * The tint variant to draw a character in, given the `aitype` the level
   * stored on it. Undefined means draw the untinted frames.
   */
  tintFor(character: string, aitype: number): number | undefined {
    const array = this.chars.characters[character]?.tints
    if (!array) return undefined
    return this.chars.tintArrays?.[array]?.[aitype] ? aitype : undefined
  }

  /**
   * A single sprite frame, addressed by its source file and entry name.
   * `tintIndex` selects a baked colour variant.
   */
  frame(file: string, name: string, tintIndex?: number): Frame | undefined {
    const key = tintIndex === undefined ? `${file}#${name}` : `${file}@${tintIndex}#${name}`
    const cached = this.frameCache.get(key)
    if (cached) return cached

    const meta: FrameMeta | undefined = this.chars.frames[key]
    if (!meta) return undefined
    const [p, x, y, w, h, xcfg, advance] = meta
    const page = this.charPages[p]
    if (!page) return undefined

    const frame: Frame = { texture: this.sub(page, x, y, w, h), width: w, height: h, xcfg, advance }
    this.frameCache.set(key, frame)
    return frame
  }

  /** Every frame of one animation state, in order. Empty if unknown. */
  animation(character: string, state: string, tintIndex?: number): Frame[] {
    const def = this.chars.characters[character]
    if (!def) return []
    const names = def.states[state]
    if (!names) return []
    return names
      .map((n) => this.frame(def.file, n, tintIndex) ?? this.frame(def.file, n))
      .filter((f): f is Frame => f !== undefined)
  }

  hasState(character: string, state: string): boolean {
    return this.chars.characters[character]?.states[state] !== undefined
  }

  character(name: string) {
    return this.chars.characters[name]
  }

  /** Every state this character defines, in declaration order. */
  states(character: string): string[] {
    const def = this.chars.characters[character]
    return def ? Object.keys(def.states) : []
  }

  /**
   * The state to show an object in when nothing better is known. Prefers
   * `stopped`, which nearly every character defines, and otherwise takes
   * whatever it has.
   */
  defaultState(character: string): string {
    const states = this.states(character)
    if (states.includes('stopped')) return 'stopped'
    return states[0] ?? 'stopped'
  }

  /** One of a character's `(abilities ...)` values, e.g. `start_hp`. */
  ability(character: string, name: string): number | undefined {
    return this.chars.characters[character]?.abilities?.[name]
  }

  /** True for markers and logic objects that the original only drew in-editor. */
  isEditorOnly(character: string): boolean {
    return this.chars.characters[character]?.editorOnly === true
  }

  /**
   * A loose image such as `art/fonts.spe#small_font`. Large ones were written
   * as standalone PNGs, so this may need a fetch; those resolve to null until
   * loaded and are only used for full-screen art, not per-frame drawing.
   */
  imageTexture(key: string): Texture | null {
    const cached = this.imageCache.get(key)
    if (cached !== undefined) return cached

    const meta = this.images.images[key]
    if (meta === undefined) {
      this.imageCache.set(key, null)
      return null
    }

    if (typeof meta === 'string') {
      // Standalone page: kick off a load and report it once it lands.
      this.imageCache.set(key, null)
      void Assets.load<Texture>(`${BASE}/${meta}`).then((tex) => {
        tex.source.scaleMode = 'nearest'
        this.imageCache.set(key, tex)
      })
      return null
    }

    const [p, x, y, w, h] = meta
    const page = this.imagePages[p]
    if (!page) {
      this.imageCache.set(key, null)
      return null
    }

    const texture = this.sub(page, x, y, w, h)
    this.imageCache.set(key, texture)
    return texture
  }

  loadLevel(id: string): Promise<LevelData> {
    return json<LevelData>(`levels/${levelFileName(id)}`)
  }
}

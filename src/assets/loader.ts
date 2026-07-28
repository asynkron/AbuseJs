import { Assets, Rectangle, Texture } from 'pixi.js'

import type {
  CharsManifest,
  FrameMeta,
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
    readonly levels: LevelIndexEntry[],
    private readonly tilePages: { fore: Texture[]; back: Texture[] },
    private readonly charPages: Texture[],
  ) {}

  private readonly tileCache = new Map<string, Texture>()
  private readonly frameCache = new Map<string, Frame>()

  static async load(onProgress?: (label: string) => void): Promise<GameAssets> {
    onProgress?.('manifests')
    const [tiles, chars, levels] = await Promise.all([
      json<TilesManifest>('tiles.json'),
      json<CharsManifest>('chars.json'),
      json<LevelIndexEntry[]>('levels.json'),
    ])

    onProgress?.('textures')
    const loadPages = (pages: string[]) => Promise.all(pages.map((p) => Assets.load<Texture>(`${BASE}/${p}`)))
    const [forePages, backPages, charPages] = await Promise.all([
      loadPages(tiles.fore.pages),
      loadPages(tiles.back.pages),
      loadPages(chars.pages),
    ])

    // The art is 1995-era pixel art shown at integer zoom - never smooth it.
    for (const tex of [...forePages, ...backPages, ...charPages]) {
      tex.source.scaleMode = 'nearest'
    }

    return new GameAssets(tiles, chars, levels, { fore: forePages, back: backPages }, charPages)
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

  /** A single sprite frame, addressed by its source file and entry name. */
  frame(file: string, name: string): Frame | undefined {
    const key = `${file}#${name}`
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
  animation(character: string, state: string): Frame[] {
    const def = this.chars.characters[character]
    if (!def) return []
    const names = def.states[state]
    if (!names) return []
    return names.map((n) => this.frame(def.file, n)).filter((f): f is Frame => f !== undefined)
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

  /** True for markers and logic objects that the original only drew in-editor. */
  isEditorOnly(character: string): boolean {
    return this.chars.characters[character]?.editorOnly === true
  }

  loadLevel(id: string): Promise<LevelData> {
    return json<LevelData>(`levels/${levelFileName(id)}`)
  }
}

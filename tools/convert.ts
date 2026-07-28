/**
 * Converts the original Abuse data files into web-friendly assets.
 *
 *   assets/original/**.spe   ->  public/assets/**.png + *.json
 *   assets/original/sfx/*.wav ->  public/assets/sfx/*.wav
 *
 * Run with `npm run assets`. Output is generated and gitignored; the .spe
 * files remain the source of truth.
 */

import { mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, dirname, basename, extname } from 'node:path'

import {
  readSpecFile,
  isSpecFile,
  readImage,
  readPalette,
  readForeTile,
  readBackTile,
  readFigure,
  readTileMap,
  readTaggedArray,
  readNameList,
  readLightList,
  SpecType,
  type PalettizedImage,
  type SpecFile,
} from './spec.js'
import {
  readForms,
  extractCharacters,
  expandCharacterTemplates,
  extractEditorOnlyDrawFuns,
  extractSounds,
  extractTrainMessages,
  isSymbol,
  walk,
  type CharacterDef,
  type Sexp,
  type SoundTable,
} from './lisp.js'
import { packGrid, packShelves, writePage, type PackInput } from './atlas.js'

const SRC = 'assets/original'
const OUT = 'public/assets'

/** Images wider or taller than this get their own PNG instead of an atlas slot. */
const STANDALONE_THRESHOLD = 512

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const out: string[] = []
  async function walkDir(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walkDir(p)
      else if (extname(e.name).toLowerCase() === ext) out.push(p)
    }
  }
  await walkDir(dir)
  out.sort()
  return out
}

/** Path relative to assets/original, with forward slashes - our asset ids. */
function assetId(path: string): string {
  return relative(SRC, path).split('\\').join('/')
}

function toRGBA(image: PalettizedImage, palette: Buffer, transparentIndex0: boolean): Buffer {
  const { width, height, pixels } = image
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const idx = pixels[i]
    if (transparentIndex0 && idx === 0) continue // leave fully transparent
    const p = idx * 3
    rgba[o] = palette[p]
    rgba[o + 1] = palette[p + 1]
    rgba[o + 2] = palette[p + 2]
    rgba[o + 3] = 255
  }
  return rgba
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

function base64OfU16(cells: Uint16Array): string {
  return Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength).toString('base64')
}

/* ------------------------------------------------------------------ */
/* palette + tints                                                     */
/* ------------------------------------------------------------------ */

async function loadPalette(): Promise<Buffer> {
  const buf = await readFile(join(SRC, 'art/back/backgrnd.spe'))
  const spec = readSpecFile(buf)
  const entry = spec.byName.get('palette')
  if (!entry) throw new Error('art/back/backgrnd.spe has no "palette" entry')
  const pal = readPalette(buf, entry.offset)
  if (pal.count !== 256) throw new Error(`expected 256 palette colors, got ${pal.count}`)
  return pal.rgb
}

async function collectTints(): Promise<Record<string, number[]>> {
  const tints: Record<string, number[]> = {}
  const dir = join(SRC, 'art/tints')
  if (!existsSync(dir)) return tints
  for (const file of await listFiles(dir, '.spe')) {
    const buf = await readFile(file)
    if (!isSpecFile(buf)) continue
    const spec = readSpecFile(buf)
    const entry = spec.entries.find((e) => e.type === SpecType.PALETTE)
    if (!entry) continue
    const pal = readPalette(buf, entry.offset)
    if (pal.count !== 256) continue
    const name = relative(dir, file).replace(/\.spe$/, '').split('\\').join('/')
    tints[name] = Array.from(pal.rgb)
  }
  return tints
}

/* ------------------------------------------------------------------ */
/* lisp scan                                                           */
/* ------------------------------------------------------------------ */

interface LispScan {
  /** Ordered tile file lists from every `(load_tiles ...)` call. */
  tileFiles: string[]
  characters: CharacterDef[]
  /** Draw functions that only run in the level editor. */
  editorOnlyDrawFuns: Set<string>
  sounds: SoundTable
  /** TRAIN_MSG tutorial lines, keyed by message number. */
  trainMessages: Record<number, string>
}

async function scanLisp(): Promise<LispScan> {
  const files = await listFiles(SRC, '.lsp')
  // Core definitions first, addons after, so addon redefinitions win - the
  // same order abuse.lsp loads them in.
  files.sort((a, b) => {
    const rank = (p: string) => (p.includes('/addon/') ? 1 : 0)
    return rank(a) - rank(b) || a.localeCompare(b)
  })

  const tileFiles: string[] = []
  const characters = new Map<string, CharacterDef>()
  // `dev_draw` is a built-in; the rest are found by shape in the scripts.
  const editorOnlyDrawFuns = new Set<string>(['dev_draw'])
  let sounds: SoundTable = { named: {}, arrays: {} }
  let trainMessages: Record<number, string> = {}

  for (const file of files) {
    let forms: Sexp[]
    try {
      forms = readForms(await readFile(file, 'utf8'))
    } catch (err) {
      console.warn(`  ! skipped ${assetId(file)}: ${(err as Error).message}`)
      continue
    }

    for (const form of walk(forms)) {
      if (isSymbol(form[0], 'load_tiles')) {
        for (const arg of form.slice(1)) if (typeof arg === 'string') tileFiles.push(arg)
      }
    }
    for (const c of extractCharacters(forms)) characters.set(c.name, c)
    for (const c of expandCharacterTemplates(forms)) characters.set(c.name, c)
    for (const fn of extractEditorOnlyDrawFuns(forms)) editorOnlyDrawFuns.add(fn)

    // The sound table is self-contained and order-sensitive, so resolve it
    // from its own file rather than accumulating across the whole tree.
    // Match the exact path: addon/twist ships its own lisp/sfx.lsp and, being
    // sorted after the core scripts, would otherwise clobber this.
    if (assetId(file) === 'lisp/sfx.lsp') sounds = extractSounds(forms)
    if (assetId(file) === 'lisp/english.lsp') trainMessages = extractTrainMessages(forms)
  }

  return {
    tileFiles,
    characters: [...characters.values()],
    editorOnlyDrawFuns,
    sounds,
    trainMessages,
  }
}

/* ------------------------------------------------------------------ */
/* tiles                                                               */
/* ------------------------------------------------------------------ */

interface TileMeta {
  p: number
  x: number
  y: number
  w: number
  h: number
  next: number
  damage?: number
  /** Collision box [x0, y0, x1, y1] in tile-local pixels; absent means passable. */
  bb?: [number, number, number, number]
  /**
   * Per-column solid span `[top, bottom]` (inclusive) or null. Present only
   * when the outline is not simply its bounding box - that is, for ramps and
   * other shaped tiles. Absent means "use `bb`".
   */
  cols?: (number[] | null)[]
  boundary?: number[]
}

/**
 * Rasterises a tile's collision outline into one solid span per pixel column.
 *
 * The outline is a closed polygon in tile-local pixels. Every shape in the
 * data has a single contiguous solid span per column, so intersecting the
 * vertical line at each x with all edges and taking the lowest and highest
 * crossing gives exactly the solid range - and unlike a point-in-polygon test
 * it has no trouble with points that sit exactly on the boundary, which is
 * where all of these vertices live.
 *
 * Returns `[top, bottom]` pairs, inclusive, or `null` per empty column.
 */
function boundarySpans(boundary: number[], width: number): (number[] | null)[] {
  const points: [number, number][] = []
  for (let i = 0; i < boundary.length; i += 2) points.push([boundary[i], boundary[i + 1]])

  const spans: (number[] | null)[] = []

  for (let x = 0; x < width; x++) {
    let top = Infinity
    let bottom = -Infinity

    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i]
      const [x1, y1] = points[i + 1]

      if (x0 === x1) {
        // Vertical edge: covers its whole y range at this column.
        if (x0 !== x) continue
        top = Math.min(top, y0, y1)
        bottom = Math.max(bottom, y0, y1)
        continue
      }

      if (x < Math.min(x0, x1) || x > Math.max(x0, x1)) continue
      const y = y0 + ((x - x0) * (y1 - y0)) / (x1 - x0)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }

    spans.push(Number.isFinite(top) ? [Math.round(top), Math.round(bottom)] : null)
  }

  return spans
}

/** True when the outline fills its whole bounding box - the common case. */
function isFullRect(spans: (number[] | null)[], height: number): boolean {
  return spans.every((s) => s !== null && s[0] === 0 && s[1] === height - 1)
}

/**
 * A foreground tile is solid exactly when it carries a collision outline - the
 * engine intersects movement against these points, so a tile with none is
 * walked straight through.
 */
function boundaryBox(boundary: number[]): [number, number, number, number] | undefined {
  if (boundary.length < 4) return undefined
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < boundary.length; i += 2) {
    x0 = Math.min(x0, boundary[i])
    x1 = Math.max(x1, boundary[i])
    y0 = Math.min(y0, boundary[i + 1])
    y1 = Math.max(y1, boundary[i + 1])
  }
  // +1 because the outline runs through pixel centres, not tile edges.
  return [x0, y0, x1 + 1, y1 + 1]
}

async function convertTiles(palette: Buffer, tileFiles: string[]) {
  // A tile's global id is its entry name parsed as an integer (loader2.cpp).
  // Later files redefine earlier ones, matching the engine.
  const fore = new Map<number, { input: PackInput; next: number; damage: number; boundary: number[] }>()
  const back = new Map<number, { input: PackInput; next: number }>()

  for (const rel of tileFiles) {
    const path = join(SRC, rel)
    if (!existsSync(path)) continue
    const buf = await readFile(path)
    if (!isSpecFile(buf)) continue
    const spec = readSpecFile(buf)

    for (const entry of spec.entries) {
      const id = parseInt(entry.name, 10)
      if (!Number.isFinite(id)) continue

      if (entry.type === SpecType.FORETILE) {
        const tile = readForeTile(buf, entry.offset)
        fore.set(id, {
          input: {
            key: String(id),
            width: tile.image.width,
            height: tile.image.height,
            rgba: toRGBA(tile.image, palette, true),
          },
          next: tile.next,
          damage: tile.damage,
          boundary: tile.boundary,
        })
      } else if (entry.type === SpecType.BACKTILE) {
        const tile = readBackTile(buf, entry.offset)
        back.set(id, {
          input: {
            key: String(id),
            width: tile.image.width,
            height: tile.image.height,
            rgba: toRGBA(tile.image, palette, false),
          },
          next: tile.next,
        })
      }
    }
  }

  const buildSet = async (
    set: Map<number, { input: PackInput; next: number; damage?: number; boundary?: number[] }>,
    prefix: string,
    baseW: number,
    baseH: number,
  ) => {
    const items = [...set.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.input)
    const cellW = Math.max(baseW, ...items.map((i) => i.width))
    const cellH = Math.max(baseH, ...items.map((i) => i.height))
    const atlas = packGrid(items, cellW, cellH)

    await mkdir(join(OUT, 'tiles'), { recursive: true })
    const pages: string[] = []
    for (let i = 0; i < atlas.pages.length; i++) {
      const file = `tiles/${prefix}-${i}.png`
      await writePage(atlas.pages[i], join(OUT, file))
      pages.push(file)
    }

    const tiles: Record<string, TileMeta> = {}
    let shaped = 0
    for (const rect of atlas.rects) {
      const src = set.get(Number(rect.key))!
      const bb = src.boundary ? boundaryBox(src.boundary) : undefined

      // Only ship per-column spans when they say something the box does not.
      let cols: (number[] | null)[] | undefined
      if (bb && src.boundary && src.boundary.length >= 6) {
        const spans = boundarySpans(src.boundary, rect.width)
        if (!isFullRect(spans, rect.height)) {
          cols = spans
          shaped++
        }
      }

      tiles[rect.key] = {
        p: rect.page,
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        next: src.next,
        ...(src.damage ? { damage: src.damage } : {}),
        ...(bb ? { bb } : {}),
        ...(cols ? { cols } : {}),
        ...(src.boundary && src.boundary.length ? { boundary: src.boundary } : {}),
      }
    }
    return { pages, tiles, count: items.length, shaped }
  }

  // Cell size comes from tile 0 in the engine (loader2.cpp:453): 30x15 fg,
  // 60x30 bg. A few foretiles are 30x18 and simply overflow downward.
  const foreOut = await buildSet(fore, 'fore', 30, 15)
  const backOut = await buildSet(back, 'back', 60, 30)

  await writeJSON(join(OUT, 'tiles.json'), {
    fore: { cellW: 30, cellH: 15, pages: foreOut.pages, tiles: foreOut.tiles },
    back: { cellW: 60, cellH: 30, pages: backOut.pages, tiles: backOut.tiles },
  })

  return {
    fore: foreOut.count,
    back: backOut.count,
    shaped: foreOut.shaped,
    pages: foreOut.pages.length + backOut.pages.length,
  }
}

/* ------------------------------------------------------------------ */
/* characters + loose images                                           */
/* ------------------------------------------------------------------ */

async function convertSprites(
  palette: Buffer,
  characters: CharacterDef[],
  editorOnlyDrawFuns: Set<string>,
) {
  const specFiles = await listFiles(SRC, '.spe')

  const frameInputs: PackInput[] = []
  const frameExtra = new Map<string, { xcfg: number; advance: number; hitDamage: number }>()
  const imageInputs: PackInput[] = []
  const standalone: { key: string; file: string; width: number; height: number; rgba: Buffer }[] = []

  for (const path of specFiles) {
    const buf = await readFile(path)
    if (!isSpecFile(buf)) continue
    let spec: SpecFile
    try {
      spec = readSpecFile(buf)
    } catch {
      continue
    }
    // Level files carry no sprite art.
    if (spec.byName.has('fgmap')) continue

    const id = assetId(path)
    const seen = new Set<string>()

    for (const entry of spec.entries) {
      const isFigure = entry.type === SpecType.CHARACTER || entry.type === SpecType.CHARACTER2
      const isImage = entry.type === SpecType.IMAGE
      if (!isFigure && !isImage) continue

      const key = `${id}#${entry.name}`
      if (seen.has(key)) continue
      seen.add(key)

      try {
        if (isFigure) {
          const fig = readFigure(buf, entry.offset, entry.type)
          if (fig.image.width === 0 || fig.image.height === 0) continue
          frameInputs.push({
            key,
            width: fig.image.width,
            height: fig.image.height,
            rgba: toRGBA(fig.image, palette, true),
          })
          frameExtra.set(key, { xcfg: fig.xcfg, advance: fig.advance, hitDamage: fig.hitDamage })
        } else {
          const img = readImage(buf, entry.offset)
          if (img.width === 0 || img.height === 0) continue
          const rgba = toRGBA(img, palette, false)
          if (img.width > STANDALONE_THRESHOLD || img.height > STANDALONE_THRESHOLD) {
            const file = `images/${id.replace(/[^\w]/g, '_')}__${entry.name.replace(/[^\w]/g, '_')}.png`
            standalone.push({ key, file, width: img.width, height: img.height, rgba })
          } else {
            imageInputs.push({ key, width: img.width, height: img.height, rgba })
          }
        }
      } catch {
        // Truncated or otherwise unreadable record - skip it rather than
        // failing the whole conversion.
      }
    }
  }

  const write = async (inputs: PackInput[], prefix: string, dir: string) => {
    const atlas = packShelves(inputs)
    await mkdir(join(OUT, dir), { recursive: true })
    const pages: string[] = []
    for (let i = 0; i < atlas.pages.length; i++) {
      const file = `${dir}/${prefix}-${i}.png`
      await writePage(atlas.pages[i], join(OUT, file))
      pages.push(file)
    }
    return { atlas, pages }
  }

  const frames = await write(frameInputs, 'chars', 'chars')
  const images = await write(imageInputs, 'img', 'images')

  await mkdir(join(OUT, 'images'), { recursive: true })
  for (const s of standalone) {
    await writePage({ width: s.width, height: s.height, rgba: s.rgba }, join(OUT, s.file))
  }

  // [page, x, y, w, h, xcfg, advance]
  const frameTable: Record<string, number[]> = {}
  for (const rect of frames.atlas.rects) {
    const extra = frameExtra.get(rect.key)!
    frameTable[rect.key] = [rect.page, rect.x, rect.y, rect.width, rect.height, extra.xcfg, extra.advance]
  }

  const imageTable: Record<string, number[] | string> = {}
  for (const rect of images.atlas.rects) {
    imageTable[rect.key] = [rect.page, rect.x, rect.y, rect.width, rect.height]
  }
  for (const s of standalone) imageTable[s.key] = s.file

  const characterTable: Record<
    string,
    { file: string; range?: [number, number]; states: Record<string, string[]>; editorOnly?: true }
  > = {}
  let unresolved = 0
  let editorOnly = 0
  for (const c of characters) {
    const states: Record<string, string[]> = {}
    for (const [state, names] of Object.entries(c.states)) {
      const resolved = names.filter((n) => frameTable[`${c.file}#${n}`] !== undefined)
      unresolved += names.length - resolved.length
      if (resolved.length) states[state] = resolved
    }
    if (Object.keys(states).length) {
      const hidden = c.drawFun !== undefined && editorOnlyDrawFuns.has(c.drawFun)
      if (hidden) editorOnly++
      characterTable[c.name] = {
        file: c.file,
        ...(c.range ? { range: c.range } : {}),
        states,
        ...(hidden ? { editorOnly: true as const } : {}),
      }
    }
  }

  await writeJSON(join(OUT, 'chars.json'), {
    pages: frames.pages,
    frames: frameTable,
    characters: characterTable,
  })
  await writeJSON(join(OUT, 'images.json'), { pages: images.pages, images: imageTable })

  return {
    frames: frames.atlas.rects.length,
    framePages: frames.pages.length,
    images: images.atlas.rects.length + standalone.length,
    imagePages: images.pages.length,
    standalone: standalone.length,
    characters: Object.keys(characterTable).length,
    editorOnly,
    unresolved,
  }
}

/* ------------------------------------------------------------------ */
/* levels                                                              */
/* ------------------------------------------------------------------ */

/**
 * Per-object fields worth carrying over. The velocity slots are not physics
 * here: level objects reuse them as configuration - AMBIENT_SOUND keeps its
 * repeat delay in `xvel`, its volume in `yvel` and its random spread in
 * `xacel` (lisp/sfx.lsp, ambs_cons).
 */
const OBJECT_FIELDS = [
  'x',
  'y',
  'direction',
  'hp',
  'aistate',
  'aitype',
  'flags',
  'active',
  'xvel',
  'yvel',
  'xacel',
  'yacel',
] as const

async function convertLevels() {
  const specFiles = await listFiles(SRC, '.spe')
  await mkdir(join(OUT, 'levels'), { recursive: true })

  const index: { id: string; name: string; width: number; height: number; objects: number }[] = []
  let lightCount = 0

  for (const path of specFiles) {
    const buf = await readFile(path)
    if (!isSpecFile(buf)) continue
    let spec: SpecFile
    try {
      spec = readSpecFile(buf)
    } catch {
      continue
    }
    const fgEntry = spec.byName.get('fgmap')
    if (!fgEntry) continue

    const id = assetId(path).replace(/\.spe$/, '')
    try {
      const level = readLevel(spec, buf, id)
      await writeJSON(join(OUT, 'levels', `${id.split('/').join('__')}.json`), level)
      index.push({
        id,
        name: level.firstName,
        width: level.fg.w,
        height: level.fg.h,
        objects: level.objects.length,
      })
      lightCount += level.lighting.lights.length
    } catch (err) {
      console.warn(`  ! level ${id}: ${(err as Error).message}`)
    }
  }

  index.sort((a, b) => a.id.localeCompare(b.id))
  await writeJSON(join(OUT, 'levels.json'), index)
  return { levels: index.length, lights: lightCount }
}

function readLevel(spec: SpecFile, buf: Buffer, id: string) {
  const fg = readTileMap(buf, spec.byName.get('fgmap')!.offset)
  const bgEntry = spec.byName.get('bgmap')
  const bg = bgEntry
    ? readTileMap(buf, bgEntry.offset)
    : { width: Math.floor(fg.width / 8) + 8, height: Math.floor(fg.height / 8) + 8, cells: new Uint16Array(0) }

  let firstName = basename(id)
  const nameEntry = spec.byName.get('first name')
  if (nameEntry) {
    const len = buf.readUInt8(nameEntry.offset)
    firstName = buf.toString('latin1', nameEntry.offset + 1, nameEntry.offset + 1 + len).replace(/\0+$/, '')
  }

  // Defaults from level.cpp: 1/8 in both axes.
  let bgScroll = { xmul: 1, xdiv: 8, ymul: 1, ydiv: 8 }
  const scrollEntry = spec.byName.get('bg_scroll_rate')
  if (scrollEntry && scrollEntry.size >= 17) {
    const v = readTaggedArray(buf, scrollEntry.offset, 4)
    bgScroll = { xmul: v[0], xdiv: v[1] || 1, ymul: v[2], ydiv: v[3] || 1 }
  }

  const objects = readObjects(spec, buf)

  const lightEntry = spec.byName.get('lights')
  const lighting = lightEntry
    ? readLightList(buf, lightEntry.offset)
    : { minLight: 63, lights: [] }

  return {
    id,
    firstName,
    fg: { w: fg.width, h: fg.height, cells: base64OfU16(fg.cells) },
    bg: { w: bg.width, h: bg.height, cells: base64OfU16(bg.cells) },
    bgScroll,
    lighting,
    objects,
  }
}

interface LevelObject {
  type: string
  state: string
  x: number
  y: number
  direction: number
  hp: number
  aistate: number
  aitype: number
  xvel: number
  yvel: number
  xacel: number
}

function readObjects(spec: SpecFile, buf: Buffer): LevelObject[] {
  const descEntry = spec.byName.get('object_descripitions')
  const namesEntry = spec.byName.get('describe_names')
  const listEntry = spec.byName.get('object_list')
  const typeEntry = spec.byName.get('type')
  if (!descEntry || !namesEntry || !listEntry || !typeEntry) return []

  const typeCount = buf.readInt16LE(descEntry.offset)
  if (typeCount <= 0) return []
  const typeNames = readNameList(buf, namesEntry.offset, typeCount).names

  // Per-type state name tables, so an object's state index becomes a name.
  const stateNames: string[][] = []
  const statesEntry = spec.byName.get('describe_states')
  if (statesEntry) {
    let p = statesEntry.offset
    for (let i = 0; i < typeCount; i++) {
      const n = buf.readInt16LE(p)
      p += 2
      const list = readNameList(buf, p, n)
      p = list.end
      stateNames.push(list.names)
    }
  }

  const count = buf.readUInt32LE(listEntry.offset)
  if (count === 0) return []

  const types = readTaggedArray(buf, typeEntry.offset, count)
  const stateEntry = spec.byName.get('state')
  const states = stateEntry ? readTaggedArray(buf, stateEntry.offset, count) : new Array(count).fill(0)

  const fields: Partial<Record<(typeof OBJECT_FIELDS)[number], number[]>> = {}
  for (const name of OBJECT_FIELDS) {
    const entry = spec.byName.get(name)
    if (entry) {
      try {
        fields[name] = readTaggedArray(buf, entry.offset, count)
      } catch {
        /* field missing or malformed; leave undefined */
      }
    }
  }

  const out: LevelObject[] = []
  for (let i = 0; i < count; i++) {
    const t = types[i]
    const typeName = typeNames[t] ?? `type_${t}`
    const stateList = stateNames[t]
    out.push({
      type: typeName,
      state: stateList?.[states[i]] ?? 'stopped',
      x: fields.x?.[i] ?? 0,
      y: fields.y?.[i] ?? 0,
      direction: fields.direction?.[i] ?? 1,
      hp: fields.hp?.[i] ?? 0,
      aistate: fields.aistate?.[i] ?? 0,
      aitype: fields.aitype?.[i] ?? 0,
      xvel: fields.xvel?.[i] ?? 0,
      yvel: fields.yvel?.[i] ?? 0,
      xacel: fields.xacel?.[i] ?? 0,
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* sound                                                               */
/* ------------------------------------------------------------------ */

async function copySounds() {
  // The core set lives in sfx/, but addons ship their own alongside their art.
  const files = await listFiles(SRC, '.wav')
  const names: string[] = []
  for (const file of files) {
    const rel = assetId(file).replace(/^sfx\//, '')
    const dest = join(OUT, 'sfx', rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(file, dest)
    names.push(rel)
  }
  await writeJSON(join(OUT, 'sfx.json'), names)
  return names.length
}

/* ------------------------------------------------------------------ */

async function main() {
  const started = Date.now()
  if (!existsSync(SRC)) throw new Error(`missing ${SRC} - copy the Abuse data files there first`)

  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  console.log('reading palette + lisp definitions...')
  const palette = await loadPalette()
  const tints = await collectTints()
  const lisp = await scanLisp()
  await writeJSON(join(OUT, 'palette.json'), { base: Array.from(palette), tints })

  console.log(`converting tiles from ${lisp.tileFiles.length} tile files...`)
  const tiles = await convertTiles(palette, lisp.tileFiles)

  console.log(`converting sprites (${lisp.characters.length} character definitions)...`)
  const sprites = await convertSprites(palette, lisp.characters, lisp.editorOnlyDrawFuns)

  console.log('converting levels...')
  const levels = await convertLevels()

  console.log('copying sound effects...')
  const sounds = await copySounds()
  await writeJSON(join(OUT, 'sounds.json'), {
    named: lisp.sounds.named,
    ambient: lisp.sounds.arrays.AMB_SOUNDS ?? [],
    arrays: lisp.sounds.arrays,
  })
  await writeJSON(join(OUT, 'messages.json'), { train: lisp.trainMessages })

  console.log(
    [
      '',
      'done in ' + ((Date.now() - started) / 1000).toFixed(1) + 's',
      `  foreground tiles : ${tiles.fore} (${tiles.shaped} ramps/shaped)`,
      `  background tiles : ${tiles.back}`,
      `  tile atlas pages : ${tiles.pages}`,
      `  character frames : ${sprites.frames} on ${sprites.framePages} page(s)`,
      `  characters       : ${sprites.characters} (${sprites.editorOnly} editor-only)` +
        (sprites.unresolved ? ` (${sprites.unresolved} frame refs unresolved)` : ''),
      `  loose images     : ${sprites.images} (${sprites.standalone} standalone)`,
      `  levels           : ${levels.levels} (${levels.lights} light sources)`,
      `  sound effects    : ${sounds} files, ${Object.keys(lisp.sounds.named).length} named` +
        `, ${(lisp.sounds.arrays.AMB_SOUNDS ?? []).filter(Boolean).length}/17 ambient`,
      `  palette tints    : ${Object.keys(tints).length}`,
      `  train messages   : ${Object.keys(lisp.trainMessages).length}`,
    ].join('\n'),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

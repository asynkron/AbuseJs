/**
 * Cuts the cop's frames back out of the packed atlas, one PNG each.
 *
 *   npx tsx tools/export-sprites.ts [--tints] [--sheet] [--out DIR]
 *
 * The build packs every character into two atlas pages and records where each
 * frame landed (tools/convert.ts). This walks that record backwards: for each
 * frame of each of the cop's characters it crops the page and writes a file.
 *
 * The cop is drawn as two halves, so "the player" is seven characters, not one:
 * DARNEL is the legs and carries all the animation, and each weapon has its own
 * torso of 24 aim frames covering the circle. They are exported side by side
 * because a frame of one is meaningless without the other.
 *
 * `NEXT_LEVEL_TOP` is skipped despite the name - it is the exit sign, not
 * something the cop wears.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import type { CharsManifest, FrameMeta } from '../src/assets/types'

const ASSETS = path.resolve('public/assets')

/** The legs, which carry every animation state. */
const BOTTOM = 'DARNEL'

/** One torso per weapon, in the order the weapon slots are numbered. */
const TOPS = ['MGUN_TOP', 'GRENADE_TOP', 'ROCKET_TOP', 'FIREBOMB_TOP', 'PGUN_TOP', 'DFRIS_TOP']

interface Options {
  readonly out: string
  readonly tints: boolean
  readonly sheet: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'export/player'
  return {
    out: path.resolve(out),
    tints: argv.includes('--tints'),
    sheet: argv.includes('--sheet'),
  }
}

/** Whole-pixel zoom for the contact sheet. Nearest neighbour, so it stays pixel art. */
const SHEET_ZOOM = 3

/** What one exported frame was, so the set can be put back together. */
interface FrameRecord {
  file: string
  state: string
  index: number
  /** Original name in the .spe, which is how the scripts refer to it. */
  source: string
  width: number
  height: number
  /**
   * `x_center`: the anchor's distance from the left edge. The engine draws a
   * frame at `x - x_center`, and mirrors it as `x - (width - x_center - 1)`, so
   * without this a frame cannot be placed - and the two halves cannot be lined
   * up against each other.
   */
  xcenter: number
  /** Pixels the character is moved when this frame plays. Usually 0. */
  advance: number
}

/**
 * A contact sheet, one row per state, at a single scale.
 *
 * Scaling each frame to fill a fixed box - the obvious way, and the first one
 * tried - is actively misleading: Abuse crops every frame tight to its own
 * pixels, so a climbing pose is 19x42 where a running one is 24x29, and fitting
 * both to the same square scales them differently. They come out looking
 * stretched against each other when nothing is wrong with them.
 *
 * So everything gets the same whole-pixel zoom, and frames are laid out on the
 * anchor the engine uses rather than on their own edges: `x_center` on a common
 * column, feet on a common baseline. Lined up that way a walk cycle reads as a
 * walk cycle instead of as a row of jittering cut-outs.
 */
async function contactSheet(
  out: string,
  rows: readonly { label: string; frames: readonly FrameRecord[] }[],
): Promise<void> {
  const zoom = SHEET_ZOOM
  const cellW = Math.max(...rows.flatMap((r) => r.frames.map((f) => f.width))) * zoom + 8
  const cellH = Math.max(...rows.flatMap((r) => r.frames.map((f) => f.height))) * zoom + 8
  const columns = Math.max(...rows.map((r) => r.frames.length))
  const width = columns * cellW
  const height = rows.length * cellH

  const composites: sharp.OverlayOptions[] = []
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].frames.length; c++) {
      const frame = rows[r].frames[c]
      const scaled = await sharp(path.join(out, frame.file))
        .resize({ width: frame.width * zoom, height: frame.height * zoom, kernel: 'nearest' })
        .png()
        .toBuffer()
      composites.push({
        input: scaled,
        // The anchor sits a third of the way across the cell and on its floor,
        // which is where the engine would have put it.
        left: Math.round(c * cellW + cellW / 3 - frame.xcenter * zoom),
        top: Math.round((r + 1) * cellH - 4 - frame.height * zoom),
      })
    }
  }

  const file = path.join(out, '_contact-sheet.png')
  await sharp({
    create: { width, height, channels: 4, background: { r: 24, g: 26, b: 32, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toFile(file)
  console.log(`contact sheet ${width}x${height} -> ${path.relative(process.cwd(), file)}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(
    await readFile(path.join(ASSETS, 'chars.json'), 'utf8'),
  ) as CharsManifest

  // Atlas pages, decoded once and kept - re-opening per frame turns a two
  // second job into a two minute one.
  const pages = await Promise.all(
    manifest.pages.map(async (page) => {
      const image = sharp(path.join(ASSETS, page))
      const { width, height } = await image.metadata()
      return { raw: await image.ensureAlpha().raw().toBuffer(), width: width ?? 0, height: height ?? 0 }
    }),
  )

  const wanted = [BOTTOM, ...TOPS]
  const records: FrameRecord[] = []
  let written = 0

  for (const name of wanted) {
    const character = manifest.characters[name]
    if (!character) {
      console.warn(`skipped ${name}: not in the manifest`)
      continue
    }

    // The base art, plus the colour variants when asked for. A variant is the
    // same frame decoded against a different palette, so it has the same name
    // under a `@n` prefix.
    const variants = options.tints
      ? [character.file, ...(manifest.tintArrays[character.tints ?? '']?.flatMap((baked, i) =>
          baked ? [`${character.file}@${i}`] : [],
        ) ?? [])]
      : [character.file]

    for (const file of variants) {
      const suffix = file === character.file ? '' : `-tint${file.split('@')[1]}`

      for (const [state, frames] of Object.entries(character.states)) {
        const dir = path.join(options.out, `${name}${suffix}`, state)
        await mkdir(dir, { recursive: true })

        for (let i = 0; i < frames.length; i++) {
          const meta = manifest.frames[`${file}#${frames[i]}`] as FrameMeta | undefined
          if (!meta) {
            console.warn(`missing frame ${file}#${frames[i]}`)
            continue
          }

          const [page, x, y, w, h, xcfg, advance] = meta
          const source = pages[page]
          if (!source) continue

          // Crop straight out of the decoded page rather than through sharp's
          // pipeline: the frames are tiny and there are hundreds of them.
          const out = Buffer.alloc(w * h * 4)
          for (let row = 0; row < h; row++) {
            const from = ((y + row) * source.width + x) * 4
            source.raw.copy(out, row * w * 4, from, from + w * 4)
          }

          const stem = frames[i].replace(/\.pcx$/i, '')
          const file_ = path.join(dir, `${String(i).padStart(2, '0')}_${stem}.png`)
          await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file_)

          records.push({
            file: path.relative(options.out, file_),
            state,
            index: i,
            source: frames[i],
            width: w,
            height: h,
            xcenter: xcfg,
            advance,
          })
          written++
        }
      }
    }
  }

  await writeFile(
    path.join(options.out, 'frames.json'),
    `${JSON.stringify({ frames: records }, null, 2)}\n`,
  )

  if (options.sheet) {
    const byRow = new Map<string, FrameRecord[]>()
    for (const record of records) {
      // `DARNEL/running/00_x.png` -> `DARNEL/running`
      const key = path.dirname(record.file)
      const list = byRow.get(key)
      if (list) list.push(record)
      else byRow.set(key, [record])
    }
    await contactSheet(
      options.out,
      [...byRow].map(([label, frames]) => ({ label, frames })),
    )
  }

  console.log(`${written} PNGs -> ${options.out}`)
  console.log(`  ${BOTTOM}: legs, every animation state`)
  console.log(`  ${TOPS.length} torsos: 24 aim frames each`)
  console.log('  frames.json carries x_center and advance, which placement needs')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

/**
 * Minimal shelf bin packer plus RGBA page compositing.
 *
 * Shelf packing (sort by descending height, fill rows left to right, start a
 * new row when the current one is full) wastes a few percent versus max-rects
 * but is short and predictable. The whole Abuse character set is ~2.2M pixels,
 * so it lands in a single 2048x2048 page either way.
 */

import sharp from 'sharp'

export interface PackInput {
  key: string
  width: number
  height: number
  /** RGBA, width*height*4 bytes. */
  rgba: Buffer
}

export interface PackedRect {
  key: string
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface PackedAtlas {
  rects: PackedRect[]
  pages: { width: number; height: number; rgba: Buffer }[]
}

const PADDING = 1

export function packShelves(items: PackInput[], maxSize = 2048): PackedAtlas {
  const sorted = [...items].sort((a, b) => b.height - a.height || b.width - a.width)

  const rects: PackedRect[] = []
  const pages: { width: number; height: number; rgba: Buffer }[] = []

  let page = -1
  let cursorX = 0
  let cursorY = 0
  let shelfHeight = 0
  let pageHeight = 0

  const startPage = () => {
    page++
    cursorX = 0
    cursorY = 0
    shelfHeight = 0
    pageHeight = 0
  }
  startPage()

  for (const item of sorted) {
    if (item.width > maxSize || item.height > maxSize) {
      throw new Error(`${item.key} (${item.width}x${item.height}) exceeds page size ${maxSize}`)
    }

    if (cursorX + item.width > maxSize) {
      // Next shelf.
      cursorX = 0
      cursorY += shelfHeight + PADDING
      shelfHeight = 0
    }
    if (cursorY + item.height > maxSize) {
      pages.push(makePage(maxSize, pageHeight))
      startPage()
    }

    rects.push({ key: item.key, page, x: cursorX, y: cursorY, width: item.width, height: item.height })
    cursorX += item.width + PADDING
    shelfHeight = Math.max(shelfHeight, item.height)
    pageHeight = Math.max(pageHeight, cursorY + item.height)
  }

  pages.push(makePage(maxSize, pageHeight))

  // Composite now that page dimensions are known.
  const byKey = new Map(items.map((i) => [i.key, i]))
  for (const rect of rects) {
    blit(pages[rect.page], byKey.get(rect.key)!, rect.x, rect.y)
  }

  return { rects, pages }
}

/**
 * Uniform grid layout, for fixed-size tile sets. Cheaper to reason about than
 * shelves and keeps tile lookups cache-friendly.
 */
export function packGrid(
  items: PackInput[],
  cellWidth: number,
  cellHeight: number,
  maxSize = 2048,
): PackedAtlas {
  const cols = Math.max(1, Math.floor(maxSize / cellWidth))
  const rowsPerPage = Math.max(1, Math.floor(maxSize / cellHeight))
  const perPage = cols * rowsPerPage

  const rects: PackedRect[] = []
  const pages: { width: number; height: number; rgba: Buffer }[] = []

  for (let start = 0; start < items.length; start += perPage) {
    const slice = items.slice(start, start + perPage)
    const rows = Math.ceil(slice.length / cols)
    const pageIndex = pages.length
    const pg = makePage(cols * cellWidth, rows * cellHeight)
    pages.push(pg)

    slice.forEach((item, i) => {
      const x = (i % cols) * cellWidth
      const y = Math.floor(i / cols) * cellHeight
      blit(pg, item, x, y)
      rects.push({ key: item.key, page: pageIndex, x, y, width: item.width, height: item.height })
    })
  }

  if (pages.length === 0) pages.push(makePage(1, 1))
  return { rects, pages }
}

function makePage(width: number, height: number) {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  return { width: w, height: h, rgba: Buffer.alloc(w * h * 4) }
}

function blit(
  page: { width: number; height: number; rgba: Buffer },
  item: PackInput,
  x: number,
  y: number,
) {
  for (let row = 0; row < item.height; row++) {
    const src = row * item.width * 4
    const dst = ((y + row) * page.width + x) * 4
    item.rgba.copy(page.rgba, dst, src, src + item.width * 4)
  }
}

export async function writePage(
  page: { width: number; height: number; rgba: Buffer },
  path: string,
): Promise<void> {
  await sharp(page.rgba, { raw: { width: page.width, height: page.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(path)
}

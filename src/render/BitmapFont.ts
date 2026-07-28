import { Container, Rectangle, Sprite, Texture } from 'pixi.js'

import type { GameAssets } from '../assets/loader'

/**
 * Abuse's bitmap fonts.
 *
 * A font is one image holding 256 glyphs in a fixed 32x8 grid, indexed by
 * character code, with the glyph size derived from the sheet
 * (src/imlib/fonts.cpp, `JCFont`):
 *
 *     size = (sheet + 1) / (32, 8)
 *
 * so art/fonts.spe#small_font is 160x56 -> 5x7 glyphs and art/letters.spe#letters
 * is 256x64 -> 8x8. Advance is the glyph width; these are fixed-pitch fonts.
 */

const COLUMNS = 32
const ROWS = 8

export class BitmapFont {
  readonly charWidth: number
  readonly charHeight: number

  private readonly glyphs: (Texture | null)[] = []

  private constructor(sheet: Texture) {
    this.charWidth = Math.floor((sheet.width + 1) / COLUMNS)
    this.charHeight = Math.floor((sheet.height + 1) / ROWS)

    for (let code = 0; code < COLUMNS * ROWS; code++) {
      const x = (code % COLUMNS) * this.charWidth
      const y = Math.floor(code / COLUMNS) * this.charHeight
      // The last row and column can run past the sheet by a pixel because of
      // the rounding above; clamp rather than produce an invalid frame.
      const w = Math.min(this.charWidth, sheet.width - x)
      const h = Math.min(this.charHeight, sheet.height - y)
      this.glyphs.push(
        w > 0 && h > 0
          ? new Texture({
              source: sheet.source,
              frame: new Rectangle(sheet.frame.x + x, sheet.frame.y + y, w, h),
            })
          : null,
      )
    }
  }

  /** Returns null when the font image is missing from the manifest. */
  static from(assets: GameAssets, key: string): BitmapFont | null {
    const sheet = assets.imageTexture(key)
    return sheet ? new BitmapFont(sheet) : null
  }

  measure(text: string): { width: number; height: number } {
    const lines = text.split('\n')
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
    return { width: longest * this.charWidth, height: lines.length * this.charHeight }
  }

  /**
   * Renders text into a container, reusing its existing sprites so this can be
   * called every frame without allocating.
   */
  render(target: Container, text: string): void {
    let index = 0
    let x = 0
    let y = 0

    for (const char of text) {
      if (char === '\n') {
        x = 0
        y += this.charHeight
        continue
      }

      const glyph = this.glyphs[char.charCodeAt(0) & 0xff]
      if (glyph) {
        let sprite = target.children[index] as Sprite | undefined
        if (!sprite) {
          sprite = new Sprite()
          target.addChild(sprite)
        }
        sprite.texture = glyph
        sprite.position.set(x, y)
        sprite.visible = true
        index++
      }

      x += this.charWidth
    }

    for (let i = index; i < target.children.length; i++) target.children[i].visible = false
  }
}

import { Container, Graphics } from 'pixi.js'

import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { BitmapFont } from '../render/BitmapFont'

/**
 * The tutorial lines Abuse shows as you walk past them.
 *
 * TRAIN_MSG objects are invisible markers whose `aitype` indexes a table of
 * strings in the language file (lisp/english.lsp, `get_train_msg`). The
 * original fires them when the player enters the marker's range and leaves the
 * text up for a while; this does the same with a fixed radius and a linger
 * timer, rendered in the game's own small font.
 */

const TRIGGER_RADIUS_X = 120
const TRIGGER_RADIUS_Y = 90
/** How long a message stays up once triggered, in ticks. */
const LINGER_TICKS = 240
const PADDING = 4

interface Marker {
  x: number
  y: number
  text: string
}

export class TrainMessages {
  /** Screen-space overlay; add above the world, below the HUD. */
  readonly container = new Container()

  private readonly markers: Marker[] = []
  private readonly backdrop = new Graphics()
  private readonly glyphs = new Container()
  private readonly font: BitmapFont | null

  private current: string | null = null
  private timer = 0

  constructor(assets: GameAssets, objects: LevelObjectData[], messages: Record<number, string>) {
    this.font = BitmapFont.from(assets, 'art/fonts.spe#small_font')

    for (const object of objects) {
      if (object.type !== 'TRAIN_MSG') continue
      const text = messages[object.aitype]
      if (text) this.markers.push({ x: object.x, y: object.y, text })
    }

    this.container.addChild(this.backdrop, this.glyphs)
    this.container.visible = false
  }

  /**
   * Shows a line the world worked out for itself, rather than one a marker in
   * the level carries. Used for the "press down to..." prompts, which have no
   * TRAIN_MSG behind them - the levels expect you to already know.
   */
  prompt(text: string): void {
    if (text !== this.current) {
      this.current = text
      this.draw(text)
    }
    this.timer = LINGER_TICKS
  }

  update(playerX: number, playerY: number): void {
    for (const marker of this.markers) {
      if (Math.abs(marker.x - playerX) > TRIGGER_RADIUS_X) continue
      if (Math.abs(marker.y - playerY) > TRIGGER_RADIUS_Y) continue
      if (marker.text !== this.current) {
        this.current = marker.text
        this.draw(marker.text)
      }
      this.timer = LINGER_TICKS
      break
    }

    if (this.timer > 0) {
      this.timer--
      if (this.timer === 0) {
        this.current = null
        this.container.visible = false
      }
    }
  }

  /**
   * Centres the message near the top of the view, where the original shows its
   * help text. Sits above the lighting overlay, so it works in device pixels
   * and scales itself.
   */
  layout(viewWidth: number, viewHeight: number, zoom: number): void {
    if (!this.container.visible || !this.font) return
    const size = this.font.measure(this.current ?? '')
    this.container.scale.set(zoom)
    this.container.position.set(
      Math.round(((viewWidth - size.width) / 2 - PADDING) * zoom),
      Math.round(Math.max(8, viewHeight * 0.12) * zoom),
    )
  }

  private draw(text: string): void {
    if (!this.font) return

    this.font.render(this.glyphs, text)
    this.glyphs.position.set(PADDING, PADDING)

    const size = this.font.measure(text)
    this.backdrop
      .clear()
      .rect(0, 0, size.width + PADDING * 2, size.height + PADDING * 2)
      .fill({ color: 0x000000, alpha: 0.55 })

    this.container.visible = true
  }

  get count(): number {
    return this.markers.length
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}

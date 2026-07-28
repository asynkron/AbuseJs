import { Container, Sprite } from 'pixi.js'

import type { GameAssets } from '../assets/loader'
import type { Level } from '../game/Level'

export type TileKind = 'fore' | 'back'

/**
 * Draws one tile grid, instantiating sprites only for cells in view.
 *
 * Sprites are handed out of a pool in scan order each frame and the unused tail
 * is hidden, so panning never allocates and never churns the display list.
 * level12 is ~500x300 cells, far too many to build eagerly.
 */
export class TileLayer {
  readonly container = new Container()
  private readonly pool: Sprite[] = []
  private used = 0

  constructor(
    private readonly assets: GameAssets,
    private readonly level: Level,
    private readonly kind: TileKind,
    /** Only draw cells flagged as "above" (or only those not flagged). */
    private readonly aboveOnly: boolean | null = null,
  ) {}

  /** `viewX/viewY` is the top-left of the visible area in this layer's space. */
  update(viewX: number, viewY: number, viewW: number, viewH: number): void {
    const level = this.level
    const isFore = this.kind === 'fore'
    const cellW = isFore ? level.tileW : level.backW
    const cellH = isFore ? level.tileH : level.backH
    const cols = isFore ? level.fgWidth : level.bgWidth
    const rows = isFore ? level.fgHeight : level.bgHeight

    const x0 = Math.max(0, Math.floor(viewX / cellW))
    const y0 = Math.max(0, Math.floor(viewY / cellH))
    const x1 = Math.min(cols - 1, Math.floor((viewX + viewW) / cellW))
    const y1 = Math.min(rows - 1, Math.floor((viewY + viewH) / cellH))

    this.used = 0

    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (isFore && this.aboveOnly !== null && level.isAbove(cx, cy) !== this.aboveOnly) continue

        const id = isFore ? level.fgTile(cx, cy) : level.bgTile(cx, cy)
        // Tile 0 is the empty/black tile in both sets - nothing to draw.
        if (id <= 0) continue

        const texture = this.assets.tileTexture(this.kind, id)
        if (!texture) continue

        const sprite = this.take()
        sprite.texture = texture
        sprite.position.set(cx * cellW, cy * cellH)
      }
    }

    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false
  }

  private take(): Sprite {
    let sprite = this.pool[this.used]
    if (!sprite) {
      sprite = new Sprite()
      this.pool.push(sprite)
      this.container.addChild(sprite)
    }
    sprite.visible = true
    this.used++
    return sprite
  }

  get spriteCount(): number {
    return this.used
  }
}

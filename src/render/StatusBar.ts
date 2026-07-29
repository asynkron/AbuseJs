import { Container, Sprite } from 'pixi.js'

import type { GameAssets } from '../assets/loader'

/**
 * Abuse's status bar, drawn from the original art.
 *
 * Layout is taken from `status_bar::redraw` in src/statbar.cpp: the 320x32
 * `sbar` panel is centred along the bottom, health is three digits at
 * (+17, +11) drawn from the `bnum00..09` images, and weapon slots start at
 * (+40) stepping 34px with their ammo counts at (+52, +25) using the smaller
 * `bnum10..19` digits.
 *
 * Weapons and ammo stay empty until there are mechanics behind them; health
 * comes from the character's own `start_hp` ability.
 */

const PANEL_WIDTH = 320
const HEALTH_X = 17
const HEALTH_Y = 11
const WEAPON_X = 40
const WEAPON_STEP = 34
const AMMO_X = 52
const AMMO_Y = 25
/** bnum00..09 are the large digits; bnum10..19 the small ammo ones. */
const SMALL_DIGIT_OFFSET = 10
const MAX_WEAPONS = 8

export class StatusBar {
  readonly container = new Container()

  private readonly panel = new Sprite()
  private readonly healthDigits: Sprite[] = []
  private readonly weaponIcons: Sprite[] = []
  private lastWeaponKey = ''
  private readonly ammoDigits: Sprite[][] = []

  private panelHeight = 32
  private lastHealth = -1

  constructor(private readonly assets: GameAssets) {
    const sbar = assets.imageTexture('art/statbar.spe#sbar')
    if (sbar) {
      this.panel.texture = sbar
      this.panelHeight = sbar.height
    }
    this.container.addChild(this.panel)

    for (let i = 0; i < 3; i++) {
      const digit = new Sprite()
      digit.position.set(HEALTH_X + i * this.digitWidth(false), HEALTH_Y)
      this.healthDigits.push(digit)
      this.container.addChild(digit)
    }

    for (let slot = 0; slot < MAX_WEAPONS; slot++) {
      const icon = new Sprite()
      icon.position.set(WEAPON_X + slot * WEAPON_STEP, 0)
      icon.visible = false
      this.weaponIcons.push(icon)
      this.container.addChild(icon)

      const digits: Sprite[] = []
      for (let i = 0; i < 3; i++) {
        const digit = new Sprite()
        digit.position.set(AMMO_X + slot * WEAPON_STEP + i * this.digitWidth(true), AMMO_Y)
        digit.visible = false
        digits.push(digit)
        this.container.addChild(digit)
      }
      this.ammoDigits.push(digits)
    }

    this.container.visible = sbar !== null
  }

  private digitTexture(value: number, small: boolean) {
    const index = (small ? SMALL_DIGIT_OFFSET : 0) + value
    return this.assets.imageTexture(`art/statbar.spe#bnum${String(index).padStart(2, '0')}`)
  }

  private digitWidth(small: boolean): number {
    return this.digitTexture(0, small)?.width ?? 5
  }

  /**
   * Draws every weapon slot: the one in hand lit (`bweap`), the rest you are
   * carrying dimmed (`dweap`), and slots you have nothing for left blank.
   * Each shows its own magazine.
   */
  setWeapon(selected: number, magazines: readonly number[]): void {
    const key = `${selected}:${magazines.join(',')}`
    if (key === this.lastWeaponKey) return
    this.lastWeaponKey = key

    this.weaponIcons.forEach((icon, slot) => {
      // Slot 0 is the machine gun, which the cop always carries, so it stays
      // on the panel at zero rounds.
      const carried = slot === 0 || (magazines[slot] ?? 0) > 0
      if (!carried) {
        icon.visible = false
        this.ammoDigits[slot]?.forEach((d) => (d.visible = false))
        return
      }

      const set = slot === selected ? 'bweap' : 'dweap'
      const texture = this.assets.imageTexture(
        `art/statbar.spe#${set}${String(slot + 1).padStart(4, '0')}.pcx`,
      )
      icon.visible = texture !== null
      if (texture) icon.texture = texture

      const text = String(Math.max(0, Math.min(999, Math.round(magazines[slot] ?? 0))))
        .padStart(3, '0')
      this.ammoDigits[slot]?.forEach((sprite, i) => {
        const digit = this.digitTexture(Number(text[i]), true)
        if (digit) sprite.texture = digit
        sprite.visible = digit !== null
      })
    })
  }

  /** Health is 0..999; the panel shows exactly three digits like the original. */
  setHealth(health: number): void {
    const clamped = Math.max(0, Math.min(999, Math.round(health)))
    if (clamped === this.lastHealth) return
    this.lastHealth = clamped

    const text = String(clamped).padStart(3, '0')
    this.healthDigits.forEach((sprite, i) => {
      const texture = this.digitTexture(Number(text[i]), false)
      if (texture) sprite.texture = texture
      sprite.visible = texture !== null
    })
  }

  /** Centres the panel along the bottom of the view, at game scale. */
  layout(viewWidth: number, viewHeight: number, zoom: number): void {
    this.container.scale.set(zoom)
    this.container.position.set(
      Math.round(((viewWidth - PANEL_WIDTH) / 2) * zoom),
      Math.round((viewHeight - this.panelHeight) * zoom),
    )
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}

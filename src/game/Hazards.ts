import type { GameAssets } from '../assets/loader'
import { oneIn, TICK_SCALE } from './enemies/tuning'
import type { Prop } from './Prop'

/**
 * The stationary dangers of lisp/duong.lsp: contact mines, air mines, timed
 * bombs, lava and the lightning post. Each one is an inert Prop as far as
 * rendering goes - this drives the behaviour the scripts gave them.
 *
 * All of them are written as per-tick state machines against the original's
 * 15Hz clock, so each hazard steps through `carry += TICK_SCALE` and runs one
 * original tick's worth of logic per whole unit - the same trick Enemy uses
 * for its animation cursor.
 */

/** What the hazards need from the world. */
export interface HazardHost {
  /** The player's box, for `touching_bg`. */
  playerBox(): { x: number; y: number; halfWidth: number; height: number }
  /** Link 0's aistate is non-zero, or there is no link - `(activated)`. */
  isActivated(index: number): boolean
  /** `do_explo` - sound, fireballs, light and the blast. */
  explode(x: number, y: number, radius: number, amount: number): void
  /** `(do_damage n (bg))` - straight damage to the player, no push. */
  hurtPlayer(amount: number): void
  /** The lava flare's blast - `hurt_radius (x) (y) 20 20 nil 10`. */
  lavaBurst(x: number, y: number): void
  playSound(name: string, volume: number, x: number, y: number): void
  /** Takes the prop out of the world for good (an exploded mine or bomb). */
  remove(prop: Prop): void
}

/**
 * BOMB and BIG_BOMB tick only inside their `(range 150 150)` active window in
 * the original - being near the screen is what arms an unlinked one. The
 * original's window is the view rectangle grown by the range; this stands in
 * for it with a player-centred box of range plus half a classic 320x200 view.
 */
const BOMB_WAKE_X = 150 + 160
const BOMB_WAKE_Y = 150 + 100

/** `bomb_cons`. Levels can override it through the saved `blink_time` lvar. */
const BOMB_BLINK = 14

/** `mine_ai`'s blast: 40px, and 35 with the flash variant, 25 without. */
const MINE_BLAST = { radius: 40, flash: 35, plain: 25 } as const

/** `air_mine_ai`'s `do_explo 40 25`. */
const AIR_MINE_BLAST = { radius: 40, amount: 25 } as const

/** `lava_ai`: 6 damage every 20 ticks of contact, and a 1-in-100 flare. */
const LAVA = { damage: 6, damagePeriod: 20, flareChance: 100, flareTick: 5 } as const

abstract class Hazard {
  /** Fraction of an original tick accumulated - see the module note. */
  private carry = 0
  /** `state_time`, in original ticks, reset by `resetStateTime`. */
  protected stateTime = 0

  constructor(
    readonly prop: Prop,
    protected readonly host: HazardHost,
  ) {}

  /** Runs at 60Hz; dispenses original 15Hz-scale ticks to `step`. */
  update(): boolean {
    this.carry += TICK_SCALE
    while (this.carry >= 1) {
      this.carry -= 1
      this.stateTime++
      if (!this.step()) return false
    }
    return true
  }

  /** One original tick. Returning false removes the hazard (and its prop). */
  protected abstract step(): boolean

  protected resetStateTime(): void {
    this.stateTime = 0
  }

  /** `touching_bg` - the prop's picture box overlapping the player's. */
  protected touchingPlayer(): boolean {
    const box = this.prop.hitBox
    const player = this.host.playerBox()
    if (player.x + player.halfWidth < box.left || player.x - player.halfWidth > box.right)
      return false
    return player.y >= box.top && player.y - player.height <= box.bottom
  }

  /** `(activated)` for this prop's own links. */
  protected get activated(): boolean {
    return this.host.isActivated(this.prop.objectIndex)
  }

  /** `next_picture` over the prop's current state; false when it wraps. */
  protected nextPicture(): boolean {
    const total = this.prop.frameCount
    if (total <= 1) return false
    this.frame = (this.frame + 1) % total
    this.prop.setFrame(this.frame)
    return this.frame !== 0
  }

  protected setPropState(state: string): void {
    this.prop.setState(state, true)
    this.frame = 0
  }

  private frame = 0
}

/**
 * CONC - `mine_ai`. Blows its charge the first time the player touches it,
 * then sits there animating the spent shell. The `conc_flash` field lives in
 * `xvel`: 1 marks the variant that flashes the screen and hits harder.
 */
class ContactMine extends Hazard {
  private spent = false

  protected step(): boolean {
    if (!this.activated) return true

    if (this.spent) {
      this.nextPicture()
      return true
    }

    if (this.touchingPlayer()) {
      this.setPropState('running')
      const amount = this.prop.data.xvel === 1 ? MINE_BLAST.flash : MINE_BLAST.plain
      this.host.explode(this.prop.x, this.prop.y, MINE_BLAST.radius, amount)
      this.spent = true
    } else {
      this.nextPicture()
    }
    return true
  }
}

/** CONC_AIR - `air_mine_ai`. One touch, one blast, gone. */
class AirMine extends Hazard {
  protected step(): boolean {
    if (!this.activated) return true

    if (this.touchingPlayer()) {
      this.host.explode(this.prop.x, this.prop.y, AIR_MINE_BLAST.radius, AIR_MINE_BLAST.amount)
      return false
    }
    this.nextPicture()
    return true
  }
}

/**
 * BOMB and BIG_BOMB - `bomb_ai`. Waits for its link (or, unlinked, for the
 * player to come near - the original's `(range 150 150)` active window is
 * what arms it), then blinks down `blink_time` with an accelerating ticking
 * and lets go with `do_explo 40 jump_yvel` - 30 for the small one, 400 for
 * the big one.
 */
class Bomb extends Hazard {
  private phase: 'waiting' | 'blinking' = 'waiting'
  private blink: number

  constructor(
    prop: Prop,
    host: HazardHost,
    private readonly damage: number,
    /** Whether the level wired it to a switch, or it arms on proximity. */
    private readonly wired: boolean,
  ) {
    super(prop, host)
    this.blink = prop.data.lvars?.blink_time || BOMB_BLINK
  }

  protected step(): boolean {
    if (this.phase === 'waiting') {
      if (this.wired) {
        if (this.activated) this.phase = 'blinking'
        return true
      }
      const player = this.host.playerBox()
      if (
        Math.abs(player.x - this.prop.x) < BOMB_WAKE_X &&
        Math.abs(player.y - this.prop.y) < BOMB_WAKE_Y
      ) {
        this.phase = 'blinking'
      }
      return true
    }

    if (this.blink < 1) {
      // `(set_y (- (y) (/ (picture_height) 2)))` before the blast.
      const box = this.prop.hitBox
      const middle = (box.top + box.bottom) / 2
      this.host.explode(this.prop.x, middle, 40, this.damage)
      return false
    }

    const b = this.blink
    if (b < 10 || (b < 18 && b % 2 === 0) || (b < 30 && b % 3 === 0) || (b < 50 && b % 4 === 0)) {
      this.host.playSound('TICK_SND', 127, this.prop.x, this.prop.y)
      this.nextPicture()
    }
    this.blink--
    return true
  }
}

/**
 * LAVA - `lava_ai`. Standing in it costs 6 every 20 ticks, and now and then
 * it belches: LAVA_SND at the one non-full volume in the game, then a 20px
 * burst five ticks later.
 */
class Lava extends Hazard {
  private erupting = false

  protected step(): boolean {
    if (this.touchingPlayer() && this.stateTime % LAVA.damagePeriod === 0) {
      this.host.hurtPlayer(LAVA.damage)
    }

    if (!this.erupting) {
      if (oneIn(LAVA.flareChance)) {
        this.host.playSound('LAVA_SND', 64, this.prop.x, this.prop.y)
        this.erupting = true
        this.resetStateTime()
      }
    } else if (this.stateTime === LAVA.flareTick) {
      this.host.lavaBurst(this.prop.x, this.prop.y)
      this.erupting = false
      this.resetStateTime()
    }
    return true
  }
}

/**
 * LIGHTIN - `lightin_ai`. Waits `aitype * 2` ticks, then plays its nine-frame
 * bolt with ELECTRIC_SND and goes back to waiting. The `hurt_radius` in the
 * script is commented out, so it was already just a light show in 1996.
 */
class Lightning extends Hazard {
  private striking = false

  protected step(): boolean {
    if (!this.activated) return true

    if (!this.striking) {
      if (this.stateTime < this.prop.data.aitype * 2) {
        this.setPropState('stopped')
      } else {
        this.setPropState('running')
        this.host.playSound('ELECTRIC_SND', 127, this.prop.x, this.prop.y)
        this.striking = true
        this.resetStateTime()
      }
    } else if (!this.nextPicture()) {
      this.striking = false
      this.resetStateTime()
    }
    return true
  }
}

/** Builds a hazard for every prop of a type this module owns. */
export function buildHazards(
  assets: GameAssets,
  props: Prop[],
  links: number[][],
  host: HazardHost,
): Hazards {
  const hazards: Hazard[] = []

  for (const prop of props) {
    switch (prop.character) {
      case 'CONC':
        hazards.push(new ContactMine(prop, host))
        break
      case 'CONC_AIR':
        hazards.push(new AirMine(prop, host))
        break
      case 'BOMB':
      case 'BIG_BOMB': {
        // `(do_explo 40 (get_ability jump_yvel))` - the ability doubles as the
        // blast strength: 30 for BOMB, 400 for BIG_BOMB.
        const damage = assets.ability(prop.character, 'jump_yvel') ?? 30
        const wired = prop.objectIndex >= 0 && (links[prop.objectIndex] ?? []).length > 0
        hazards.push(new Bomb(prop, host, damage, wired))
        break
      }
      case 'LAVA':
      case 'LAVA2':
        hazards.push(new Lava(prop, host))
        break
      case 'LIGHTIN':
        hazards.push(new Lightning(prop, host))
        break
    }
  }

  return new Hazards(hazards, host)
}

export class Hazards {
  constructor(
    private readonly hazards: Hazard[],
    private readonly host: HazardHost,
  ) {}

  update(): void {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const hazard = this.hazards[i]
      if (hazard.prop.isDead || hazard.prop.isDying) {
        this.hazards.splice(i, 1)
        continue
      }
      if (!hazard.update()) {
        this.hazards.splice(i, 1)
        this.host.remove(hazard.prop)
      }
    }
  }
}

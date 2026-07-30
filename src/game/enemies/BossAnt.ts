import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { Enemy, type Battlefield } from './Enemy'
import { canSee, eyeY } from './raycast'
import { random, TICK_SCALE, ticks } from './tuning'
import type { PlayerView } from './types'
import { aimAngle, shotFrom } from './weapons'

/**
 * BOSS_ANT (lisp/ant.lsp, boss_ai) - six forms of one creature that teleports
 * between the objects it is linked to.
 *
 * Its health is pinned at 1 throughout, so the fight is not about damage: any
 * hit that lands while it is solid takes it to the next form, and each form
 * fires a nastier round than the last because `boss_fire` passes the aitype
 * straight to fire_object. Six hits and the game is over.
 */

const BOSS = {
  /** boss_fire's muzzle, and the ant's own lead on the player. */
  muzzleX: 17,
  muzzleY: 25,
  aimHeight: 15,
  leadTicksX: ticks(8),
  leadTicksY: ticks(2),

  /**
   * The first taunt's length, for a boss whose level saved none.
   *
   * `boss_cons` sets `taunt_time` to 20, but def_char BOSS_ANT never lists it
   * as the constructor (ant.lsp:734-736), so it never runs - which does not
   * matter, because every boss in the game saves its own `taunt_time` lvar
   * (17, 4, 22 and 25). Later taunts are 30 - aitype * 2 as usual.
   */
  firstTaunt: ticks(20),
  tauntPeriod: ticks(25),

  /** Seven ticks each way: fade_count runs 14 down or up in steps of 2. */
  fadeMax: 14,
  fadeStep: 14 / ticks(7),

  /** The last form ends the game with a minute of fireworks. */
  endgameTicks: ticks(60),
  endgameSoundPeriod: ticks(8),

  /** aitype 6 is one past the last form. */
  forms: 6,
} as const

/**
 * The aistate ladder. The original numbers them 0,1,2,3,4,5,6,7,10,11 and
 * reuses 3/5 and 4/6 as two identical wind-up-and-fire pairs, so it fires
 * twice per appearance.
 */
type BossPhase =
  | 'dormant'
  | 'taunting'
  | 'fadingIn'
  | 'windUpFirst'
  | 'fireFirst'
  | 'windUpSecond'
  | 'fireSecond'
  | 'fadingOut'
  | 'endgame'

export class BossAnt extends Enemy {
  private phase: BossPhase
  private replay = false

  private tauntTime: number
  /** 0 is solid and vulnerable; anything else is mid-fade and untouchable. */
  private fade = 0

  /** Which of the six forms it is wearing. Doubles as the weapon it fires. */
  private form: number

  constructor(assets: GameAssets, data: LevelObjectData, objectIndex: number, world: Battlefield) {
    super(assets, data, objectIndex, world)

    // art/boss.spe reuses the ant's proportions.
    this.halfWidth = 12
    this.height = 28

    this.form = data.aitype
    const savedTaunt = data.lvars?.taunt_time
    this.tauntTime = savedTaunt ? ticks(savedTaunt) : BOSS.firstTaunt
    this.phase = data.aistate === 0 ? 'dormant' : 'taunting'
    this.setState('hiding', true)
  }

  protected think(player: PlayerView): boolean {
    // fade_count is a render property in the original; here it is the alpha.
    this.sprite.alpha = 1 - this.fade / BOSS.fadeMax

    let passes = 3
    do {
      this.replay = false
      this.dispatch(player)
    } while (this.replay && passes-- > 0)

    return this.phase !== 'endgame' || this.stateTime <= BOSS.endgameTicks
  }

  private dispatch(player: PlayerView): void {
    switch (this.phase) {
      case 'dormant':
        return this.dormant()
      case 'taunting':
        return this.taunt()
      case 'fadingIn':
        return this.fadeIn(player)
      case 'windUpFirst':
        return this.windUp('fireFirst')
      case 'fireFirst':
        return this.fire(player, 'windUpSecond', 'weapon_fire')
      case 'windUpSecond':
        return this.windUp('fireSecond')
      case 'fireSecond':
        return this.fire(player, 'fadingOut', 'stopped')
      case 'fadingOut':
        return this.fadeOut()
      case 'endgame':
        return this.endgame()
    }
  }

  private setPhase(phase: BossPhase): void {
    this.phase = phase
    this.resetStateTime()
  }

  private goPhase(phase: BossPhase): void {
    this.setPhase(phase)
    this.replay = true
  }

  private dormant(): void {
    this.setState('hiding')
    if (this.activated) this.setPhase('taunting')
  }

  /** Invisible, and shouting about it, until the timer runs down. */
  private taunt(): void {
    if (this.tauntTime <= 0) {
      this.fade = BOSS.fadeMax
      this.setState('stopped')
      this.playSound('APPEAR_SND')
      this.setPhase('fadingIn')
      return
    }

    this.tauntTime--
    if (this.tauntTime % BOSS.tauntPeriod === 0) this.playSound('TAUNT_SND')
  }

  private fadeIn(player: PlayerView): void {
    this.direction = this.toward(player)
    if (this.fade <= 0) {
      this.fade = 0
      this.sprite.alpha = 1
      this.setState('weapon_fire')
      this.goPhase('windUpFirst')
      return
    }
    this.fade -= BOSS.fadeStep
  }

  /** Plays the four-frame `asht` out; the shot lands on the frame after. */
  private windUp(next: BossPhase): void {
    if (!this.nextPicture()) this.goPhase(next)
  }

  private fire(player: PlayerView, next: BossPhase, after: string): void {
    this.shootAt(player)
    this.setPhase(next)
    this.setState(after)
  }

  /**
   * Fades out, then warps to one of the objects it is linked to - that link
   * list is the set of positions the fight moves between.
   *
   * The script opens with `(if (total_objects) ... nil)`, which reads as
   * "remove an unlinked boss on its first tick". That is a harsh reading of a
   * test that may never have been false, so an unlinked boss stays where it
   * is here and simply never moves.
   */
  private fadeOut(): void {
    this.fade += BOSS.fadeStep
    if (this.fade < BOSS.fadeMax) return

    this.fade = BOSS.fadeMax
    this.setState('hiding')

    const links = this.linkedObjects
    if (links.length > 0) {
      const destination = this.world.level.objects[links[random(links.length)]]
      if (destination) this.setPosition(destination.x, destination.y)
    }

    // Later forms give you less time between appearances.
    this.tauntTime = ticks(30 - this.form * 2)
    this.goPhase('dormant')
  }

  /** aistate 10: a minute of explosions spreading out from the body. */
  private endgame(): void {
    this.setState('hiding')
    if (this.stateTime === 0) return

    if (this.stateTime % BOSS.endgameSoundPeriod === 0) this.playSound('GRENADE_SND')
    // The original drives the scatter off `state_time` directly, but its clock
    // only reaches 60 where ours reaches ticks(60); borrowing the raw count
    // would spread the fireworks half again as wide as the original's.
    const spread = this.stateTime * TICK_SCALE
    this.world.explode(this.x + random(spread * 2), this.y + random(spread))
    this.world.explode(this.x - random(spread * 2), this.y - random(spread))
  }

  private shootAt(player: PlayerView): void {
    const muzzleX = this.x + this.direction * BOSS.muzzleX
    const muzzleY = this.y - BOSS.muzzleY
    const targetX = player.x + player.vx * BOSS.leadTicksX
    const targetY = player.y - BOSS.aimHeight + player.vy * BOSS.leadTicksY
    const level = this.world.level

    if (!canSee(level, this.x, eyeY(this.y), muzzleX, muzzleY, this.world.sightBlockers())) return
    if (!canSee(level, muzzleX, muzzleY, targetX, targetY, this.world.sightBlockers())) return

    this.world.fire(
      shotFrom(this.form, muzzleX, muzzleY, aimAngle(muzzleX, muzzleY, targetX, targetY), this),
    )
    this.setState('weapon_fire')
  }

  /**
   * `boss_damage`: only lands while it is fully solid and out of its dormant
   * state, and then it is worth exactly one form rather than any health.
   *
   * The hit sends it to aistate 5, which the script comments as "fade out" but
   * which is actually the second wind-up - so a wounded boss squeezes off one
   * more round before it goes. The comment is stale; the code is followed.
   */
  override damage(_amount: number): boolean {
    if (this.fade !== 0) return false
    if (this.phase === 'dormant') return false
    // `(set_targetable nil)` is asserted every tick of the taunt (ant.lsp:663),
    // and only comes back on in aistate 3 - so the boss cannot be hit, or made
    // to skip a form, while it is still invisible and taunting.
    if (this.phase === 'taunting') return false
    if (this.form >= BOSS.forms) return false

    this.form++
    if (this.form >= BOSS.forms) {
      this.setPhase('endgame')
      return true
    }

    this.setPhase('windUpSecond')
    return false
  }
}

import { speed } from './enemies/tuning'
import type { BlastSource, Hurtable } from './effects/types'
import type { Player } from './Player'
import type { Prop } from './Prop'
import type { HitBox, ProjectileOwner, ProjectileTarget } from './weapons/index'

/**
 * Everything a shot or a blast can catch, in one shape.
 *
 * The original has no separate notion of "enemy fire" and "player fire".
 * `bmove` hits whatever is in the way and spares only the object that fired,
 * and `hurt_radius` walks every hurtable object in range including the cop -
 * which is why an ant can shoot another ant, why standing beside your own
 * grenade costs you health, and why one hidden wall going off kills its
 * neighbours. One list is what reproduces all three.
 *
 * It is three interfaces at once because a combatant plays three parts: a
 * `ProjectileTarget` for the thing a bullet crosses, a `Hurtable` for the
 * thing a blast reaches, and a `ProjectileOwner` for the shooter its own
 * rounds ignore.
 */
export interface Combatant extends ProjectileTarget, Hurtable, ProjectileOwner {}

/** What a combatant does with a hit; the world owns the consequences. */
export type DealDamage = (amount: number, from: BlastSource | null) => void

/**
 * A level object as the weapons see it.
 *
 * The height is measured off the drawn frame rather than read from `height`,
 * which Entity leaves at its 28px placeholder for everything that is not the
 * cop. `hurt_radius` measures to both ends of the target and keeps whichever
 * is nearer the blast, so a 60px turret's real height decides whether a blast
 * at its feet reaches it at all.
 */
export class PropCombatant implements Combatant {
  constructor(
    readonly prop: Prop,
    private readonly deal: (prop: Prop, amount: number, from: BlastSource | null) => void,
  ) {}

  get x(): number {
    return this.prop.x
  }

  get y(): number {
    return this.prop.y
  }

  get vx(): number {
    return this.prop.vx
  }

  get vy(): number {
    return this.prop.vy
  }

  get height(): number {
    const box = this.prop.hitBox
    return box.bottom - box.top
  }

  get hitBox(): HitBox {
    return this.prop.hitBox
  }

  get isDead(): boolean {
    return this.prop.isDead
  }

  get isDying(): boolean {
    return this.prop.isDying
  }

  /**
   * Knockback is dropped. Nothing the level places has a mover of its own -
   * a hidden wall shoved by its neighbour's blast would slide out of the wall
   * it is part of - so the impulse stops here.
   */
  hurt(amount: number, from: BlastSource | null): void {
    this.deal(this.prop, amount, from)
  }
}

/** The cop, wrapped so the same shot that hits a monster can hit him. */
export class PlayerCombatant implements Combatant {
  readonly isPlayer = true

  constructor(
    private readonly player: Player,
    private readonly deal: DealDamage,
  ) {}

  get x(): number {
    return this.player.x
  }

  get y(): number {
    return this.player.y
  }

  get vx(): number {
    return this.player.vx
  }

  get vy(): number {
    return this.player.vy
  }

  get height(): number {
    return this.player.height
  }

  get hitBox(): HitBox {
    const { x, y, halfWidth, height } = this.player
    return { left: x - halfWidth, top: y - height, right: x + halfWidth, bottom: y + 1 }
  }

  get isDead(): boolean {
    return this.player.isDead
  }

  get isDying(): boolean {
    return this.player.isDead
  }

  /**
   * The blast throws him. `hurt_radius`'s push is a velocity in the original's
   * units, so it converts like every other velocity in the game rather than by
   * the ratio of the tick rates: dividing by four instead left a grenade's
   * shove at well under half of this cop's own jump, where the original's
   * `max_push` of 20 against a `jump_yvel` of 15 plainly meant to lift him off
   * his feet.
   */
  hurt(amount: number, from: BlastSource | null, pushX: number, pushY: number): void {
    this.deal(amount, from)
    this.player.vx += speed(pushX)
    this.player.vy += speed(pushY)
  }
}

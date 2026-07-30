import type { SightBlocker } from './raycast'
import type { Level } from '../Level'
import type { Prop } from '../Prop'

/**
 * Everything the enemies need from the rest of the game, and nothing else.
 *
 * The AI never reaches into World: it is handed this on construction and asks
 * it for the four things a monster genuinely cannot do for itself - hurt or
 * shove the player, make a noise, and put an explosion somewhere.
 */
export interface EnemyContext {
  /**
   * The `can_block` objects a sight line is stopped by - closed doors, steps,
   * lifts and hidden walls. `can_see(..., nil)` tests these in the original;
   * see SightBlocker in raycast.ts.
   */
  sightBlockers(exclude?: Prop): Iterable<SightBlocker>
  readonly level: Level

  /**
   * Whether the object at this index is switched on - its `aistate` is
   * non-zero. Every dormant creature in Abuse wakes on
   * `(with_object (get_object 0) (aistate))`, which is the same signal
   * network the level logic settles for the doors and lifts.
   */
  isSignalOn(objectIndex: number): boolean

  /** Takes health off the player. Their own invulnerability window applies. */
  hurtPlayer(amount: number): void

  /**
   * Shoves the player horizontally - `push_char` in lisp/common.lsp. The
   * amount is signed and is a request to try to move, not a teleport: the
   * original calls `try_move` on the player so a wall still stops them.
   */
  pushPlayer(dx: number): void

  /**
   * Plays one of the AI's sounds at a world position. Volumes in the scripts
   * are all 127 out of 127, so none is passed; the caller decides what full
   * volume means.
   *
   * `ASML_DEATH` and `ALRG_DEATH` are arrays in lisp/sfx.lsp rather than
   * single samples - the implementation should pick one of their entries at
   * random, which is what `(aref ASML_DEATH (random 2))` does.
   */
  playSound(sound: EnemySound, x: number, y: number): void

  /**
   * Puts a one-shot explosion sprite at a world position.
   *
   * Cosmetic only, and only for the effects a creature emits while it is
   * alive - the sparks it throws off when hit, the boss's endgame cascade.
   * What a creature comes apart into when it dies is the host's business:
   * those are authored clusters with their own sounds, blasts and body parts
   * (`create_dead_parts`, `guner_damage`, `rob1_ai`) and the host has the
   * catalogue for them.
   *
   * `fireball` is EXPLODE1, the ordinary orange blast. `sparks` is EXPLODE6,
   * the small_fire puff `explo_damage` throws off a damaged machine.
   */
  explode(x: number, y: number, kind?: 'fireball' | 'sparks'): void

  /**
   * Drops a pickup character - `MBULLET_ICON5` and friends - where a monster
   * died. Optional: without it, nothing drops.
   */
  dropPickup?(character: string, x: number, y: number): void

  /**
   * A creature that came into being at runtime, e.g. out of an ANT_CRACK. It
   * is a Prop like any other level object, so it wants its sprite adding to
   * the display list and itself adding to whatever list bullets test against.
   */
  onSpawn?(enemy: Prop): void

  /** A creature that has left the world and should stop being drawn. */
  onRemove?(enemy: Prop): void

  /** An enemy shot. Origin, direction and payload; the flight is the caller's. */
  onFire?(shot: EnemyShot): void
}

/** What the AI is allowed to know about the cop. */
export interface PlayerView {
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly halfWidth: number
  readonly height: number
  /**
   * POWER_SNEAKY is up: nothing notices them. It does not call off a fight
   * already under way, which is why only the waking tests consult it.
   */
  readonly hidden?: boolean
}

/**
 * A round leaving an enemy's gun.
 *
 * Every enemy shot in the original goes through `fire_object (creator type x y
 * angle target)` in lisp/guns.lsp, where `type` is the shooter's own aitype -
 * so `aitype` and `shooter` are all a host with a real projectile system needs,
 * and it can ignore everything below them.
 *
 * The rest describes the round for a host that has no projectiles: damage,
 * blast, colour and sound, taken from the AIs `fire_object` spawns. Both
 * halves are here because the shape of the round is the same information
 * either way.
 */
export interface EnemyShot {
  x: number
  y: number
  /** Degrees, counter-clockwise, screen y downwards. */
  angle: number
  /** `fire_object`'s type argument, which for a monster is its own aitype. */
  aitype: number
  /** The creator: shots ignore it, and blasts spare it. */
  shooter?: Prop
  /** Damage to whatever it hits directly. */
  damage: number
  /** Blast, for the rounds that explode. Radius in pixels. */
  splash?: { radius: number; damage: number }
  /** Tracer colour, from the round's own `find_rgb` or gun tint. */
  colour: number
  sound: EnemySound
  /**
   * An exact launch velocity, in this game's units, for the shooters that set
   * one rather than letting `fire_object` derive it from the angle. Only the
   * jugger does: `jug_ai` adds a GRENADE and then overwrites its velocity with
   * `(throw_xvel * direction, throw_yvel)`, which is a much lazier arc than
   * `(set_course angle 20)` would give.
   */
  velocity?: { vx: number; vy: number }
}

/**
 * The sound symbols the enemy scripts play, exactly as lisp/sfx.lsp names
 * them. `ASML_DEATH` and `ALRG_DEATH` are arrays there rather than samples.
 */
export type EnemySound =
  | 'ASCREAM_SND'
  | 'ALAND_SND'
  | 'ASLASH_SND'
  | 'APAIN_SND'
  | 'ASML_DEATH'
  | 'ALRG_DEATH'
  | 'FLYER_SND'
  | 'JSTOMP_SND'
  | 'CLEANER_SND'
  | 'BLOWN_UP'
  | 'GRENADE_SND'
  | 'APPEAR_SND'
  | 'TAUNT_SND'
  | 'GRENADE_THROW'
  | 'ZAP_SND'
  | 'MGUN_SND'
  | 'ROCKET_LAUNCH_SND'
  | 'PLASMA_SND'
  | 'FIREBOMB_SND'
  | 'LSABER_SND'

/**
 * Per-object settings the levels keep in their `lvars` block.
 *
 * tools/convert.ts does not read that block, so none of these can be
 * recovered from the converted level JSON - `create_total`, `hide_flag`,
 * `stationary` and the flyer's whole burst configuration are invisible here.
 * Each creature falls back to its constructor's default from the scripts;
 * this is the seam to feed real values through once the converter learns the
 * format.
 */
export interface EnemyOverrides {
  /** ANT_CRACK: how many ants it has left to pour out. */
  createTotal?: number
  /** ANT_ROOF: 0 hangs from the ceiling in view, 1 starts invisible. */
  hideFlag?: 0 | 1
  /** JUGGER: non-zero makes it a turret that never walks. */
  stationary?: number
  /** JUGGER: grenade launch velocity, in original units. */
  throwXvel?: number
  throwYvel?: number
  /** FLYER family: ticks between bursts, between rounds, rounds per burst. */
  fireDelay?: number
  burstDelay?: number
  burstTotal?: number
  /** FLYER family: speed clamps, in original units. */
  maxXvel?: number
  maxYvel?: number
}

import { Container, Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../assets/loader'
import type { InputState } from '../core/input'
import { Entity } from './Entity'
import { Level } from './Level'
import { CLIMB_OFF_RANGE, CLIMB_OFF_RISE, CLIMB_SPEED } from './Ladders'
import { BASE_HEALTH_CAP, drawsTorso, scaleDamage, type PowerVisuals } from './powers'
import { TORSO_FALLBACK, WEAPON_SLOTS, type WeaponSlot } from './weapons/index'
import { isGrounded, moveAndCollide } from './collision'

/**
 * Our own platformer feel - not a reimplementation of Abuse's movement.
 * Units are world pixels per 60Hz tick.
 */
const PHYSICS = {
  gravity: 0.55,
  maxFall: 12,
  walkSpeed: 3.2,
  runSpeed: 6.0,
  accel: 0.7,
  airAccel: 0.35,
  friction: 0.55,
  airFriction: 0.06,
  jumpVelocity: -8.6,
  /** Releasing jump early cuts the rise short, for variable-height jumps. */
  jumpCutoff: 0.45,
  /** Ticks after leaving a ledge during which a jump still counts. */
  coyoteTicks: 6,
  /** Ticks a jump press is remembered while airborne. */
  jumpBufferTicks: 6,
}

/** How fast the run cycle plays, in frames per pixel travelled. */
const RUN_CYCLE = 1 / 7
const IDLE_FPS = 8

/**
 * The cop is drawn as two halves: legs from art/cop.spe and a torso from
 * art/coptop.spe that rotates independently through 24 aim frames. The engine
 * pins the torso at `bottom.y + 29 - bottomHeight`, nudged 4px when facing
 * left (src/cop.cpp, top_draw).
 */
const TOP_CHARACTER = 'MGUN_TOP'
const TOP_BASELINE = 29
const TOP_FLIP_NUDGE = 4

/**
 * Where the gun's muzzle sits for each of the torso's 24 aim frames, as
 * (x, right) / (y, up) offsets from the player's anchor.
 *
 * Straight from `small_fire_off` in src/cop.cpp - "x & y offset from character
 * to end of gun". Without it, shots leave from the player's feet instead of
 * the barrel.
 */
const MUZZLE_OFFSETS: readonly (readonly [number, number])[] = [
  [17, 20], [17, 23], [17, 28], [15, 33], [11, 39], [7, 43],
  [-3, 44], [-10, 42], [-16, 39], [-20, 34], [-20, 28], [-20, 25],
  [-19, 20], [-19, 16], [-16, 14], [-14, 11], [-11, 9], [-7, 8],
  [-3, 8], [2, 8], [6, 9], [10, 10], [14, 13], [16, 15],
]

/** A weapon swap costs a beat, so cycling is not a free rate-of-fire boost. */
const WEAPON_SWITCH_DELAY = 8
/** Ticks a surface that is an object, not a tile, keeps counting as ground. */
const OBJECT_SUPPORT_TICKS = 4
/** Rounds the cop starts a level with. */
const STARTING_AMMO = 50
/** Ticks of invulnerability after being hit, so one turret cannot chain-kill. */
const HURT_INVULNERABLE = 30
/** Ticks the death animation holds before respawning. */
const DEATH_TICKS = 120

/** How a power renames the leg animations, when one is being held. */
export interface LegStateFilter {
  legState(base: string): string
}

export class Player extends Entity {
  /** Torso sprite, drawn over the legs. */
  readonly topSprite = new Sprite()
  /** FAST's trailing copies, drawn behind the live cop. */
  readonly ghostLayer = new Container()

  onGround = false
  /** Aim direction in degrees, counter-clockwise from due right. */
  aimAngle = 0
  health: number
  /** Rounds per weapon slot. Firing dry still works, just far slower. */
  readonly magazines: number[] = WEAPON_SLOTS.map((_, i) => (i === 0 ? STARTING_AMMO : 0))
  /** Which of `WEAPON_SLOTS` is in hand. */
  weapon = 0

  /**
   * Set by the world to the `Powers` in hand, so DARNEL's `fast_*` and `fly_*`
   * sets go on screen while a power is running. Left alone it draws plain.
   */
  legStates: LegStateFilter = { legState: (base) => base }

  private invulnerable = 0
  private deathTimer = 0
  /** Torso frames per weapon, resolved once. */
  private readonly topsByWeapon: Frame[][] = []
  /** One legs-and-torso pair per FAST ghost, grown on demand. */
  private readonly ghosts: { legs: Sprite; torso: Sprite }[] = []

  private get topFrames(): Frame[] {
    return this.topsByWeapon[this.weapon] ?? this.topsByWeapon[0] ?? []
  }

  /**
   * `give_player_health` writes through a field the engine calls `hp`. This is
   * an alias rather than a rename: `health` is the name the status bar and the
   * save file have always used.
   */
  get hp(): number {
    return this.health
  }

  set hp(value: number) {
    this.health = value
  }

  /** Rounds for the weapon in hand. */
  get ammo(): number {
    return this.magazines[this.weapon]
  }

  get weaponSlot(): WeaponSlot {
    return WEAPON_SLOTS[this.weapon]
  }

  get isDead(): boolean {
    return this.deathTimer > 0
  }

  /** Flashes while briefly invulnerable, so a hit reads. */
  get isHurt(): boolean {
    return this.invulnerable > 0
  }

  private coyote = 0
  private objectSupport = 0
  private jumpBuffer = 0
  private fireCooldown = 0
  /** Set while a jump is rising and the cutoff has not been spent yet. */
  private jumpCutArmed = false

  constructor(
    assets: GameAssets,
    private readonly level: Level,
  ) {
    super(assets, 'DARNEL')
    this.halfWidth = 7
    this.height = 28
    // One torso per weapon, so the cop is visibly holding what he fires.
    // DRAY_TOP is built by the fRaBs Twist addon, which the converter does not
    // read, so its 24 frames are addressed by name; anything still missing
    // falls back to the machine gun's.
    for (const slot of WEAPON_SLOTS) {
      this.topsByWeapon.push(this.torsoFrames(assets, slot.top))
    }
    this.health = assets.ability('DARNEL', 'start_hp') ?? BASE_HEALTH_CAP
  }

  private torsoFrames(assets: GameAssets, character: string): Frame[] {
    const declared = assets.animation(character, 'stopped')
    if (declared.length) return declared

    const fallback = TORSO_FALLBACK[character]
    const loose = fallback
      ? fallback.frames
          .map((name) => assets.frame(fallback.file, name))
          .filter((frame): frame is Frame => frame !== undefined)
      : []
    return loose.length ? loose : assets.animation(TOP_CHARACTER, 'stopped')
  }

  /** Points the torso at a world-space position. */
  aimAt(worldX: number, worldY: number): void {
    const dx = worldX - this.x
    const dy = worldY - (this.y - this.height * 0.6)
    // Screen y grows downward; aim angles grow counter-clockwise.
    this.aimAngle = (Math.atan2(-dy, dx) * 180) / Math.PI
  }

  /**
   * How far below the top of a ladder the cop is, or null when not on one.
   * The world works this out and hands it over, the same way `latter_ai` sets
   * `in_climbing_area` on the player before its own handler reads it.
   */
  climbDepth: number | null = null
  /** Where the ladder pulls the cop to horizontally while climbing. */
  climbCentreX: number | null = null


  get isClimbing(): boolean {
    return this.state === 'climbing'
  }

  update(input: InputState, jumpPressed: boolean): void {
    this.prevX = this.x
    this.prevY = this.y

    if (this.climbDepth !== null && this.updateClimb(input, jumpPressed)) return

    if (this.invulnerable > 0) this.invulnerable--

    // Dead: hold still and let the timer run the respawn.
    if (this.deathTimer > 0) {
      this.deathTimer--
      this.vx = 0
      this.vy = Math.min(this.vy + PHYSICS.gravity, PHYSICS.maxFall)
      moveAndCollide(this.level, this, 0, this.vy)
      return
    }

    const axis = (input.right ? 1 : 0) - (input.left ? 1 : 0)
    const running = input.run
    const topSpeed = running ? PHYSICS.runSpeed : PHYSICS.walkSpeed
    const accel = this.onGround ? PHYSICS.accel : PHYSICS.airAccel

    if (axis !== 0) {
      this.vx += axis * accel
      if (Math.abs(this.vx) > topSpeed) this.vx = topSpeed * Math.sign(this.vx)
      this.direction = axis
    } else {
      const friction = this.onGround ? PHYSICS.friction : PHYSICS.airFriction
      if (Math.abs(this.vx) <= friction) this.vx = 0
      else this.vx -= friction * Math.sign(this.vx)
    }

    if (jumpPressed) this.jumpBuffer = PHYSICS.jumpBufferTicks
    else if (this.jumpBuffer > 0) this.jumpBuffer--

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vy = PHYSICS.jumpVelocity
      this.jumpBuffer = 0
      this.coyote = 0
      this.onGround = false
      this.jumpCutArmed = true
    }

    // Let go of jump on the way up and the arc is cut short - once, at the
    // moment of release. Re-applying it every tick would flatten the jump to
    // almost nothing.
    if (this.jumpCutArmed && !input.jump) {
      if (this.vy < 0) this.vy *= PHYSICS.jumpCutoff
      this.jumpCutArmed = false
    }

    // Gravity is never turned off, FLY included: that power pushes an impulse
    // into vy every tick and the hover is the balance between the two
    // (lisp/people.lsp do_special_power). It has already run for this tick.
    this.vy = Math.min(this.vy + PHYSICS.gravity, PHYSICS.maxFall)

    const result = moveAndCollide(this.level, this, this.vx, this.vy)
    if (result.hitWall) this.vx = 0
    if (result.hitCeiling && this.vy < 0) this.vy = 0

    // Objects hold you up too - platforms, doors, hidden walls - and none of
    // them are tiles. Without this the legs never run while you walk across a
    // hidden wall: `grounded` is false, so the state machine picks the falling
    // frame and the cop appears to hover.
    if (this.objectSupport > 0) this.objectSupport--
    const grounded = result.onGround || isGrounded(this.level, this) || this.objectSupport > 0
    if (grounded) {
      if (this.vy > 0) this.vy = 0
      this.coyote = PHYSICS.coyoteTicks
      this.jumpCutArmed = false
    } else if (this.coyote > 0) {
      this.coyote--
    }
    this.onGround = grounded

    this.updateAnimation()
  }

  /**
   * Picks the leg animation. Every name goes through the power's filter, which
   * is what puts DARNEL's `fast_*` and `fly_*` sets on screen - and only while
   * the special is actually held, so the powered art reads as the power being
   * used rather than as a second run cycle for sprinting.
   */
  /**
   * Climbing - `climb_handler` in lisp/people.lsp, followed rather than
   * reinterpreted.
   *
   *   down: step the frame back, `(set_y (+ (y) 3))`
   *   up:   `(if (< yd 32) (set_state climb_off)` else next frame and
   *         `(set_y (- (y) 3))`
   *   sideways: leave into a fall
   *
   * There are no bounds checks and nothing consults the terrain, which is
   * deliberate: a ladder shaft is drawn open and the markers already say where
   * it ends. Adding a grace margin at either end, a clamp to the shaft and a
   * headroom test before stepping off - all tried here first - each fixed one
   * report and caused the next.
   *
   * The one thing that genuinely keeps the cop on a 22px-wide ladder is the
   * pull onto its centre line, `(set_x (/ (+ (x) (other x)) 2))`, which runs
   * every tick he is climbing. Leaving it out is what let him drift three
   * pixels wide of the shaft and strand himself.
   *
   * Returns true while it owns the tick, so the normal physics does not run
   * and gravity never has to be turned off anywhere.
   */
  private updateClimb(input: InputState, jumpPressed: boolean): boolean {
    const depth = this.climbDepth ?? 0

    if (!this.isClimbing) {
      // The original enters `climbing` from the C++ mover rather than from
      // climb_handler, so this much is ours: a direction press grabs on, and
      // walking past does not.
      if (!input.up && !input.down) return false
      this.setState('climbing', true)
      this.vx = 0
      this.vy = 0
    }

    // `(if (not (eq xm 0)) ... (set_state run_jump_fall))` - a sideways press
    // leaves the ladder. Jump does the same, because a player who cannot get
    // off with the jump key will try it anyway.
    if (jumpPressed || input.left || input.right) {
      this.setState('run_jump_fall', true)
      this.vy = 0
      return false
    }

    const cycle = this.frameCount || 1
    if (input.up) {
      if (depth < CLIMB_OFF_RANGE) {
        this.y -= CLIMB_OFF_RISE
        this.setState('stopped', true)
        this.climbDepth = null
        return true
      }
      this.setFrame((this.frameIndex + 1) % cycle)
      this.y -= CLIMB_SPEED
    } else if (input.down) {
      // `(if (eq (current_frame) 0) (set_current_frame 9) ...)` - the cycle
      // runs backwards on the way down.
      this.setFrame((this.frameIndex + cycle - 1) % cycle)
      this.y += CLIMB_SPEED
    }

    // `latter_check_area` sets this every tick, not gradually.
    if (this.climbCentreX !== null) this.x = this.climbCentreX

    this.vx = 0
    this.vy = 0
    this.onGround = false
    return true
  }

  private updateAnimation(): void {
    if (!this.onGround) {
      this.setLegState(this.vy < 0 ? 'run_jump' : 'run_jump_fall')
      return
    }

    if (Math.abs(this.vx) > 0.15) {
      this.setLegState('running')
      // Tying the cycle to distance travelled keeps the feet from sliding, and
      // is why sprinting needs no animation of its own - the same cycle simply
      // plays faster.
      this.advanceAnimation(Math.abs(this.vx) * RUN_CYCLE)
    } else {
      this.setLegState('stopped')
      this.advanceAnimation(IDLE_FPS / 60)
    }
  }

  /** `setState` with the held power's prefix applied. */
  setLegState(base: string): void {
    this.setState(this.legStates.legState(base))
  }

  /**
   * Takes damage. Returns true if this killed the player, which starts the
   * death animation and the respawn timer.
   */
  hurt(amount: number): boolean {
    if (this.invulnerable > 0 || this.deathTimer > 0) return false
    // Already down and waiting to respawn. Without this a turret that keeps
    // shooting the body restarts the death timer every time it expires, and
    // the respawn never gets a tick to happen in.
    if (this.health <= 0) return false

    // `bottom_damage` scales the hit by the difficulty global before anything
    // else touches it (lisp/people.lsp). The default is hard, which is x1, so
    // this changes nothing today - it names the multiplier rather than leaving
    // it implicit.
    this.health = Math.max(0, this.health - scaleDamage(amount))
    this.invulnerable = HURT_INVULNERABLE
    if (this.health > 0) return false

    if (this.assets.hasState(this.character, 'dead')) this.setState('dead', true)
    this.deathTimer = DEATH_TICKS
    return true
  }

  /** Puts the cop back on their feet at a fresh spawn point. */
  revive(x: number, y: number): void {
    this.setPosition(x, y)
    this.vx = 0
    this.vy = 0
    this.health = this.assets.ability('DARNEL', 'start_hp') ?? BASE_HEALTH_CAP
    // Ammo survives a death; only the machine gun is topped back up.
    this.magazines[0] = Math.max(this.magazines[0], STARTING_AMMO)
    this.deathTimer = 0
    this.invulnerable = HURT_INVULNERABLE
    this.setState('stopped', true)
  }

  /**
   * Puts the player on a surface the tile grid knows nothing about - a moving
   * platform. This has to refresh the coyote timer as well as the flag:
   * `update` only ever renews it from tile grounding, so without this the
   * player can stand on a platform but never jump off it.
   */
  landOn(surfaceY: number): void {
    // Held for a few ticks: gravity has to pull the player back into whatever
    // is carrying them before the next overlap is detected, and they should
    // not flicker into a fall in between.
    this.objectSupport = OBJECT_SUPPORT_TICKS
    this.y = surfaceY
    if (this.vy > 0) this.vy = 0
    this.onGround = true
    this.coyote = PHYSICS.coyoteTicks
  }

  /** Root motion has to respect walls like any other movement. */
  protected override applyRootMotion(dx: number): void {
    moveAndCollide(this.level, this, dx, 0)
  }

  override draw(alpha: number): void {
    super.draw(alpha)
    this.drawTop(alpha)
  }

  private drawTop(alpha: number): void {
    const bottom = this.currentFrame
    const frame = this.topFrame()
    if (!bottom || !frame) {
      this.topSprite.visible = false
      return
    }

    // Blink while invulnerable so a hit is visible.
    const blink = this.invulnerable > 0 && Math.floor(this.invulnerable / 4) % 2 === 1
    this.sprite.alpha = blink ? 0.35 : 1
    this.topSprite.alpha = this.sprite.alpha

    // `top_draw_state` (lisp/people.lsp) names the leg states the torso is
    // drawn over. The powered sets are not among them, which is why the cop
    // has no gun while FLY or FAST is held - nor on a ladder, once there is one.
    this.topSprite.visible = !this.isDead && drawsTorso(this.state)
    this.topSprite.texture = frame.texture

    const x = this.prevX + (this.x - this.prevX) * alpha + (this.direction < 0 ? TOP_FLIP_NUDGE : 0)
    const y = this.prevY + (this.y - this.prevY) * alpha + TOP_BASELINE - bottom.height

    if (this.direction >= 0) {
      this.topSprite.scale.x = 1
      this.topSprite.x = Math.round(x - frame.xcfg)
    } else {
      this.topSprite.scale.x = -1
      this.topSprite.x = Math.round(x - (frame.width - frame.xcfg - 1) + frame.width)
    }
    this.topSprite.y = Math.round(y - frame.height + 1)
  }

  /** Which of the 24 aim frames the torso is showing. */
  private get topFrameIndex(): number {
    const count = this.topFrames.length
    if (count === 0) return 0
    // Frame 0 aims due right; mirroring the sprite mirrors the angle too.
    const angle = this.direction >= 0 ? this.aimAngle : 180 - this.aimAngle
    const normalized = ((angle % 360) + 360) % 360
    return Math.round((normalized / 360) * count) % count
  }

  /** Picks the aim frame, accounting for the sprite being mirrored. */
  private topFrame(): Frame | undefined {
    return this.topFrames[this.topFrameIndex]
  }

  /**
   * The point shots leave from: the end of the gun for the current aim frame,
   * mirrored when facing left.
   */
  get muzzle(): { x: number; y: number } {
    const offset = MUZZLE_OFFSETS[this.topFrameIndex] ?? MUZZLE_OFFSETS[0]
    const flipped = this.direction < 0
    return {
      x: this.x + (flipped ? TOP_FLIP_NUDGE - offset[0] : offset[0]),
      y: this.y - offset[1],
    }
  }

  /**
   * Picks a weapon slot. Slots you have no ammo for are refused - the machine
   * gun is the exception, since the cop always has that one.
   */
  selectWeapon(slot: number): boolean {
    if (slot < 0 || slot >= WEAPON_SLOTS.length) return false
    if (slot !== 0 && this.magazines[slot] <= 0) return false
    if (slot === this.weapon) return false
    this.weapon = slot
    this.fireCooldown = Math.max(this.fireCooldown, WEAPON_SWITCH_DELAY)
    return true
  }

  /** Steps to the next slot that has something in it, in either direction. */
  cycleWeapon(step: number): boolean {
    const n = WEAPON_SLOTS.length
    for (let i = 1; i <= n; i++) {
      const slot = (((this.weapon + step * i) % n) + n) % n
      if (slot === 0 || this.magazines[slot] > 0) return this.selectWeapon(slot)
    }
    return false
  }

  /**
   * Burns ticks off the weapon cooldown. FAST's second effect: the original
   * reaches into the torso and decrements `fire_delay1` directly, which speeds
   * up every weapon rather than any one of them.
   */
  coolWeapon(ticks: number): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - ticks)
  }

  /**
   * Consumes a shot if the gun is ready.
   *
   * Returns null while cooling down, and on an empty magazine for the seven
   * weapons that are simply not there to be fired. The machine gun is the
   * exception: out of ammo it does not stop, it labours - 3 ticks with, 7
   * without (`laser_ufun`, lisp/people.lsp), which is what "collect ammo to
   * increase firing speed" in the tutorial is telling you.
   *
   * The round is already spent when this returns, so a caller that then
   * refuses the shot - `player_fire_weapon` will not fire out of a wall - has
   * to hand `spent` back.
   */
  tryFire(wantsToFire: boolean): { slot: number; spent: number } | null {
    if (this.fireCooldown > 0) this.fireCooldown--
    if (!wantsToFire || this.fireCooldown > 0) return null

    const weapon = this.weaponSlot
    const dry = this.magazines[this.weapon] <= 0
    this.fireCooldown = Math.max(1, dry ? (weapon.dryFireDelay ?? weapon.fireDelay) : weapon.fireDelay)

    if (dry) {
      if (weapon.dryFireDelay === null) return null
      return { slot: this.weapon, spent: 0 }
    }

    const spent = Math.min(weapon.ammoCost, this.magazines[this.weapon])
    this.magazines[this.weapon] -= spent
    return { slot: this.weapon, spent }
  }

  /** Puts a refused shot's round back in the magazine. */
  refund(shot: { slot: number; spent: number }): void {
    this.magazines[shot.slot] += shot.spent
  }

  /**
   * Applies what a held power wants drawn: the cop's own transparency and
   * FAST's two trailing copies, which are ordinary blits of the live textures
   * at remembered positions (`draw_fast`, lisp/people.lsp).
   */
  drawPowers(visuals: PowerVisuals): void {
    const body = visuals.body
    // No refraction shader here, so 'predator' is drawn as very nearly gone.
    const alpha = body.mode === 'transparent' ? body.alpha : body.mode === 'predator' ? 0.06 : 1
    this.sprite.alpha *= alpha
    this.topSprite.alpha *= alpha

    const legFrame = this.currentFrame
    const torsoFrame = this.topFrame()
    visuals.ghosts.forEach((ghost, i) => {
      const pair = this.ghostAt(i)
      pair.legs.visible = legFrame !== undefined
      if (legFrame) {
        pair.legs.alpha = ghost.alpha
        this.blit(pair.legs, legFrame, ghost.x, ghost.y)
      }

      pair.torso.visible = ghost.torso !== null && torsoFrame !== undefined
      if (ghost.torso && torsoFrame) {
        pair.torso.alpha = ghost.alpha
        this.blit(pair.torso, torsoFrame, ghost.torso.x, ghost.torso.y + torsoFrame.height - 1)
      }
    })

    for (let i = visuals.ghosts.length; i < this.ghosts.length; i++) {
      this.ghosts[i].legs.visible = false
      this.ghosts[i].torso.visible = false
    }
  }

  private ghostAt(index: number): { legs: Sprite; torso: Sprite } {
    let pair = this.ghosts[index]
    if (!pair) {
      pair = { legs: new Sprite(), torso: new Sprite() }
      this.ghosts[index] = pair
      this.ghostLayer.addChild(pair.legs, pair.torso)
    }
    return pair
  }

  /** The engine's anchoring, mirrored the same way `Entity.draw` mirrors it. */
  private blit(sprite: Sprite, frame: Frame, x: number, y: number): void {
    sprite.texture = frame.texture
    if (this.direction >= 0) {
      sprite.scale.x = 1
      sprite.x = Math.round(x - frame.xcfg)
    } else {
      sprite.scale.x = -1
      sprite.x = Math.round(x - (frame.width - frame.xcfg - 1) + frame.width)
    }
    sprite.y = Math.round(y - frame.height + 1)
  }
}

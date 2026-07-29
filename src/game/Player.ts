import { Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../assets/loader'
import type { InputState } from '../core/input'
import { Entity } from './Entity'
import { Level } from './Level'
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

/**
 * Ticks between shots. The original slows the gun right down when you are out
 * of ammo rather than stopping it - 3 with, 7 without (lisp/people.lsp,
 * `laser_ufun`), which is what "collect ammo to increase firing speed" in the
 * tutorial is telling you.
 */
const FIRE_DELAY = 3
const FIRE_DELAY_DRY = 7
/** Rounds the cop starts a level with. */
const STARTING_AMMO = 50
/** Ticks of invulnerability after being hit, so one turret cannot chain-kill. */
const HURT_INVULNERABLE = 30
/** Ticks the death animation holds before respawning. */
const DEATH_TICKS = 120

export class Player extends Entity {
  /** Torso sprite, drawn over the legs. */
  readonly topSprite = new Sprite()

  onGround = false
  /** Aim direction in degrees, counter-clockwise from due right. */
  aimAngle = 0
  /** Nothing damages the player yet; this is what the status bar shows. */
  health: number
  /** Machine gun rounds. Firing dry still works, just far slower. */
  ammo = STARTING_AMMO

  private invulnerable = 0
  private deathTimer = 0

  get isDead(): boolean {
    return this.deathTimer > 0
  }

  /** Flashes while briefly invulnerable, so a hit reads. */
  get isHurt(): boolean {
    return this.invulnerable > 0
  }

  private readonly topFrames: Frame[]
  private coyote = 0
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
    this.topFrames = assets.animation(TOP_CHARACTER, 'stopped')
    this.health = assets.ability('DARNEL', 'start_hp') ?? 100
  }

  /** Points the torso at a world-space position. */
  aimAt(worldX: number, worldY: number): void {
    const dx = worldX - this.x
    const dy = worldY - (this.y - this.height * 0.6)
    // Screen y grows downward; aim angles grow counter-clockwise.
    this.aimAngle = (Math.atan2(-dy, dx) * 180) / Math.PI
  }

  update(input: InputState, jumpPressed: boolean): void {
    this.prevX = this.x
    this.prevY = this.y

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

    this.vy = Math.min(this.vy + PHYSICS.gravity, PHYSICS.maxFall)

    const result = moveAndCollide(this.level, this, this.vx, this.vy)
    if (result.hitWall) this.vx = 0
    if (result.hitCeiling && this.vy < 0) this.vy = 0

    const grounded = result.onGround || isGrounded(this.level, this)
    if (grounded) {
      if (this.vy > 0) this.vy = 0
      this.coyote = PHYSICS.coyoteTicks
      this.jumpCutArmed = false
    } else if (this.coyote > 0) {
      this.coyote--
    }
    this.onGround = grounded

    this.updateAnimation(running)
  }

  private updateAnimation(running: boolean): void {
    if (!this.onGround) {
      const rising = this.vy < 0
      this.setState(rising ? 'run_jump' : 'run_jump_fall')
      return
    }

    if (Math.abs(this.vx) > 0.15) {
      const wanted = running && this.assets.hasState(this.character, 'fast_running') ? 'fast_running' : 'running'
      this.setState(wanted)
      // Tying the cycle to distance travelled keeps the feet from sliding.
      this.advanceAnimation(Math.abs(this.vx) * RUN_CYCLE)
    } else {
      this.setState('stopped')
      this.advanceAnimation(IDLE_FPS / 60)
    }
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

    this.health = Math.max(0, this.health - amount)
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
    this.health = this.assets.ability('DARNEL', 'start_hp') ?? 100
    this.ammo = STARTING_AMMO
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

    this.topSprite.visible = !this.isDead
    this.topSprite.texture = frame.texture

    const x = this.prevX + (this.x - this.prevX) * alpha + (this.direction < 0 ? TOP_FLIP_NUDGE : 0)
    const y = this.prevY + (this.y - this.prevY) * alpha + TOP_BASELINE - bottom.height

    if (this.direction >= 0) {
      this.topSprite.scale.x = 1
      this.topSprite.x = x - frame.xcfg
    } else {
      this.topSprite.scale.x = -1
      this.topSprite.x = x - (frame.width - frame.xcfg - 1) + frame.width
    }
    this.topSprite.y = y - frame.height + 1
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
   * Consumes a shot if the gun is ready. Returns the muzzle and the angle to
   * fire along, or null while cooling down.
   */
  tryFire(wantsToFire: boolean): { x: number; y: number; angle: number } | null {
    if (this.fireCooldown > 0) this.fireCooldown--
    if (!wantsToFire || this.fireCooldown > 0) return null

    const dry = this.ammo <= 0
    this.fireCooldown = dry ? FIRE_DELAY_DRY : FIRE_DELAY
    if (!dry) this.ammo--

    const { x, y } = this.muzzle
    return { x, y, angle: this.aimAngle }
  }
}

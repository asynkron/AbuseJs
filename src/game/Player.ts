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

export class Player extends Entity {
  /** Torso sprite, drawn over the legs. */
  readonly topSprite = new Sprite()

  onGround = false
  /** Aim direction in degrees, counter-clockwise from due right. */
  aimAngle = 0
  /** Nothing damages the player yet; this is what the status bar shows. */
  health: number

  private readonly topFrames: Frame[]
  private coyote = 0
  private jumpBuffer = 0
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

    this.topSprite.visible = true
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

  /** Picks the aim frame, accounting for the sprite being mirrored. */
  private topFrame(): Frame | undefined {
    const count = this.topFrames.length
    if (count === 0) return undefined
    // Frame 0 aims due right; mirroring the sprite mirrors the angle too.
    const angle = this.direction >= 0 ? this.aimAngle : 180 - this.aimAngle
    const normalized = ((angle % 360) + 360) % 360
    return this.topFrames[Math.round((normalized / 360) * count) % count]
  }
}

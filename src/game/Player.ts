import { Container, Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../assets/loader'
import type { InputState } from '../core/input'
import { Entity } from './Entity'
import { Level } from './Level'
import {
  CLIMB_GRAB_MIN,
  CLIMB_OFF_RANGE,
  CLIMB_OFF_RISE,
  CLIMB_ON_RANGE,
  CLIMB_SPEED,
  CLIMB_STEP_OFF_RISE,
} from './Ladders'
import { BASE_HEALTH_CAP, drawsTorso, scaleDamage, type PowerVisuals } from './powers'
import { atan2Deg, TORSO_FALLBACK, WEAPON_SLOTS, type WeaponSlot } from './weapons/index'
import { isBlocked, isGrounded, moveAndCollide, unstick } from './collision'
import { playerAccel, playerSpeed, playerTicks, PLAYER_TICK_SCALE } from './enemies/tuning'

/**
 * The cop's movement: `def_char DARNEL`'s abilities (lisp/people.lsp:583-592) on
 * the cop's own faster clock - see PLAYER_TICK_SCALE. Deliberately not the
 * world's clock: he is about 2.67x the original's cop and the game is built
 * around that. Putting him on the world's clock made him crawl.
 *
 * These were hand-tuned figures before - 6.0px a tick and a 0.55 gravity - and
 * they were what TICK_SCALE was originally derived from, which is how the whole
 * game ended up running at 2.67x the original's pace. Now the abilities are the
 * source and the cop moves at the original's 135 px/s with a 112px jump.
 *
 * The three helpers below the abilities - the jump cutoff, coyote time and the
 * jump buffer - are ours and have no counterpart in the original. They are kept
 * because they only affect the *edges* of a jump the player asked for, not how
 * far or fast he travels, and dropping them makes the cop feel broken on a
 * keyboard. Their durations are in original ticks like everything else.
 */
const PHYSICS = {
  gravity: playerAccel(1),
  maxFall: playerSpeed(48),
  /** `walk_top_speed 3` and `run_top_speed 9`. */
  walkSpeed: playerSpeed(3),
  runSpeed: playerSpeed(9),
  /** `start_accel 8` and `stop_accel 9` - accelerations, so scaled twice. */
  accel: playerAccel(8),
  friction: playerAccel(9),
  /** Airborne control is not in the abilities; halved, as the port had it. */
  airAccel: playerAccel(8) / 2,
  airFriction: playerAccel(9) / 10,
  /** `jump_yvel -15`, which against gravity 1 is a 112px apex. */
  jumpVelocity: playerSpeed(-15),
  /** Releasing jump early cuts the rise short, for variable-height jumps. */
  jumpCutoff: 0.45,
  /** Ticks after leaving a ledge during which a jump still counts. */
  coyoteTicks: playerTicks(2),
  /** Ticks a jump press is remembered while airborne. */
  jumpBufferTicks: playerTicks(2),
}

/** How fast the run cycle plays, in frames per pixel travelled. */
const RUN_CYCLE = 1 / 7
const IDLE_FPS = 8

/**
 * The cop is drawn as two halves: legs from art/cop.spe and a torso from
 * art/coptop.spe that rotates independently through 24 aim frames. The engine
 * pins the torso at `bottom.y + 29 - bottomHeight` and always draws it
 * unmirrored (src/cop.cpp, top_draw).
 */
const TOP_CHARACTER = 'MGUN_TOP'
const TOP_BASELINE = 29

/**
 * The shoulder the gun hangs off is 4px further along when the cop faces left.
 *
 * Two separate functions apply it and both restore it afterwards, which makes
 * them easy to mistake for each other: `top_ai` shifts the *legs'* x across the
 * aim maths and puts it back before `o->x=q->x` (src/cop.cpp:155 and :186), so
 * that one really is angles only. `top_draw` then shifts the *torso's* own x
 * across the draw (src/cop.cpp:762-764), so it applies to the sprite as well.
 * Reading only the first leaves the torso 4px to the left of the legs whenever
 * he faces that way.
 */
const TOP_SHOULDER_NUDGE = 4

/**
 * The scale `SET_FADE_COUNT` works on - `(draw_transparent count 16)`, where
 * the count is how much of the background shows through. A teleporter ramps it
 * from 0 to 15 across its animation, so the cop thins out to almost nothing
 * before he is set down at the far end (tp2_ai, lisp/duong.lsp).
 */
const TELEPORT_FADE_MAX = 16

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
 * The pivot the aim frames are measured from - `int iy=f[1], ix=f[6*2]` in
 * src/cop.cpp:163, which is frame 0's y and frame *6*'s x. Not a centre, just
 * the two numbers the original happens to pick.
 */
const AIM_PIVOT_X = MUZZLE_OFFSETS[6][0]
const AIM_PIVOT_Y = MUZZLE_OFFSETS[0][1]

/**
 * The heading each aim frame inherently points, from its own muzzle offset.
 *
 * This is what makes the frame choice non-uniform: the 24 offsets are not
 * evenly spaced around the pivot, so dividing the aim angle by 24 picks a
 * different frame than the original's nearest-angle search does over most of
 * the circle (src/cop.cpp:166-176).
 */
const AIM_FRAME_ANGLES: readonly number[] = MUZZLE_OFFSETS.map(([x, y]) =>
  atan2Deg(y - AIM_PIVOT_Y, x - AIM_PIVOT_X),
)

/**
 * `abs(q->y - fb[1] - pointer_y) < 45 && abs(pointer_x - q->x + fb[0]) < 40`
 * (src/cop.cpp:183): with the crosshair this close to the muzzle, the shot goes
 * where the arm is pointing rather than at the crosshair, so aiming at your own
 * feet does not produce a wild angle.
 */
const AIM_SNAP_Y = 45
const AIM_SNAP_X = 40

/**
 * `angle_diff` from src/cop.cpp:126 - the shortest way round between two
 * headings, 0..180. Not the same function as the `angleDiff` in
 * weapons/angles.ts, which reproduces the frisbee's deliberately broken one.
 */
function shortestArc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** A weapon swap costs a beat, so cycling is not a free rate-of-fire boost. */
const WEAPON_SWITCH_DELAY = 8
/** Ticks a surface that is an object, not a tile, keeps counting as ground. */
const OBJECT_SUPPORT_TICKS = playerTicks(1)
/** Rounds the cop starts a level with. */
const STARTING_AMMO = 50
/**
 * `bottom_damage`'s red flash: `r_ramp += amount * 7`, capped at 120, decaying
 * 7 per engine tick (lisp/people.lsp:348-353, src/cop.cpp:795-812).
 *
 * The g and b ramps in the script are dead - they only ever subtract from zero
 * and are then clamped back to zero - so red is the whole of it. The engine
 * adds it to every entry of the palette, so it tints the entire screen rather
 * than the cop.
 *
 * There is no invulnerability window anywhere in `bottom_damage`. The port used
 * to grant 30 ticks of complete immunity after any hit, which is not in the
 * original at all; what stopped a monster chain-killing you was that its
 * contact damage lands once per engine tick, which is now what happens.
 */
const HURT_RAMP_PER_DAMAGE = 7
const HURT_RAMP_MAX = 120
const HURT_RAMP_DECAY = 7
/**
 * The cop stays down until the player asks to carry on.
 *
 * `cop_mover` holds aistate 3 showing `space_cont` and only restarts when
 * Space or Enter is down (src/cop.cpp:678-692) - there is no timer in that path
 * at all, so the old 120-tick auto-respawn pulled you back into play whether
 * you were ready or not.
 */
const DEATH_SETTLE_TICKS = playerTicks(8)

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

  /**
   * How red the screen is, 0..120. Set by a hit and decayed every tick; the
   * world reads it to draw the flash.
   */
  hurtRamp = 0
  /** Down and waiting for the player to press on - not a timer. */
  private dead = false

  /**
   * `is_teleporting` and its fade count, set by whichever teleporter has hold
   * of him. Non-zero fade means a pad is running its animation over him: he
   * cannot fire (src/cop.cpp:662), takes no damage (`bottom_damage` in
   * lisp/people.lsp returns nil) and is drawn increasingly transparent.
   */
  isTeleporting = false
  teleportFade = 0
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
    return this.dead
  }

  /**
   * True once the body has settled, so the "continue" prompt is not thrown up
   * on the same tick the cop is still falling over.
   */
  get isAwaitingContinue(): boolean {
    return this.dead && this.deathTimer === 0
  }

  /** True while the hit flash is still fading. */
  get isHurt(): boolean {
    return this.hurtRamp > 0
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
    // `lisp_atan2(q->y - iy - pointer_y, pointer_x - q->x - ix)` - the heading
    // from the arm's pivot to the crosshair (src/cop.cpp:165), measured from the
    // shoulder, which sits 4px along when he faces left.
    const originX = this.x + (this.direction < 0 ? TOP_SHOULDER_NUDGE : 0)
    const wanted = atan2Deg(this.y - AIM_PIVOT_Y - worldY, worldX - originX - AIM_PIVOT_X)

    // Pick the frame whose own heading is closest to that.
    let best = 0
    let bestDiff = Infinity
    for (let i = 0; i < AIM_FRAME_ANGLES.length; i++) {
      const diff = shortestArc(AIM_FRAME_ANGLES[i], wanted)
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    }
    this.aimFrame = best

    const [offX, offY] = MUZZLE_OFFSETS[best]
    const muzzleY = this.y - offY
    const muzzleX = originX + offX

    // Close in, the shot follows the arm; otherwise it follows the crosshair.
    // The horizontal test is `abs(pointer_x - q->x + fb[0])`, which adds the
    // offset where the muzzle subtracts it - the original's own sign slip, kept
    // because it decides where the snap zone sits.
    if (Math.abs(muzzleY - worldY) < AIM_SNAP_Y && Math.abs(worldX - originX + offX) < AIM_SNAP_X) {
      this.aimAngle = AIM_FRAME_ANGLES[best]
    } else {
      this.aimAngle = atan2Deg(muzzleY - worldY, worldX - muzzleX)
    }
  }

  /** Which of the 24 offsets the search settled on, for the torso and muzzle. */
  private aimFrame = 0

  /**
   * How far below the top of a ladder the cop is, or null when not on one.
   * The world works this out and hands it over, the same way `latter_ai` sets
   * `in_climbing_area` on the player before its own handler reads it.
   */
  climbDepth: number | null = null
  /** Where the ladder pulls the cop to horizontally while climbing. */
  climbCentreX: number | null = null


  /**
   * On a ladder in any of the three climbing states. `climb_handler` owns the
   * cop through all of them, so everything that defers to the ladder - the
   * blocker push-out, gravity, the mover - has to treat them alike.
   */
  get isClimbing(): boolean {
    return this.state === 'climbing' || this.state === 'climb_on' || this.state === 'climb_off'
  }

  update(input: InputState, jumpPressed: boolean): void {
    this.prevX = this.x
    this.prevY = this.y

    // Anything may have put him inside a wall since the last tick - a lift, a
    // teleporter, a spring, the 28px ladder step - and a body inside a wall
    // cannot move in any direction at all. This is the only thing that gets him
    // out again.
    //
    // Not while he is on a ladder. `climb_handler` moves him with a bare
    // `(set_y ...)` and consults no terrain at all, because the top of a shaft
    // is the floor of the room above and he is meant to pass straight through
    // it. Unsticking him there fights the climb and wins: he rises until his
    // head reaches the slab, gets shoved back down the same distance every
    // tick, and hangs at a fixed height a little below the lip - close enough
    // to look like a ladder that simply ends, and never inside the 32px window
    // where pressing up steps him off. The step-off itself lands him back under
    // ordinary rules on the following tick, which is the case the note above is
    // really about.
    if (!this.isClimbing) unstick(this.level, this)

    if (this.climbDepth !== null && this.updateClimb(input)) return

    // `bottom_draw` takes 7 off the ramp per engine tick, floor zero.
    if (this.hurtRamp > 0) {
      this.hurtRamp = Math.max(0, this.hurtRamp - HURT_RAMP_DECAY * PLAYER_TICK_SCALE)
    }

    // Dead: settle to the floor and wait to be told to carry on.
    if (this.dead) {
      if (this.deathTimer > 0) this.deathTimer--
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
  private updateClimb(input: InputState): boolean {
    const depth = this.climbDepth ?? 0
    const ym = (input.down ? 1 : 0) - (input.up ? 1 : 0)
    const xm = (input.right ? 1 : 0) - (input.left ? 1 : 0)

    // The two transition animations own the tick while they play.
    if (this.state === 'climb_off') return this.climbOffStep()
    if (this.state === 'climb_on') return this.climbOnStep()

    if (this.state !== 'climbing') {
      // `(else if (and (> ym 0) (< yd 10)))` - stepping on from above. The cop
      // drops 28px onto the ladder first and then plays himself onto it.
      if (ym > 0 && depth < CLIMB_ON_RANGE) {
        this.y += CLIMB_OFF_RISE
        this.setState('climb_on', true)
        this.vx = 0
        this.vy = 0
        return true
      }

      // `(else if (and (>= (yvel) 0) (or (> ym 0) (and (< ym 0) (> yd 8)))))` -
      // he cannot grab on while still rising out of a jump, and reaching up for
      // a ladder only works once he is far enough below its top.
      const grabbing = this.vy >= 0 && (ym > 0 || (ym < 0 && depth > CLIMB_GRAB_MIN))
      if (!grabbing) return false

      this.setState('climbing', true)
      this.vx = 0
      this.vy = 0
    }

    if (ym > 0) {
      // `(if (eq (current_frame) 0) (set_current_frame 9))` then decrement -
      // the cycle runs backwards on the way down.
      const cycle = this.frameCount || 1
      this.setFrame((this.frameIndex + cycle - 1) % cycle)
      this.y += CLIMB_SPEED
    } else if (ym < 0) {
      if (depth < CLIMB_OFF_RANGE) {
        // Near the top, up steps off - as an animation, not a teleport.
        this.setState('climb_off', true)
        return true
      }
      this.nextClimbFrame()
      this.y -= CLIMB_SPEED
    }

    // `(if xm ...)`: stepping off sideways needs 20px of headroom, or he stays
    // put. Pressing up as well turns it into a jump rather than a step into air.
    if (xm !== 0 && this.hasClimbHeadroom()) {
      if (ym < 0) {
        this.setState('run_jump', true)
        this.vy = PHYSICS.jumpVelocity
      } else {
        this.setState('run_jump_fall', true)
        this.vy = 0
      }
      return false
    }

    // `latter_check_area` sets this every tick, not gradually.
    if (this.climbCentreX !== null) this.x = this.climbCentreX

    this.vx = 0
    this.vy = 0
    this.onGround = false
    return true
  }

  /** `climb_on_handler`: play onto the ladder, then start climbing. */
  private climbOnStep(): boolean {
    if (!this.nextClimbFrame()) this.setState('climbing', true)
    this.vx = 0
    this.vy = 0
    this.onGround = false
    return true
  }

  /** `climb_off_handler`: play off the top, then stand up 28px higher. */
  private climbOffStep(): boolean {
    if (!this.nextClimbFrame()) {
      this.y -= CLIMB_OFF_RISE
      this.setState('stopped', true)
      this.climbDepth = null
    }
    this.vx = 0
    this.vy = 0
    return true
  }

  /**
   * One frame of whichever climb animation is up, at the engine's rate.
   * False on the tick it runs off the end - `next_picture`'s own answer.
   */
  private nextClimbFrame(): boolean {
    const cycle = this.frameCount || 1
    this.climbCarry += PLAYER_TICK_SCALE
    if (this.climbCarry < 1) return true
    this.climbCarry -= 1

    const next = this.frameIndex + 1
    if (next < cycle) {
      this.setFrame(next)
      return true
    }
    this.setFrame(0)
    return false
  }

  private climbCarry = 0

  /**
   * `(try_move (x) (y) 0 -20 3)` - 20px of clear headroom before he can step
   * off sideways. Without it he can walk out of a shaft into solid rock.
   */
  private hasClimbHeadroom(): boolean {
    const y = this.y
    const clear = !isBlocked(this.level, { ...this, y: y - CLIMB_STEP_OFF_RISE })
    return clear
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
    if (this.dead) return false
    // `bottom_damage` refuses outright mid-teleport (lisp/people.lsp).
    if (this.isTeleporting) return false
    // Already down and waiting to respawn. Without this a turret that keeps
    // shooting the body restarts the death timer every time it expires, and
    // the respawn never gets a tick to happen in.
    if (this.health <= 0) return false

    // `bottom_damage` scales the hit by the difficulty global before anything
    // else touches it (lisp/people.lsp). The default is hard, which is x1, so
    // this changes nothing today - it names the multiplier rather than leaving
    // it implicit.
    const scaled = scaleDamage(amount)
    this.health = Math.max(0, this.health - scaled)

    // The screen flash, and the wince. `(if (eq (random 2) 0) flinch_up
    // flinch_down)` - and the torso is not drawn over either, which is what
    // makes a hit read even without the flash.
    this.hurtRamp = Math.min(HURT_RAMP_MAX, this.hurtRamp + scaled * HURT_RAMP_PER_DAMAGE)
    if (this.health > 0) {
      const wince = Math.random() < 0.5 ? 'flinch_up' : 'flinch_down'
      if (this.assets.hasState(this.character, wince)) this.setState(wince, true)
      return false
    }

    if (this.assets.hasState(this.character, 'dead')) this.setState('dead', true)
    this.dead = true
    this.deathTimer = DEATH_SETTLE_TICKS
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
    this.dead = false
    this.deathTimer = 0
    // Dying on a pad would otherwise leave him permanently faded and unable to
    // fire; `restart_player` clears every one of these lvars in the original.
    this.isTeleporting = false
    this.teleportFade = 0
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

    this.sprite.alpha = 1
    // `SET_FADE_COUNT` while a teleporter has hold of him (tp2_ai).
    if (this.teleportFade > 0) this.sprite.alpha *= 1 - this.teleportFade / TELEPORT_FADE_MAX
    this.topSprite.alpha = this.sprite.alpha

    // `top_draw` (src/cop.cpp) names the leg states the torso is drawn over.
    // `drawsTorso` looks past a `fast_`/`fly_` prefix, because the original
    // only swaps those in for the duration of one draw call - the cop keeps his
    // gun while a power is held.
    this.topSprite.visible = !this.isDead && drawsTorso(this.state)
    this.topSprite.texture = frame.texture

    // `o->x=bot->x; if (bot->direction<0) o->x+=4;` (src/cop.cpp:762-764). The
    // shoulder shift applies to where the torso is *drawn*, as well as to the
    // aim maths in `top_ai`. Two functions, the same 4px, and each restores it
    // afterwards - which is what makes them easy to mistake for one another.
    const x =
      this.prevX + (this.x - this.prevX) * alpha + (this.direction < 0 ? TOP_SHOULDER_NUDGE : 0)
    const y = this.prevY + (this.y - this.prevY) * alpha + TOP_BASELINE - bottom.height

    // `o->direction=1;  // always face right` (src/cop.cpp:153). The torso is
    // never mirrored: its 24 frames already sweep the whole circle, so the aim
    // frame alone says which way the gun points. Mirroring it as well negated
    // that - and because the flip followed the legs rather than the crosshair,
    // aiming left read correctly until the cop turned to walk left, then
    // inverted.
    this.topSprite.scale.x = 1
    this.topSprite.x = Math.round(x - frame.xcfg)
    this.topSprite.y = Math.round(y - frame.height + 1)
  }

  /**
   * Which of the 24 aim frames the torso is showing - the one `aimAt` chose.
   *
   * The original searches the offset table rather than dividing the circle
   * evenly, and it does not mirror the index for a left-facing cop: the 24
   * offsets already sweep the whole circle, from +17 on the right round to -20
   * on the left, so there is nothing to mirror.
   */
  private get topFrameIndex(): number {
    const count = this.topFrames.length
    if (count === 0) return 0
    return this.aimFrame % count
  }

  /** Picks the aim frame, accounting for the sprite being mirrored. */
  private topFrame(): Frame | undefined {
    return this.topFrames[this.topFrameIndex]
  }

  /** The point shots leave from: the end of the gun for the current aim frame. */
  get muzzle(): { x: number; y: number } {
    // Taken as it stands: the chosen frame already points the way the cop is
    // aiming, so there is no mirroring to undo. Mirroring it was the other half
    // of the old evenly-divided frame lookup. The shoulder shift applies here
    // too, since this is the same `q->x + fb[0]` the angle was measured from.
    const offset = MUZZLE_OFFSETS[this.topFrameIndex] ?? MUZZLE_OFFSETS[0]
    const originX = this.x + (this.direction < 0 ? TOP_SHOULDER_NUDGE : 0)
    return { x: originX + offset[0], y: this.y - offset[1] }
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
  coolWeapon(amount: number): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - amount)
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
    // `if ((but&2) && !o->lvars[is_teleporting] ...)` - src/cop.cpp.
    if (this.isTeleporting) return null

    const weapon = this.weaponSlot
    const dry = this.magazines[this.weapon] <= 0
    // The table holds the original's own `fire_delay1` values (src/cop.cpp:268,
    // :310, :337), but the cop's trigger is hand-tuned like the rest of him and
    // these are taken as our ticks: the machine gun fires 20 a second rather
    // than the original's 5. Converting them was what made his gun feel
    // sluggish even after his legs were put right.
    const delay = dry ? (weapon.dryFireDelay ?? weapon.fireDelay) : weapon.fireDelay
    this.fireCooldown = Math.max(1, delay)

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
        // `ghost.torso.y` is already `legs.y + 29 - legs_height`, the same
        // anchor the live torso uses, and `blit` applies the engine's own
        // `y - height + 1` on top. Pre-adding the torso height here cancelled
        // that out, so the ghost landed a full torso below the cop.
        this.blit(pair.torso, torsoFrame, ghost.torso.x, ghost.torso.y, false)
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

  /**
   * The engine's anchoring, mirrored the same way `Entity.draw` mirrors it.
   *
   * `mirrored` is false for a torso: `top_ai` forces `o->direction=1`, so the
   * ghost copies have to be drawn facing right whichever way the legs point,
   * exactly like the live one.
   */
  private blit(sprite: Sprite, frame: Frame, x: number, y: number, mirrored = true): void {
    sprite.texture = frame.texture
    if (!mirrored || this.direction >= 0) {
      sprite.scale.x = 1
      sprite.x = Math.round(x - frame.xcfg)
    } else {
      sprite.scale.x = -1
      sprite.x = Math.round(x - (frame.width - frame.xcfg - 1) + frame.width)
    }
    sprite.y = Math.round(y - frame.height + 1)
  }
}

import { Container, Graphics, type Renderer } from 'pixi.js'

import type { GameAssets } from '../assets/loader'
import type { LevelObjectData, RenderLight } from '../assets/types'
import type { AudioBank } from '../audio/AudioBank'
import { AmbientSounds } from '../audio/AmbientSounds'
import { Camera } from '../core/camera'
import type { Input, InputState } from '../core/input'
import { TICK_HZ } from '../core/loop'
import { LightLayer } from '../render/LightLayer'
import { StatusBar } from '../render/StatusBar'
import { TileLayer } from '../render/TileLayer'
import { PlayerCombatant, PropCombatant, type Combatant } from './combat'
import { isBlocked, isGrounded, moveAndCollide, type Body } from './collision'
import { bloodFor, EffectsSystem, gibFlavourFor, hurtRadius, type BlastSource } from './effects/index'
import { speed } from './enemies/tuning'
import { buildEnemies, type EnemyGroup, type EnemyShot, type EnemySound } from './enemies/index'
import { buildForceFields, type ForceField } from './ForceField'
import { Level } from './Level'
import { LevelLogic, type LogicFocus, type LogicHost } from './logic/index'
import { Player } from './Player'
import {
  axis,
  givePlayerHealth,
  HEART_HEAL,
  powerPickup,
  Powers,
  type PowerKind,
} from './powers'
import { Prop, spawnProps } from './Prop'
import { CONSOLE_LIT_TICKS, readSave, restore, snapshot, writeSave } from './SaveGame'
import { buildTeleporters, type Teleporter } from './Teleporter'
import { buildTeleportDoors, type TeleportDoor } from './TeleportDoor'
import { buildLadders, climbDepth, ladderAt, type Ladder } from './Ladders'
import { buildBoulders, CHUNK_VELOCITIES, SmallBoulder, type Boulder } from './Boulder'
import { buildHazards, type Hazards } from './Hazards'
import { TrainMessages } from './TrainMessages'
import {
  AMMO_ICON_SLOT,
  ProjectileSystem,
  type ProjectileHost,
  type ProjectileOwner,
  type ProjectileTarget,
} from './weapons/index'

/**
 * Objects the player collides with as if they were terrain.
 *
 * Not `can_block`, which is on more than sixty characters - every platform,
 * both turrets, the T_REX, and NEXT_LEVEL. In the original it means "this can
 * block", with the actual blocking driven from lisp state, so taking it as
 * "is solid" walls off exit portals and anything else you are meant to stand
 * on. This is the list of things that are just geometry; the ones whose
 * solidity varies - doors, steps, lifts - come from the logic's own views.
 */
/**
 * Solid objects that are simply geometry. BOLDER used to be here, but it is a
 * trap rather than scenery - it hangs until its sensor trips and then rolls,
 * so it owns its own collision (see Boulder.ts).
 */
const BLOCKER_TYPES = /^(HIDDEN_(WALL|RAMP)|BLOCK$)/

/** The five characters `make_hidden_wall_char` gives `big_wall_ai` to. */
const BIG_WALLS = /^HIDDEN_WALL_(2x2|3WAL|3FLR|3TOP|AFLR)$/
/** ...and the seven it gives `hwall_ai` (lisp/doors.lsp:184-198). */
const SMALL_WALLS = /^HIDDEN_(WALL[1-5]|RAMP[12])$/

/** The flyer family, which all die the same way (lisp/flyer.lsp flyer_ai). */
const FLYERS = new Set(['FLYER', 'GREEN_FLYER', 'WHO'])

/**
 * A blocker whose top is within this of the player's feet is stepped onto
 * rather than walked into. The tile collision has the same tolerance for the
 * same reason: hidden walls sit flush in floors, and pushing sideways off one
 * feels like catching on nothing.
 */
const BLOCKER_STEP_HEIGHT = 8

/**
 * How far outside the cop's own box a pickup still counts as touched.
 *
 * The test used to be a square 18px either side of `player.y`, which is the
 * cop's *feet* - so anything above his waist was out of reach, and ammo sitting
 * at head height on a ledge could not be taken however hard you jumped at it.
 * It is measured against the whole body now, with this as the grace margin.
 */
const PICKUP_MARGIN = 8

/** How close the player must stand to a save console to use it. */
const CONSOLE_REACH_X = 26
const CONSOLE_REACH_Y = 40

/** How close the player must stand to an exit portal to use it. */
const EXIT_REACH_X = 20
const EXIT_REACH_Y = 40
/** ...and how close before it says so. Wider, or you never find out it is there. */
const EXIT_PROMPT_X = 46
const EXIT_PROMPT_Y = 52

/** Where `player_fire_weapon` measures line of sight from - the torso's chest. */
const CHEST_HEIGHT = 16

/** `hurt_radius`'s `max_push` at every call site the scripts use. */
const BLAST_MAX_PUSH = 20
/** How wide the stand-in for a flash mine's `make_view_solid` reaches. */
const MINE_FLASH_RADIUS = 400
/** `(play_sound SBALL_SND 127 ...)` - a boulder's bounce is at full volume. */
const SBALL_VOLUME = 127

/**
 * How faded the cop has to be before nothing notices him.
 *
 * SNEAKY reports concealment as a 0..1 ramp, but the creatures' waking tests
 * take a boolean, so somewhere on that ramp is a threshold. Invented: half.
 */
const SNEAKY_THRESHOLD = 0.5

/**
 * Damage below this draws no blood. Invented, and set so a machine gun round
 * (5) just clears it while the splash off a neighbouring hidden wall mostly
 * does not.
 */
const HIT_SPRAY_MIN_DAMAGE = 5

/** The lisp's 0..127 volume scale, which AudioBank works in 0..1. */
const FULL_VOLUME = 127

/**
 * Owns a loaded level and everything drawn in it.
 *
 * The display list mirrors the original draw order (src/game.cpp): background
 * tiles, foreground tiles, objects, then the tiles flagged "above" - which is
 * how the player ends up walking behind pillars and doorframes.
 */
export class World {
  /**
   * Set by the title screen before the first level loads. A one-shot, because
   * only the level you resume into restores - walking on to the next one
   * should not put the save back.
   */
  static resumeFromSave = false

  /**
   * The id the level was loaded under, e.g. `levels/level03`.
   *
   * Saves key on this rather than `level.name`, which is the name baked into
   * the SPE file and is not a usable identifier - level02's is the literal
   * string `C:\\ABUSE\\LEVELS/LEVEL02.SPE`.
   */
  static currentLevelId = ''

  readonly root = new Container()

  private readonly backdrop = new Container()
  private readonly scene = new Container()
  private readonly propLayer = new Container()
  private readonly entityLayer = new Container()

  /** Explosions, smoke and body parts. */
  private readonly fx: EffectsSystem
  /** Everything in flight, the player's and the monsters' alike. */
  private readonly projectiles: ProjectileSystem
  /** Sensors, gates, doors, steps and lifts. */
  private readonly logic: LevelLogic
  /** Everything that thinks. */
  private readonly enemies: EnemyGroup
  /** The cop's special-power slot, and the seam it acts on him through. */
  private readonly powers: Powers
  private readonly powerHost: CopPowerHost

  /** Level objects, drawn behind the player. */
  private readonly props: Prop[]
  private readonly propsByIndex = new Map<number, Prop>()
  private readonly teleporters: Teleporter[]
  private readonly teleportDoors: TeleportDoor[]
  /** Climbable rectangles. LADDER draws with dev_draw, so these are markers. */
  private readonly ladders: Ladder[]
  private readonly boulders: Boulder[]
  /** Debris from dead boulders, alive until each one lands and bursts. */
  private readonly smallBoulders: SmallBoulder[] = []
  /** Mines, bombs, lava and lightning - lisp/duong.lsp's stationary dangers. */
  private readonly hazards: Hazards
  private readonly forceFields: ForceField[]
  private readonly fieldGraphics = new Graphics()

  /**
   * `bottom_draw`'s red flash, in screen space.
   *
   * The engine adds `r_ramp` to the red channel of every palette entry, so a
   * hit reddens the whole view rather than the cop. An additive red fill over
   * the finished frame is the nearest thing here.
   */
  readonly hurtFlash = new Graphics({ blendMode: 'add' })

  /**
   * Props that are solid without the logic having an opinion - the hidden
   * walls, mostly, which stand in the middle of a corridor looking like part
   * of it. Collision is tile-based, so without this you walk through them.
   */
  private readonly blockers: Prop[] = []

  /**
   * Everything a shot or a blast can catch, the cop included. One list is what
   * lets an ant hit another ant and what drives the hidden-wall chain: a wall
   * that dies calls `hurt_radius` on itself, and its neighbours are in here.
   *
   * Entries are only ever removed by `retireDead`, which runs at the end of a
   * tick, so a blast can iterate this while the things it kills are dying.
   */
  private readonly combatants: Combatant[] = []
  private readonly combatantOf = new Map<Prop, PropCombatant>()
  private readonly playerTarget: PlayerCombatant

  /** The lift the player is standing on, so `platform_push` knows who to carry. */
  private riding: number | null = null
  private visibleProps = 0

  private readonly bgTiles: TileLayer
  private readonly fgTiles: TileLayer
  private readonly aboveTiles: TileLayer

  /**
   * Static level lighting. It lives in screen space and multiplies over the
   * finished scene, so it is a sibling of `root` rather than a child.
   */
  readonly lights = new LightLayer()

  readonly camera: Camera
  readonly player: Player

  /** The cop, as the level logic sees him. */
  private readonly focus: PlayerFocus

  /** Level ambience, driven from the camera position. */
  private readonly ambience: AmbientSounds

  /**
   * Exit portals. NEXT_LEVEL stores its destination level number in `aistate`
   * (lisp/people.lsp, next_level_ai) and the original triggers on touching it
   * with the action key held.
   */
  private readonly exits: Prop[] = []

  /**
   * Save consoles. The object is RESTART_POSITION - the same marker a fresh
   * level spawns you at - so using one is literally moving where you restart.
   */
  private readonly consoles: Prop[] = []
  /** Where dying puts the player: the last console used, or the level's START. */
  private restartAt: { x: number; y: number }
  /** Ticks left on the lit `console_on` frame, per console. */
  private readonly consoleLit = new Map<Prop, number>()
  /** Set when a save lands, for the HUD to announce. */
  savedMessage = 0

  /** Set when the player uses an exit; main.ts polls and swaps levels. */
  requestedLevel: string | null = null

  /** Tutorial text overlay, in screen space. */
  readonly messages: TrainMessages

  /** The original status bar, in screen space. */
  readonly statusBar: StatusBar

  /** Reused each frame; see the merge in `render`. */
  private readonly dynamicLights: RenderLight[] = []

  /** Where the crosshair is in world space; the disc and the death ray steer by it. */
  private pointer: { x: number; y: number } | null = null

  private kills = 0

  private readonly assets: GameAssets

  constructor(
    assets: GameAssets,
    readonly level: Level,
    viewWidth: number,
    viewHeight: number,
    private readonly audio: AudioBank,
    trainMessages: Record<number, string> = {},
  ) {
    this.assets = assets
    this.bgTiles = new TileLayer(assets, level, 'back')
    this.fgTiles = new TileLayer(assets, level, 'fore', false)
    this.aboveTiles = new TileLayer(assets, level, 'fore', true)

    this.player = new Player(assets, level)
    this.playerTarget = new PlayerCombatant(this.player, (amount) => this.hurtPlayer(amount))
    this.combatants.push(this.playerTarget)

    this.fx = new EffectsSystem({
      assets,
      // Box is structurally identical to collision.ts's Body.
      terrain: { isBlocked: (box) => isBlocked(this.level, box) },
      audio: this.audio,
      targets: () => this.combatants,
    })

    this.projectiles = new ProjectileSystem(assets, this.projectileHost(), this.fx.bursts)

    this.backdrop.addChild(this.bgTiles.container)
    this.scene.addChild(
      this.fgTiles.container,
      // Blood marks go over the floor and under everything standing on it,
      // which is the one place the effects subsystem cannot put its own
      // sprites - see the note on EffectsSystem.decals.
      this.fx.decals,
      this.propLayer,
      this.entityLayer,
      this.projectiles.container,
      this.fieldGraphics,
      this.fx.container,
      this.aboveTiles.container,
    )
    this.root.addChild(this.backdrop, this.scene)
    this.entityLayer.addChild(this.player.ghostLayer, this.player.sprite, this.player.topSprite)

    this.props = spawnProps(assets, level.objects)
    // Each of these takes the inert props the level spawned for its own types
    // out of the list and drives them itself.
    this.teleporters = buildTeleporters(assets, level.objects, level.links, this.props)
    this.teleportDoors = buildTeleportDoors(assets, level.objects, level.links, this.props)
    this.ladders = buildLadders(level.objects, level.links)
    this.boulders = buildBoulders(assets, level.objects, level.links, this.props, level)
    // `can_block` holds while one hangs; `updateBoulders` drops it from the
    // list on the tick it is released and starts moving under its own steam.
    // They were taken out of `props`, so the sprite and combatant they would
    // have been given there come from here.
    for (const boulder of this.boulders) {
      this.blockers.push(boulder)
      this.addActor(boulder)
    }
    this.forceFields = buildForceFields(level.objects, this.props, level)

    this.focus = new PlayerFocus(this.player, level)
    this.logic = new LevelLogic(level.objects, level.links, this.logicHost())

    this.enemies = buildEnemies(assets, level.objects, this.props, {
      level,
      // `boundary_setback` over block_list: the doors, steps, lifts and hidden
      // walls a sight line stops at.
      sightBlockers: () => this.sightBlockers(),
      isSignalOn: (index) => this.logic.isOn(index),
      hurtPlayer: (amount) => this.hurtPlayer(amount),
      pushPlayer: (dx) => {
        moveAndCollide(this.level, this.player, dx, 0)
      },
      playSound: (sound, x, y) => this.playEnemySound(sound, x, y),
      // Cosmetic only: the creatures use this for the sparks they throw off
      // when hit and for the boss's cascade, never for damage, so it carries
      // no blast. Deaths go through `deathEffect` instead.
      explode: (x, y, kind) =>
        this.fx.particles.spawn(kind === 'sparks' ? 'EXPLODE6' : 'EXPLODE1', x, y),
      dropPickup: (character, x, y) => this.dropPickup(character, x, y),
      onSpawn: (enemy) => this.addActor(enemy),
      onRemove: (enemy) => this.removeActor(enemy),
      onFire: (shot) => this.fireEnemyShot(shot),
    })

    for (const prop of [...this.props, ...this.teleporters, ...this.teleportDoors, ...this.enemies.members]) {
      this.propLayer.addChild(prop.sprite)
      if (prop.objectIndex >= 0) this.propsByIndex.set(prop.objectIndex, prop)
      if (prop.hurtable) this.addCombatant(prop)
      if (prop.character === 'NEXT_LEVEL') this.exits.push(prop)
      if (prop.character === 'RESTART_POSITION') this.consoles.push(prop)
      if (BLOCKER_TYPES.test(prop.character)) this.blockers.push(prop)
    }

    // The stationary dangers keep their props - they animate and take damage
    // like any other scenery - and only borrow them to run their AI.
    this.hazards = buildHazards(assets, this.props, level.links, {
      playerBox: () => ({
        x: this.player.x,
        y: this.player.y,
        halfWidth: this.player.halfWidth,
        height: this.player.height,
      }),
      isActivated: (index) => (index >= 0 ? this.logic.isActivated(index) : true),
      explode: (x, y, radius, amount) => {
        this.fx.explosions.doExplo(x, y, radius, amount)
      },
      hurtRadius: (x, y, radius, amount) => {
        hurtRadius(this.blastTargets(null), x, y, radius, amount, null, BLAST_MAX_PUSH)
      },
      // `make_view_solid` fills the whole view with one colour for a frame.
      // Nothing here can do that, so this stands in with a big red flash at
      // the mine - the same light an explosion adds, tinted and oversized.
      flashView: () => {
        this.fx.flash(this.player.x, this.player.y - CHEST_HEIGHT, MINE_FLASH_RADIUS, {
          tint: 0xfa0a0a,
        })
      },
      extraFireball: (x, y) => {
        this.fx.particles.spawn('EXPLODE1', x + Math.random() * 10, y + Math.random() * 10 - 20)
      },
      hurtPlayer: (amount) => this.hurtPlayer(amount),
      lavaBurst: (x, y) => this.fx.explosions.lavaEruption(x, y),
      playSound: (name, vol, x, y) => {
        this.audio.playNamed(name, { volume: vol / FULL_VOLUME, x, y })
      },
      remove: (prop) => this.retireProp(prop),
    })

    this.powerHost = new CopPowerHost(this.player, this.fx)
    // FLY's thrum and FAST's chirp, at the volumes cop.cpp passes (32 and 100).
    this.powerHost.emit = (name) => {
      const volume = name === 'FLY_SND' ? 32 : 100
      this.audio.playNamed(name, {
        volume: volume / FULL_VOLUME,
        x: this.player.x,
        y: this.player.y,
      })
    }
    this.powers = new Powers(this.powerHost, {
      hasLegState: (state) => assets.hasState('DARNEL', state),
    })
    this.player.legStates = this.powers

    this.ambience = new AmbientSounds(audio, level.objects)
    this.messages = new TrainMessages(assets, level.objects, trainMessages)
    this.statusBar = new StatusBar(assets)

    this.camera = new Camera(viewWidth, viewHeight)

    const spawn = this.findSpawn()
    this.restartAt = spawn

    // Restoring is the caller's decision, not this one's. Reading the save
    // unconditionally meant "Start New Game" handed you your old health, ammo
    // and kill count whenever the save happened to be for the same level.
    const saved = World.resumeFromSave ? readSave() : null
    World.resumeFromSave = false
    if (saved && saved.level === World.currentLevelId) {
      restore(this.player, saved)
      if (saved.power) this.powers.give(saved.power)
      this.kills = saved.kills
      this.restartAt = { x: saved.x, y: saved.y }
      spawn.x = saved.x
      spawn.y = saved.y
    }

    this.player.setPosition(spawn.x, spawn.y)
    this.camera.snapTo(spawn.x, spawn.y - this.player.height / 2, {
      width: level.widthPx,
      height: level.heightPx,
    })
  }

  private zoom = 1

  resize(viewWidth: number, viewHeight: number, zoom: number): void {
    this.camera.viewWidth = viewWidth
    this.camera.viewHeight = viewHeight
    this.zoom = zoom
    this.lights.resize(Math.ceil(viewWidth * zoom), Math.ceil(viewHeight * zoom))
  }

  update(input: Input): void {
    this.now++
    if (input.pointer.seen) {
      this.pointer = {
        x: this.camera.x + input.pointer.x / this.zoom,
        y: this.camera.y + input.pointer.y / this.zoom,
      }
      this.player.aimAt(this.pointer.x, this.pointer.y)
    }

    const activating = input.state.action || input.state.down
    this.focus.pressingAction = activating

    // The power runs before the movement step, because FAST *is* a movement
    // step: `cop_mover` does `(do_special_power ...)` and only then
    // `(player_move xm ym but)` (lisp/people.lsp). Running it after would
    // double the previous tick's motion instead of this one's.
    this.powerHost.buttons = input.state
    this.powerHost.tick = this.now
    if (!this.player.isDead) {
      this.powers.update({
        xm: axis(input.state.left, input.state.right),
        ym: axis(input.state.up, input.state.down),
        special: input.state.special,
      })
    }
    // Worked out before the player moves, the way `latter_ai` runs over the
    // focus list and sets `in_climbing_area` on the cop before its own handler
    // is reached.
    this.player.climbDepth = climbDepth(this.ladders, this.player.x, this.player.y)
    this.player.climbCentreX = ladderAt(this.ladders, this.player.x, this.player.y)?.centreX ?? null
    if (this.player.climbDepth !== null && !this.player.isClimbing) {
      this.messages.prompt('Press up to climb')
    }

    this.player.update(input.state, input.consumeJump())

    const slot = input.consumeWeapon()
    if (slot !== null) this.player.selectWeapon(slot)
    const step = input.consumeWeaponStep()
    if (step) this.player.cycleWeapon(step > 0 ? 1 : -1)

    this.fireWeapon(input.state.fire)
    this.projectiles.update()

    // One tick of the level's own wiring, then the result is pushed onto the
    // props it drives. `carryRiders` fires inside this call, which is why the
    // lift the player stands on has to have been worked out last tick.
    this.logic.tick()
    this.applyLogicViews()
    this.rideLifts()
    this.updateHiddenWalls()
    this.updateForceFields()
    this.updateBoulders()
    this.hazards.update()
    this.useTeleporters(activating)
    this.useTeleportDoors(activating)
    this.useConsoles(activating)
    this.pushOutOfBlockers()
    this.collectPickups()
    this.updateEnemies()
    this.waitForContinue(input)
    this.retireDead()
    this.fx.update()

    this.camera.follow(this.player.x, this.player.y - this.player.height / 2, {
      width: this.level.widthPx,
      height: this.level.heightPx,
    })

    // The player is the listener, not the camera - the camera lags behind.
    this.audio.setListener(this.player.x, this.player.y)
    this.ambience.update(this.player.x, this.player.y)
    this.messages.update(this.player.x, this.player.y)

    // Down is the original's action key; E/Enter are kept as alternates.
    this.checkExits(activating)
  }

  /* ---------------------------------------------------------------- *
   * the seams the subsystems are wired through
   * ---------------------------------------------------------------- */

  private projectileHost(): ProjectileHost {
    return {
      level: this.level,
      targets: () => this.combatants,
      sightBlockers: () => this.sightBlockers(),
      // Everything in `combatants` is a Combatant, so this is the same object
      // coming back. The `from` is the projectile's own character name, which
      // is what `get_dead_part` reads to decide whether a corpse comes apart
      // flaming, electric or plain (lisp/ant.lsp).
      damage: (target, amount, pushX, pushY, from) => {
        const combatant = target as Combatant
        combatant.hurt(amount, from ?? null, pushX, pushY)
      },
      hurtRadius: (x, y, radius, amount, exclude, maxPush, from) => {
        hurtRadius(this.blastTargets(exclude), x, y, radius, amount, from ?? null, maxPush)
      },
      playSound: (name, x, y) => this.audio.playNamed(name, { volume: 0.6, x, y }),
      pointer: () => this.pointer,
      addLight: (x, y, outer, options) => this.fx.flash(x, y, outer, options),
    }
  }

  private logicHost(): LogicHost {
    const assets = this.assets
    return {
      focuses: () => [this.focus],
      hasState: (type, state) => assets.hasState(type, state),
      frameCount: (type, state) => assets.animation(type, state).length,
      pictureSize: (type, state, frame) => {
        const picture = assets.animation(type, state)[frame]
        return { width: picture?.width ?? 0, height: picture?.height ?? 0 }
      },
      ability: (type, name) => assets.ability(type, name),
      touching: (index, focus) => this.touchingFocus(index, focus),
      isDefeated: (index) => {
        const prop = this.propsByIndex.get(index)
        return prop !== undefined && (prop.isDying || prop.isDead)
      },
      playSound: (sound, volume, x, y) =>
        this.audio.playNamed(sound, { volume: volume / FULL_VOLUME, x, y }),
      carryRiders: (index, dx, dy) => this.carryRiders(index, dx, dy),
    }
  }

  /**
   * `touching_bg` - the object's own picture box overlapping the focus's.
   *
   * The bounds are inclusive, which matters for exactly one caller: a player
   * standing on a lift has his feet at the deck's top edge, and a strict test
   * would say he was not touching the thing he is standing on.
   */
  private touchingFocus(index: number, focus: LogicFocus): boolean {
    const prop = this.propsByIndex.get(index)
    if (!prop) return false

    const box = prop.hitBox
    const { halfWidth, height } = this.player
    if (focus.x + halfWidth < box.left || focus.x - halfWidth > box.right) return false
    return focus.y >= box.top && focus.y - height <= box.bottom
  }

  /** Everything a blast can reach, minus whoever set it off. */
  private *blastTargets(exclude: ProjectileOwner | null): Iterable<Combatant> {
    for (const combatant of this.combatants) {
      if (combatant !== exclude) yield combatant
    }
  }

  /** `ASML_DEATH` and friends resolve through AudioBank's array table. */
  private playEnemySound(sound: EnemySound, x: number, y: number): void {
    this.audio.playNamed(sound, { volume: 0.6, x, y })
  }

  /**
   * An enemy pulling its trigger. `fire_object`'s type argument is the
   * shooter's own aitype, so the round it gets is the round its colour and its
   * health already said it would fire.
   */
  private fireEnemyShot(shot: EnemyShot): void {
    const shooter = shot.shooter ? (this.combatantOf.get(shot.shooter) ?? null) : null
    this.projectiles.fireObject(
      shot.aitype,
      shot.x,
      shot.y,
      shot.angle,
      shooter,
      this.playerTarget,
      shot.velocity,
    )
  }

  /** What a dead monster leaves behind - `ai_ammo` in lisp/guns.lsp. */
  private dropPickup(character: string, x: number, y: number): void {
    if (!this.assets.character(character)) return
    const data: LevelObjectData = {
      type: character,
      state: this.assets.defaultState(character),
      x,
      y,
      direction: 1,
      hp: 0,
      aistate: 0,
      aitype: 0,
      xvel: 0,
      yvel: 0,
      xacel: 0,
      yacel: 0,
    }
    const prop = new Prop(this.assets, data)
    this.props.push(prop)
    this.addActor(prop)
  }

  /* ---------------------------------------------------------------- *
   * damage
   * ---------------------------------------------------------------- */

  private addCombatant(prop: Prop): void {
    if (this.combatantOf.has(prop)) return
    const combatant = new PropCombatant(prop, (target, amount, from) =>
      this.hurtProp(target, amount, from),
    )
    this.combatantOf.set(prop, combatant)
    this.combatants.push(combatant)
  }

  private removeCombatant(prop: Prop): void {
    const combatant = this.combatantOf.get(prop)
    if (!combatant) return
    this.combatantOf.delete(prop)
    const index = this.combatants.indexOf(combatant)
    if (index >= 0) this.combatants.splice(index, 1)
  }

  private addActor(prop: Prop): void {
    this.propLayer.addChild(prop.sprite)
    if (prop.hurtable) this.addCombatant(prop)
  }

  /**
   * Takes a prop out of the world at once, the way a script returning nil
   * does. `retireDead` handles the ordinary case, which is a death animation
   * playing out; this is for the objects that simply cease - an air mine that
   * has spent itself, a bomb that has gone off.
   */
  private retireProp(prop: Prop): void {
    const index = this.props.indexOf(prop)
    if (index >= 0) this.props.splice(index, 1)
    this.propsByIndex.delete(prop.objectIndex)
    const blocker = this.blockers.indexOf(prop)
    if (blocker >= 0) this.blockers.splice(blocker, 1)
    this.removeActor(prop)
  }

  private removeActor(prop: Prop): void {
    prop.sprite.destroy()
    this.removeCombatant(prop)
  }

  /**
   * A hit on a level object.
   *
   * The chain reaction that opens a room from one shot lives here and nowhere
   * else: a dying hidden wall's own blast is `hurt_radius` over its
   * neighbours, they are in `combatants` like everything else, and 60 damage
   * against 25hp blocks kills several of them - so this re-enters itself once
   * per block. A wall already dying is refused, which is what ends it.
   */
  private hurtProp(prop: Prop, amount: number, from: BlastSource | null): void {
    if (prop.isDying || prop.isDead) return
    // `hwall_damage` wraps the whole thing in `(if (activated) ...)`, and the
    // `unactive_shield` flag is what marks a character that works that way: a
    // hidden wall wired to a switch cannot be shot open before the switch has
    // been thrown. An unlinked one is activated by default and still can be.
    if (this.isShielded(prop)) return
    // SWITCH_BALL latches on the first hit; nothing else in the logic cares.
    if (prop.objectIndex >= 0) this.logic.reportDamage(prop.objectIndex)

    // Invented. A hit that does not kill still opens something up, and without
    // this blood only ever appears at the instant of death, which reads as a
    // death animation rather than as a property of the creature. The threshold
    // stops a hidden wall's chain-reaction splash becoming a fountain.
    const bleeds = bloodFor(prop.character)
    if (bleeds && amount >= HIT_SPRAY_MIN_DAMAGE) {
      const wound = prop.hitBox
      this.fx.blood.spit(prop.x, (wound.top + wound.bottom) / 2, bleeds, amount)
    }

    if (!prop.damage(amount, from?.type)) return
    this.kills++
    this.deathEffect(prop, from)
  }

  private hurtPlayer(amount: number): void {
    if (this.player.hurt(amount)) {
      this.audio.playNamed('MG_HIT_SND2', { volume: 0.8, x: this.player.x, y: this.player.y })
    }
  }

  /**
   * What a character comes apart into.
   *
   * Every one of these is an authored cluster in the scripts rather than a
   * generic explosion, which is why this is a dispatch on the character and
   * not a single call. The original never puts a fireball over an ant: ants
   * throw body parts and nothing else (`create_dead_parts`, lisp/ant.lsp).
   */
  private deathEffect(prop: Prop, from: BlastSource | null): void {
    const { explosions, gibs } = this.fx
    const { x, y, character } = prop
    const box = prop.hitBox
    const middle = (box.top + box.bottom) / 2

    if (BIG_WALLS.test(character)) return explosions.bigWallBlast(x, y, from)
    if (SMALL_WALLS.test(character)) return explosions.hiddenWallBlast(x, y, prop.direction, from)
    if (FLYERS.has(character)) {
      // A flyer burns and bleeds. WHO is in this set and is not on the blood
      // roster - it is a robot that borrows `flyer_ai` - so this comes to
      // nothing for it.
      this.fx.blood.burst(x, middle, bloodFor(character))
      return explosions.flyerDeath(x, middle)
    }

    switch (character) {
      case 'SPRAY_GUN':
      case 'TRACK_GUN':
      case 'WALK_ROB':
        // The hit point is not recorded by the time the kill resolves, so the
        // four fireballs go around the middle rather than around the wound.
        return explosions.turretDeath(x, middle, x, y)

      case 'ANT_ROOF':
      case 'HIDDEN_ANT':
        // No explosion at all: an ant comes apart into five body parts and
        // that is the whole of it. The tint index is the ant's own aitype,
        // which is what `ant_draw` colours the live one by.
        return gibs.createDeadParts(
          x,
          y,
          prop.direction,
          'ant',
          gibFlavourFor(from),
          prop.data.aitype,
          bloodFor(character),
        )

      case 'BOSS_ANT':
        // The boss reports a kill on the hit that takes its last form, but it
        // is not dead - `boss_ai` runs a minute of its own cascade first.
        return

      case 'JUGGER':
        return explosions.robotBlownUp(x, y)

      case 'ROB1':
        explosions.robotBlownUp(x, y)
        return explosions.rob1Death(x, y)

      case 'BOLDER':
        // `bolder_ai` scatters five SMALL_BOLDERs with authored velocities;
        // they bounce off walls and burst on the first floor they land on.
        for (const [vx, vy] of CHUNK_VELOCITIES) {
          const chunk = new SmallBoulder(this.assets, x, y, vx, vy)
          this.smallBoulders.push(chunk)
          this.propLayer.addChild(chunk.sprite)
        }
        return explosions.boulderDeath(x, middle)

      default:
        // Scenery. Nothing in the scripts authors a death for a crate, so it
        // gets the four-sprite debris burst `do_small_explo` is built from -
        // no sound and no blast, which is the quiet end the original gives it.
        return explosions.smallCluster(x, middle)
    }
  }

  /* ---------------------------------------------------------------- *
   * the cop's trigger
   * ---------------------------------------------------------------- */

  private fireWeapon(wantsToFire: boolean): void {
    const shot = this.player.tryFire(wantsToFire)
    if (!shot) return

    const spawned = this.projectiles.firePlayer({
      slot: shot.slot,
      shooter: this.playerTarget,
      muzzle: this.player.muzzle,
      angle: this.player.aimAngle,
      from: { x: this.player.x, y: this.player.y - CHEST_HEIGHT },
      target: this.rocketLock(shot.slot),
    })

    // `player_fire_weapon` refuses when the muzzle is not visible from the
    // chest, so a cop pressed into a wall cannot shoot through it - and it
    // costs him nothing.
    if (!spawned) this.player.refund(shot)
  }

  /** `player_rocket_ufun`'s ±160px search, minus the cop doing the searching. */
  private rocketLock(slot: number): ProjectileTarget | null {
    if (slot !== 2) return null
    const lock = this.projectiles.findRocketTarget(this.player.x, this.player.y)
    return lock === this.playerTarget ? null : lock
  }

  /* ---------------------------------------------------------------- *
   * the level's own wiring
   * ---------------------------------------------------------------- */

  /** Pushes the logic's result onto the props that stand for its objects. */
  private applyLogicViews(): void {
    for (const view of this.logic.views) {
      const prop = this.propsByIndex.get(view.index)
      if (!prop) continue

      // Set by hand rather than through `setPosition`, which would collapse
      // the previous position and leave a moving lift nothing to interpolate.
      prop.prevX = prop.x
      prop.prevY = prop.y
      prop.x = view.x
      prop.y = view.y

      if (prop.state !== view.state) prop.setState(view.state, true)
      prop.setFrame(view.frame)
    }
  }

  /**
   * Works out which lift the player is standing on, for `platform_push` to
   * carry next tick.
   *
   * The deck is the top of the lift's own sprite, but the band around it is
   * `start_accel` either way. That is the number `make_smart_plat` gives each
   * lift, and `platform_ai` boards a rider by snapping them to `(- (y)
   * start_accel)` - 22 above the anchor for SMART_PLAT_SMALL, whose picture is
   * only 15 tall, so a player who has just boarded stands 8px clear of the
   * deck. A band that does not span that leaves the cop behind on the first
   * tick of every trip.
   *
   * Which objects `platform_push` considers riders is a C++ primitive and not
   * in the scripts, so the rest of the test is ours: over the deck and not on
   * the way up, so you can still jump up through one.
   */
  private rideLifts(): void {
    this.riding = null

    for (const view of this.logic.views) {
      if (!view.type.startsWith('SMART_PLAT')) continue
      const prop = this.propsByIndex.get(view.index)
      if (!prop) continue

      const box = prop.hitBox
      if (this.player.x < box.left || this.player.x > box.right) continue

      const reach = this.assets.ability(view.type, 'start_accel') ?? 0
      const distance = box.top - this.player.y
      if (this.player.vy < 0 || distance > reach || distance < -reach) continue

      this.player.landOn(box.top)
      this.riding = view.index
      return
    }
  }

  /** `platform_push` - called mid-tick, with the delta the lift is about to move. */
  private carryRiders(index: number, dx: number, dy: number): void {
    if (this.riding !== index) return
    // Upward velocity means they jumped off it; let them go.
    if (this.player.vy < 0) return
    this.player.x += dx
    this.player.y += dy
  }

  /**
   * Runs the force fields. `ff_ai` is gated on `(activated)`, which is true for
   * a field nothing wires and follows the switch for one that is wired - all
   * three in level01 have their own.
   */
  /**
   * Runs the boulders. They hang on `can_block` until their trigger's aistate
   * goes non-zero, then fall, bounce and hurt whatever they roll over.
   */
  private updateBoulders(): void {
    for (let b = this.boulders.length - 1; b >= 0; b--) {
      const boulder = this.boulders[b]
      if (boulder.isDying || boulder.isDead) {
        // Shot apart: run the corpse timer out, then let go of the sprite.
        // `retireDead` never sees a boulder - it was taken out of `props`.
        boulder.tickLifetime()
        if (boulder.isDead) {
          this.boulders.splice(b, 1)
          this.removeActor(boulder)
        }
        continue
      }

      const hanging = !boulder.isReleased
      const events = boulder.update((index) => this.logic.isOn(index))

      if (hanging && boulder.isReleased) {
        // Scenery a tick ago; from now on it moves under its own steam.
        const i = this.blockers.indexOf(boulder)
        if (i >= 0) this.blockers.splice(i, 1)
      }

      if (events.sound) {
        // `(play_sound SBALL_SND 127 ...)` - full volume, like every other
        // sound in the scripts bar the lava's deliberate 64.
        this.audio.playNamed(events.sound, {
          volume: SBALL_VOLUME / FULL_VOLUME,
          x: boulder.x,
          y: boulder.y,
        })
      }
      if (events.hurt) {
        hurtRadius(
          this.blastTargets(boulder),
          events.hurt.x,
          events.hurt.y,
          events.hurt.radius,
          events.hurt.amount,
          null,
          events.hurt.push,
        )
      }
    }

    for (let i = this.smallBoulders.length - 1; i >= 0; i--) {
      const chunk = this.smallBoulders[i]
      const burst = chunk.update(this.level)
      if (burst) {
        this.fx.explosions.smallBoulderLanding(burst.x, burst.y, null)
      }
      if (chunk.isSpent) {
        this.smallBoulders.splice(i, 1)
        chunk.sprite.destroy()
      }
    }
  }

  private updateForceFields(): void {
    for (const field of this.forceFields) {
      field.active = this.logic.isActivated(field.objectIndex)
      if (field.update(this.now, this.player)) {
        this.audio.playNamed('FF_SND', { volume: 0.35, x: field.x, y: field.y })
      }
    }
  }

  /**
   * Keeps the player out of anything solid that is not a tile.
   *
   * Resolved by pushing along whichever axis needs the least movement, after
   * the tile pass rather than inside it - doors and hidden walls are thin
   * slabs standing in corridors, so the shallow axis is always the right one
   * and the player never gets shoved through a floor.
   */
  private pushOutOfBlockers(): void {
    const player = this.player

    // A climbing cop passes through everything - `climb_handler` uses `set_y`
    // with no collision test at all - so nothing may push him out of anything.
    // This was the last of three places writing his position back after the
    // ladder had moved him, which pinned him mid-shaft and read as a ladder
    // that would not climb past a platform.
    if (player.isClimbing) return

    for (const solid of this.solidObjects()) {
      const box = solid.hitBox
      const left = player.x - player.halfWidth
      const right = player.x + player.halfWidth
      const top = player.y - player.height
      const bottom = player.y

      if (right <= box.left || left >= box.right) continue
      if (bottom <= box.top || top >= box.bottom) continue

      const pushRight = box.right - left
      const pushLeft = right - box.left
      const pushDown = box.bottom - top
      const pushUp = bottom - box.top

      // A shallow lip underfoot is a step, not a wall.
      if (pushUp <= BLOCKER_STEP_HEIGHT && player.vy >= 0) {
        player.y = box.top
        player.vy = 0
        player.landOn(box.top)
        continue
      }

      const least = Math.min(pushRight, pushLeft, pushDown, pushUp)

      if (least === pushRight) {
        player.x += pushRight
        player.vx = Math.max(0, player.vx)
      } else if (least === pushLeft) {
        player.x -= pushLeft
        player.vx = Math.min(0, player.vx)
      } else if (least === pushUp) {
        player.y -= pushUp
        if (player.vy > 0) {
          player.vy = 0
          player.landOn(box.top)
        }
      } else {
        player.y += pushDown
        player.vy = Math.max(0, player.vy)
      }
    }
  }

  /** Static geometry, plus whatever the logic says is solid this tick. */
  /**
   * The boxes `can_see` is occluded by - `block_list` in the original.
   *
   * Creature blockers are deliberately left out. The original's list does
   * include the jugger and the wall guns (both set `can_block`), but a creature
   * that blocks its neighbours' line of sight can quietly make a whole room
   * passive, and that is not something this port can be play-tested for here.
   * The geometry - which is what the "shooting through a closed door" complaint
   * was about - is all present.
   */
  /**
   * `unactive_shield` plus `(activated)` being false - the object refuses
   * damage entirely. Eighteen characters carry the flag; the hidden walls are
   * all of them that a level actually wires up.
   */
  private isShielded(prop: Prop): boolean {
    if (!this.assets.hasFlag(prop.character, 'unactive_shield')) return false
    if (prop.objectIndex < 0) return false
    return !this.logic.isActivated(prop.objectIndex)
  }

  /**
   * `hwall_ai` and `big_wall_ai` (lisp/doors.lsp:130-152).
   *
   * A hidden wall wired to exactly one object blows itself open the moment that
   * object's aistate goes non-zero - no shot required. That is the game's
   * commonest reveal: throw the switch, the wall comes down. 2,434 of the 5,093
   * wall segments in the shipped levels are wired that way and were all sitting
   * inert, waiting to be shot instead.
   *
   * The blast itself is `deathEffect`'s already - `hiddenWallBlast` and
   * `bigWallBlast` carry the authored hurt_radius - so this only has to decide
   * when a wall dies.
   */
  private updateHiddenWalls(): void {
    for (const prop of this.blockers) {
      if (prop.isDying || prop.isDead) continue
      if (!this.assets.hasFlag(prop.character, 'unactive_shield')) continue
      if (prop.objectIndex < 0) continue

      // `(and (eq (total_objects) 1) (with_object (get_object 0) (not (eq (aistate) 0))))`
      const links = this.level.links[prop.objectIndex] ?? []
      if (links.length !== 1) continue
      if (!this.logic.isOn(links[0])) continue

      // Straight to the death path: the shield above would refuse ordinary
      // damage, and the wall is not being shot - it is being triggered.
      if (prop.kill()) {
        this.kills++
        this.deathEffect(prop, null)
      }
    }
  }

  private *sightBlockers(): Iterable<{ left: number; top: number; right: number; bottom: number }> {
    for (const prop of this.solidObjects()) yield prop.hitBox
  }

  private *solidObjects(): Iterable<Prop> {
    for (const blocker of this.blockers) {
      if (!blocker.isDying && !blocker.isDead) yield blocker
    }
    for (const view of this.logic.views) {
      if (!view.solid) continue
      const prop = this.propsByIndex.get(view.index)
      if (prop) yield prop
    }
  }

  /* ---------------------------------------------------------------- *
   * creatures, pickups and housekeeping
   * ---------------------------------------------------------------- */

  private updateEnemies(): void {
    const player = this.player

    // `f->xoff() - w/4 .. f->xoff() + w + w/4` - the view, grown a quarter
    // each way, which is the box add_actives is given (src/game.cpp:1954).
    const viewW = this.camera.viewWidth
    const viewH = this.camera.viewHeight
    const active = {
      x1: this.camera.x - viewW / 4,
      y1: this.camera.y - viewH / 4,
      x2: this.camera.x + viewW + viewW / 4,
      y2: this.camera.y + viewH + viewH / 4,
    }

    this.enemies.update(
      {
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        halfWidth: player.halfWidth,
        height: player.height,
        hidden: this.powers.concealment > SNEAKY_THRESHOLD,
      },
      active,
    )

  }

  /**
   * `cop_mover`'s aistate 3: the cop lies where he fell showing `space_cont`
   * until Space or Enter goes down, and only then does `restart_player` run
   * (src/cop.cpp:678-692). Space is bound to jump here and Enter to action, so
   * either counts - which is the same pair the original watches for.
   */
  private waitForContinue(input: Input): void {
    const player = this.player
    if (!player.isDead) return
    if (!player.isAwaitingContinue) return

    if (!input.state.jump && !input.state.action) {
      this.messages.prompt('Press space to continue')
      return
    }

    // Back to the last console used, or the level's start if there was none.
    player.revive(this.restartAt.x, this.restartAt.y)
    // `restart_player` drops the power along with everything else.
    this.powers.clear()
    this.riding = null
  }

  /**
   * Picks up ammo, powers and health the player walks over.
   *
   * The amount an ammo icon gives is its own `start_hp` ability, which is what
   * `giver` reads (lisp/weapons.lsp); the slot it fills comes from
   * `weapon_icon_ai`'s own table rather than from the icon's name, which is
   * how the firebomb and the plasma rifle end up the right way round.
   */
  private collectPickups(): void {
    for (let i = this.props.length - 1; i >= 0; i--) {
      const prop = this.props[i]
      // Both boxes hang off the feet, so compare the spans rather than the
      // centres - the same mistake the ant's contact test made.
      const box = prop.hitBox
      if (box.right < this.player.x - this.player.halfWidth - PICKUP_MARGIN) continue
      if (box.left > this.player.x + this.player.halfWidth + PICKUP_MARGIN) continue
      if (box.bottom < this.player.y - this.player.height - PICKUP_MARGIN) continue
      if (box.top > this.player.y + PICKUP_MARGIN) continue
      if (!this.takePickup(prop)) continue

      prop.sprite.destroy()
      this.props.splice(i, 1)
      this.removeCombatant(prop)
    }
  }

  private takePickup(prop: Prop): boolean {
    const slot = AMMO_ICON_SLOT[prop.character]
    if (slot !== undefined) {
      const rounds = this.assets.ability(prop.character, 'start_hp') ?? 1
      const had = this.player.magazines[slot]
      this.player.magazines[slot] += rounds
      // Picking up ammo for something you were not carrying is how you get it.
      if (had <= 0) this.player.selectWeapon(slot)
      this.audio.playNamed('AMMO_SND', { volume: 0.6, x: prop.x, y: prop.y })
      return true
    }

    const power = powerPickup(prop.character)
    if (power) {
      // The power is set first, so its raised ceiling is what the grant that
      // follows is measured against - `health_power_ai` does them in that order.
      this.powers.give(power.kind)
      if (power.grant) {
        givePlayerHealth(this.player, power.grant, { cap: this.powers.healthCap })
      }
      // No sound: none of fast_ai, fly_power_ai, sneaky_power_ai or
      // health_power_ai plays one (lisp/powerup.lsp:39-108), and neither does
      // `give_player_health`. The heart's HEALTH_UP_SND is the heart's own.
      return true
    }

    if (prop.character === 'HEALTH') {
      // `hp_up` is `(and (touching_bg) (give_player_health 20))`, so a player
      // at full health leaves the heart lying there for later.
      const healed = givePlayerHealth(this.player, HEART_HEAL, { cap: this.powers.healthCap })
      if (!healed) return false
      // No sound: none of fast_ai, fly_power_ai, sneaky_power_ai or
      // health_power_ai plays one (lisp/powerup.lsp:39-108), and neither does
      // `give_player_health`. The heart's HEALTH_UP_SND is the heart's own.
      return true
    }

    return false
  }

  /**
   * Ages every corpse and clears the ones that have run their timer out.
   *
   * Only the props: the creatures own their own removal and never set Prop's
   * `dead` flag, so ticking them here would destroy each sprite twice.
   */
  private retireDead(): void {
    for (let i = this.props.length - 1; i >= 0; i--) {
      const prop = this.props[i]
      prop.tickLifetime()
      if (!prop.isDead) continue

      this.props.splice(i, 1)
      this.propsByIndex.delete(prop.objectIndex)
      this.removeActor(prop)
    }

    // Blockers are the same objects `props` owns, so they are pruned rather
    // than retired - ticking them here as well would run every corpse timer
    // twice and destroy each sprite a second time.
    for (let i = this.blockers.length - 1; i >= 0; i--) {
      if (this.blockers[i].isDead) this.blockers.splice(i, 1)
    }
  }

  /**
   * Runs the save consoles: stand at one, press down, and the level id, your
   * position and everything you are carrying go to localStorage. It also moves
   * where dying puts you, which is the half of "save" that matters in play.
   *
   * `restart_ai` leaves the console on aistate 1 once it has been used - 0 is
   * only ever the never-touched state - so a console is also a one-shot signal
   * source, and the levels wire it like one: level02's door at 339,1274 is held
   * shut by the console beside it, and level09, level17, level18, level21 and
   * frabs18 gate doors, hidden walls and a dimmer the same way. That is why the
   * signal is set here and never cleared.
   */
  private useConsoles(activating: boolean): void {
    for (const console of this.consoles) {
      const lit = this.consoleLit.get(console) ?? 0
      if (lit > 0) {
        if (lit === 1) console.setState('stopped', true)
        this.consoleLit.set(console, lit - 1)
      }

      if (!activating || lit > 0) continue
      if (Math.abs(console.x - this.player.x) > CONSOLE_REACH_X) continue
      if (Math.abs(console.y - this.player.y) > CONSOLE_REACH_Y) continue

      this.restartAt = { x: console.x, y: this.player.y }
      const state = snapshot(
        World.currentLevelId,
        this.player,
        this.powers.kind,
        this.restartAt,
        this.kills,
        this.now,
      )
      const ok = writeSave(state)

      console.setState('running', true)
      if (console.objectIndex >= 0) this.logic.signals.setState(console.objectIndex, 1)
      this.consoleLit.set(console, CONSOLE_LIT_TICKS)
      this.savedMessage = ok ? CONSOLE_LIT_TICKS : 0
      this.audio.playNamed('SAVE_SND', { volume: 0.7, x: console.x, y: console.y })
    }

    if (this.savedMessage > 0) this.savedMessage--
  }

  /**
   * Runs the TP_DOOR pairs: they slide open on approach, open their partner
   * with them, and carry the player across while the action key is held.
   *
   * The key is the part nothing tells you about, so standing in an open
   * doorway and having nothing happen is the expected first experience. It
   * gets a prompt, the same as the exits did.
   */
  private useTeleportDoors(activating: boolean): void {
    for (const door of this.teleportDoors) {
      const sound = door.update(this.player.x, this.player.y)
      if (sound) this.audio.playNamed(sound, { volume: 0.6, x: door.x, y: door.y })

      // Runs whether or not the player is in this door: a door holding the
      // player has to see the key come up to let go of them.
      const willing = door.offer(activating)

      if (!door.covers(this.player.x, this.player.y)) continue
      if (!door.partner) continue

      if (!activating) {
        this.messages.prompt('Press down to step through')
        continue
      }
      if (!willing) continue

      this.player.setPosition(door.partner.x, door.partner.y)
      this.player.vx = 0
      this.player.vy = 0
      this.riding = null
      // The far door now holds the player, so holding the key down cannot
      // bounce them straight back - `(with_object (get_object 0) (link_object player))`.
      door.partner.claim()
      this.audio.playNamed('TELE_SND', { volume: 0.7, x: door.partner.x, y: door.partner.y })
      return
    }
  }

  private useTeleporters(activating: boolean): void {
    for (const pad of this.teleporters) {
      const { hold, arrival } = pad.update()

      // The pad owns the player for the length of its animation: pinned in
      // place, fading, and neither shooting nor able to be shot.
      if (hold) {
        this.player.setPosition(hold.x, hold.y)
        this.player.vx = 0
        this.player.vy = 0
        this.riding = null
        this.player.isTeleporting = true
        this.player.teleportFade = hold.fade
        continue
      }

      if (arrival) {
        this.player.setPosition(arrival.x, arrival.y)
        this.player.vx = 0
        this.player.vy = 0
        this.riding = null
        this.player.isTeleporting = false
        this.player.teleportFade = 0
        continue
      }

      if (!activating || pad.isCharging) continue
      if (!pad.covers(this.player.x, this.player.y)) continue
      if (pad.trigger()) this.audio.playNamed('TELEPORTER_SND', { x: pad.x, y: pad.y })
    }
  }

  /**
   * Standing on an exit with the action key held requests the next level, and
   * standing near one says so.
   *
   * The levels put no TRAIN_MSG on their exits - the original expects you to
   * recognise the portal - so without the prompt you can walk past the end of
   * a level without knowing it was there. The prompt radius is wider than the
   * one that actually works, so the message arrives before the spot does.
   */
  private checkExits(activating: boolean): void {
    if (this.requestedLevel) return

    for (const exit of this.exits) {
      const dx = Math.abs(exit.x - this.player.x)
      const dy = Math.abs(exit.y - this.player.y)
      if (dx > EXIT_PROMPT_X || dy > EXIT_PROMPT_Y) continue

      const destination = `level ${String(exit.data.aistate).padStart(2, '0')}`
      if (dx > EXIT_REACH_X || dy > EXIT_REACH_Y) {
        this.messages.prompt(`Exit to ${destination} - stand on it and press down`)
        continue
      }

      this.messages.prompt(`Press down to enter ${destination}`)
      if (!activating) continue

      this.requestedLevel = `levels/level${String(exit.data.aistate).padStart(2, '0')}`
      return
    }
  }

  get exitCount(): number {
    return this.exits.length
  }

  /* ---------------------------------------------------------------- *
   * drawing
   * ---------------------------------------------------------------- */

  render(alpha: number, renderer: Renderer): void {
    const { camera } = this
    const viewW = camera.viewWidth
    const viewH = camera.viewHeight

    const { xmul, xdiv, ymul, ydiv } = this.level.bgScroll
    const bgX = (camera.x * xmul) / xdiv
    const bgY = (camera.y * ymul) / ydiv

    this.bgTiles.update(bgX, bgY, viewW, viewH)
    this.fgTiles.update(camera.x, camera.y, viewW, viewH)
    this.aboveTiles.update(camera.x, camera.y, viewW, viewH)

    this.updateProps(camera.x, camera.y, viewW, viewH, alpha)
    this.player.draw(alpha)
    // After the cop's own draw, because the power multiplies onto the alpha
    // the invulnerability blink has already set.
    this.player.drawPowers(this.powers.visuals)
    this.projectiles.draw(alpha)
    this.fx.draw(alpha)

    this.fieldGraphics.clear()
    for (const field of this.forceFields) field.draw(this.fieldGraphics)

    // Layers are placed in world space; the containers carry the camera offset.
    //
    // Both offsets are snapped to whole game pixels. The camera itself stays
    // fractional so the follow stays smooth, but drawing at a fraction of a
    // pixel puts the whole scene half a texel off its own grid: with
    // nearest-neighbour sampling that makes pixel edges wobble as you walk,
    // and it leaves the CRT's scanlines nothing fixed to line up against.
    this.backdrop.position.set(-Math.round(bgX), -Math.round(bgY))
    this.scene.position.set(-Math.round(camera.x), -Math.round(camera.y))

    // Renders to its own target, so it has to happen before the main pass.
    //
    // The dynamic half is two lists - the explosion flashes and whatever the
    // projectiles are throwing this frame - merged into one array that is
    // reused rather than rebuilt, because with a weapon held down this is
    // every frame rather than only the frames something goes off.
    const { minLight, lights } = this.level.lighting
    this.dynamicLights.length = 0
    this.dynamicLights.push(...this.fx.lights, ...this.projectiles.lights)
    this.lights.update(
      renderer,
      lights,
      this.dynamicLights,
      minLight,
      camera.x,
      camera.y,
      this.zoom,
    )

    // The ramp is 0..120 on the palette's 0..255 red channel.
    this.hurtFlash.clear()
    if (this.player.hurtRamp > 0) {
      this.hurtFlash.rect(0, 0, viewW * this.zoom, viewH * this.zoom)
      this.hurtFlash.fill({ color: 0xff0000, alpha: this.player.hurtRamp / 255 })
    }

    this.messages.layout(viewW, viewH, this.zoom)
    this.statusBar.setHealth(this.player.health)
    this.statusBar.setWeapon(this.player.weapon, this.player.magazines)
    this.statusBar.layout(viewW, viewH, this.zoom)
  }

  /**
   * Animates and draws the level objects in view. Off-screen props are hidden
   * and left un-animated - nothing observes them, so nothing is lost, and a
   * big level can hold several hundred.
   */
  private updateProps(
    cameraX: number,
    cameraY: number,
    viewW: number,
    viewH: number,
    alpha: number,
  ): void {
    // Generous margin: props are anchored at the feet and can be tall.
    const margin = 64
    const left = cameraX - margin
    const top = cameraY - margin
    const right = cameraX + viewW + margin
    const bottom = cameraY + viewH + margin

    let visible = 0
    for (const prop of [
      ...this.props,
      ...this.teleporters,
      ...this.teleportDoors,
      ...this.enemies.members,
      ...this.boulders,
      ...this.smallBoulders,
    ]) {
      if (prop.x < left || prop.x > right || prop.y < top || prop.y > bottom) {
        prop.sprite.visible = false
        continue
      }
      prop.advance(1 / TICK_HZ)
      prop.draw(alpha)
      visible++
    }
    this.visibleProps = visible
  }

  get spriteCount(): number {
    return (
      this.bgTiles.spriteCount +
      this.fgTiles.spriteCount +
      this.aboveTiles.spriteCount +
      this.visibleProps +
      1
    )
  }

  get propCounts(): { visible: number; total: number } {
    return {
      visible: this.visibleProps,
      // Everything `updateProps` walks, so the two halves agree. The doors and
      // the boulders were missing, which let the visible count exceed the total.
      total:
        this.props.length +
        this.teleporters.length +
        this.teleportDoors.length +
        this.enemies.members.length +
        this.boulders.length +
        this.smallBoulders.length,
    }
  }

  /** The power in hand, for the debug HUD. */
  get powerLabel(): PowerKind | null {
    return this.powers.kind
  }

  get powerActive(): boolean {
    return this.powers.active
  }

  get status(): string {
    const spinning = this.teleporters.filter((t) => t.isCharging).length
    const shots = this.projectiles.liveCount
    return (
      `${this.teleporters.length} tele${spinning ? '(spinning)' : ''}` +
      `${this.riding !== null ? ' riding' : ''}` +
      `${shots ? ` ${shots} shots` : ''}` +
      `${this.fx.particles.liveCount ? ` ${this.fx.particles.liveCount} puffs` : ''}` +
      `${this.fx.gibs.liveCount ? ` ${this.fx.gibs.liveCount} gibs` : ''}` +
      `${this.fx.motes.liveCount ? ` ${this.fx.motes.liveCount} motes` : ''}` +
      `${this.fx.blood.dropletCount ? ` ${this.fx.blood.dropletCount} blood` : ''}` +
      `${this.fx.blood.decalCount ? ` ${this.fx.blood.decalCount} marks` : ''}` +
      `${this.dynamicLights.length ? ` ${this.dynamicLights.length} lights` : ''}` +
      ` ${this.enemies.members.length} live` +
      ` logic ${this.logic.counts.on}/${this.logic.counts.objects}` +
      `${this.kills ? ` kills ${this.kills}` : ''}`
    )
  }

  get ambientCount(): number {
    return this.ambience.count
  }

  /**
   * The gore switch. Off clears what is already down as well as stopping any
   * more - a half-cleaned room reads worse than either state.
   */
  get gore(): boolean {
    return this.fx.blood.enabled
  }

  set gore(on: boolean) {
    this.fx.blood.enabled = on
    if (!on) this.fx.blood.clear()
  }

  /**
   * Releases everything this world owns. Pixi does not free display objects on
   * removal, and swapping levels would otherwise leak a render texture plus a
   * few thousand sprites each time.
   */
  destroy(): void {
    this.projectiles.clear()
    this.fx.clear()
    this.lights.destroy()
    this.messages.destroy()
    this.statusBar.destroy()
    this.root.destroy({ children: true })
  }

  /**
   * Tick count, used only to stamp saves and to beat the force fields. The
   * loop already counts, and this keeps the world free of wall-clock reads.
   */
  private now = 0

  /**
   * Picks a start position: the level's START marker, falling back to a
   * respawn point, then nudged out of any rock it happens to sit in and
   * dropped onto the first floor below.
   */
  private findSpawn(): { x: number; y: number } {
    const marker = this.level.findObject('START', 'RESTART_POSITION')
    const probe = {
      x: marker?.x ?? this.level.widthPx / 2,
      y: marker?.y ?? this.level.heightPx / 2,
      halfWidth: this.player.halfWidth,
      height: this.player.height,
    }

    probe.y = clearSpawnY(this.level, probe)
    for (let i = 0; i < 400 && !isGrounded(this.level, probe); i++) {
      probe.y += 2
      if (isBlocked(this.level, probe)) {
        probe.y -= 2
        break
      }
    }

    return { x: probe.x, y: probe.y }
  }

  /** Object markers, exposed for the debug HUD. */
  get objectSummary(): string {
    const counts = new Map<string, number>()
    for (const o of this.level.objects) counts.set(o.type, (counts.get(o.type) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([type, n]) => `${type}x${n}`)
      .join(' ')
  }
}

/** How far from the marker to look for room, and in what steps. */
const SPAWN_SEARCH_REACH = 256
const SPAWN_SEARCH_STEP = 4

/**
 * The nearest y to the marker's own where the cop actually fits.
 *
 * START markers sit wherever the level editor dropped them, which is not
 * always somewhere a 28px body fits: level03's hangs in a 45px shaft with the
 * cop's head a row into the ceiling, and the original does not care because it
 * inserts him regardless and lets him fall. Ours has to place a box, so it
 * looks outwards - down before up at equal distance, because a marker that
 * does not fit is hanging over the floor it belongs on.
 *
 * Searching upwards only, which is what this used to do, walked the cop
 * straight out through the top of the map on level03. Outside the map reads as
 * solid rock, so every step up stayed blocked, and he ended the search 256px
 * above the level, standing in nothing.
 */
function clearSpawnY(level: Level, probe: Body): number {
  const origin = probe.y
  if (!isBlocked(level, probe)) return origin

  for (let offset = SPAWN_SEARCH_STEP; offset <= SPAWN_SEARCH_REACH; offset += SPAWN_SEARCH_STEP) {
    for (const y of [origin + offset, origin - offset]) {
      if (y < 0 || y > level.heightPx) continue
      probe.y = y
      if (!isBlocked(level, probe)) return y
    }
  }

  // Nothing clear within reach. Leave him on the marker rather than somewhere
  // arbitrary - buried in the level he can at least walk out of it.
  probe.y = origin
  return origin
}

/**
 * The cop as the level logic sees him: a position, whether the action key is
 * down, and two ways to be moved by a lift.
 */
class PlayerFocus implements LogicFocus {
  pressingAction = false

  constructor(
    private readonly player: Player,
    private readonly level: Level,
  ) {}

  get x(): number {
    return this.player.x
  }

  get y(): number {
    return this.player.y
  }

  /** `try_move` - shift, stopping at the first solid tile. */
  tryMove(dx: number, dy: number): void {
    moveAndCollide(this.level, this.player, dx, dy)
  }

  /**
   * `set_y` - raw placement, which is how a lift takes you aboard.
   *
   * Refused while the cop is on a ladder. `player_move` dispatches to
   * `climb_handler` *instead of* the mover, so a ladder owns the tick outright;
   * letting a platform write his position back afterwards pinned him in place
   * three pixels below where he had just climbed to, every tick, and looked
   * exactly like the ladder itself was broken.
   */
  setFeetY(y: number): void {
    if (this.player.isClimbing) return
    this.player.y = y
    this.player.landOn(y)
  }

  /**
   * A spring's shove, converted out of the original's units on the way in.
   *
   * It arrives after `player.update` has already run, so the cop leaves the
   * ground on the next tick rather than this one - a frame either way at 60Hz,
   * and it keeps the spring reading the position the player actually stopped
   * at.
   */
  boost(yvel: number): void {
    this.player.vy += speed(yvel)
  }
}

/**
 * What the special powers are allowed to touch.
 *
 * Thin on purpose: everything except `step` is a straight forward to the cop,
 * and `step` is a whole movement tick because that is literally how FAST works
 * - `do_special_power` runs a second `player_move` before the tick's own.
 */
class CopPowerHost {
  /** Set each tick by the world, for FAST's every-sixteenth-tick sound. */
  tick = 0
  /** Set by the world so the powers can be heard. */
  emit: ((name: 'FLY_SND' | 'SPEED_SND') => void) | null = null

  playSound(name: 'FLY_SND' | 'SPEED_SND'): void {
    this.emit?.(name)
  }

  /**
   * The buttons this tick was read with. FAST's extra step re-uses them rather
   * than inventing its own, so holding shift still decides how fast the second
   * step goes and the power stacks on top of the run instead of replacing it.
   */
  buttons: InputState | null = null

  constructor(
    private readonly player: Player,
    private readonly fx: EffectsSystem,
  ) {}

  get x(): number {
    return this.player.x
  }

  set x(value: number) {
    this.player.x = value
  }

  get y(): number {
    return this.player.y
  }

  set y(value: number) {
    // See setFeetY - a climbing cop is not the mover's to move.
    if (this.player.isClimbing) return
    this.player.y = value
  }

  get vy(): number {
    return this.player.vy
  }

  set vy(value: number) {
    this.player.vy = value
  }

  get facing(): 1 | -1 {
    return this.player.direction < 0 ? -1 : 1
  }

  get legHeight(): number {
    return this.player.currentFrame?.height ?? 0
  }

  get legState(): string {
    return this.player.state
  }

  step(): void {
    if (!this.buttons) return
    // The jump is not re-armed: `consumeJump` is edge-triggered, and letting a
    // single press through twice in one tick would be a double jump.
    this.player.update(this.buttons, false)
  }

  setLegState(state: string): void {
    this.player.setLegState(state)
  }

  coolWeapon(ticks: number): void {
    this.player.coolWeapon(ticks)
  }

  spawnCloud(x: number, y: number): void {
    this.fx.particles.spawn('CLOUD', x, y)
  }
}

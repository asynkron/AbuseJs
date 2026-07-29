import { Container, type Renderer } from 'pixi.js'

import type { GameAssets } from '../assets/loader'
import type { AudioBank } from '../audio/AudioBank'
import { AmbientSounds } from '../audio/AmbientSounds'
import { Camera } from '../core/camera'
import type { Input } from '../core/input'
import { TICK_HZ } from '../core/loop'
import { LightLayer } from '../render/LightLayer'
import { TileLayer } from '../render/TileLayer'
import { Level } from './Level'
import { Player } from './Player'
import { Bullets } from './Bullets'
import { Signals } from './Signals'
import { buildPlatforms, type Platform } from './Platform'
import { spawnProps, type Prop } from './Prop'
import { buildTeleporters, type Teleporter } from './Teleporter'
import { StatusBar } from '../render/StatusBar'
import { TrainMessages } from './TrainMessages'
import { isBlocked, isGrounded } from './collision'

/** Damage one machine gun round does, from `do_damage 5` in weapons.lsp. */
const BULLET_DAMAGE = 5

/** How close the player must stand to an exit portal to use it. */
const EXIT_REACH_X = 20
const EXIT_REACH_Y = 40

/**
 * Owns a loaded level and everything drawn in it.
 *
 * The display list mirrors the original draw order (src/game.cpp): background
 * tiles, foreground tiles, objects, then the tiles flagged "above" - which is
 * how the player ends up walking behind pillars and doorframes.
 */
export class World {
  readonly root = new Container()

  private readonly backdrop = new Container()
  private readonly scene = new Container()
  private readonly propLayer = new Container()
  private readonly entityLayer = new Container()

  /** Level objects, drawn behind the player. */
  private readonly props: Prop[]
  private readonly platforms: Platform[]
  private readonly teleporters: Teleporter[]
  /** The platform the player is standing on, so it can carry them. */
  private riding: Platform | null = null
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

  /** Level ambience, driven from the camera position. */
  private readonly ambience: AmbientSounds

  /**
   * Exit portals. NEXT_LEVEL stores its destination level number in `aistate`
   * (lisp/people.lsp, next_level_ai) and the original triggers on touching it
   * with the action key held.
   */
  private readonly exits: Prop[] = []

  /** Set when the player uses an exit; main.ts polls and swaps levels. */
  requestedLevel: string | null = null

  /** Tutorial text overlay, in screen space. */
  readonly messages: TrainMessages

  /** The original status bar, in screen space. */
  readonly statusBar: StatusBar

  /** Machine gun fire, drawn over the props but under the above-tiles. */
  private readonly bullets = new Bullets()

  /** Sensors, gates and the objects they drive. */
  private readonly signals: Signals
  /** Props that can be shot, kept separate so bullets do not scan everything. */
  private readonly targets: Prop[] = []
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

    this.backdrop.addChild(this.bgTiles.container)
    this.scene.addChild(
      this.fgTiles.container,
      this.propLayer,
      this.entityLayer,
      this.bullets.graphics,
      this.aboveTiles.container,
    )
    this.root.addChild(this.backdrop, this.scene)

    this.props = spawnProps(assets, level.objects)
    // Platforms take over from the inert props the level spawned for them.
    this.platforms = buildPlatforms(assets, level.objects, level.links, this.props)
    this.teleporters = buildTeleporters(assets, level.objects, level.links, this.props)

    for (const prop of [...this.props, ...this.platforms, ...this.teleporters]) {
      this.propLayer.addChild(prop.sprite)
      if (prop.character === 'NEXT_LEVEL') this.exits.push(prop)
    }

    this.signals = new Signals(level.objects, level.links)
    for (const prop of this.props) if (prop.hurtable) this.targets.push(prop)

    this.ambience = new AmbientSounds(audio, level.objects)
    this.messages = new TrainMessages(assets, level.objects, trainMessages)
    this.statusBar = new StatusBar(assets)

    this.camera = new Camera(viewWidth, viewHeight)

    this.player = new Player(assets, level)
    this.entityLayer.addChild(this.player.sprite, this.player.topSprite)

    const spawn = this.findSpawn()
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
    if (input.pointer.seen) {
      this.player.aimAt(
        this.camera.x + input.pointer.x / this.zoom,
        this.camera.y + input.pointer.y / this.zoom,
      )
    }

    // Platforms move, then the player's own physics runs, then the carry and
    // the landing snap are applied. The carry has to come *after* the player's
    // update: that is what captures the position render interpolation starts
    // from, so carrying beforehand would make the player jump a tick ahead of
    // the platform it is standing on.
    for (const platform of this.platforms) platform.update()
    const activating = input.state.action || input.state.down
    this.player.update(input.state, input.consumeJump())
    this.ridePlatforms(activating)
    this.useTeleporters(activating)
    this.fireWeapon(input.state.fire)

    this.signals.update(this.player.x, this.player.y)
    this.applySignals()

    this.camera.follow(this.player.x, this.player.y - this.player.height / 2, {
      width: this.level.widthPx,
      height: this.level.heightPx,
    })

    // The player is the listener, not the camera - the camera lags behind.
    this.audio.setListener(this.player.x, this.player.y)
    this.ambience.update(this.player.x, this.player.y)
    this.messages.update(this.player.x, this.player.y)

    // Down is the original's action key; E/Enter are kept as alternates.
    if (activating) this.checkExits()
  }

  /**
   * Lands the player on any platform they are falling onto, and sends that
   * platform on its way if they press the action key while standing there.
   */
  private ridePlatforms(activating: boolean): void {
    const wasRiding = this.riding
    this.riding = null

    // Carry along with whatever was being ridden last tick. The downward
    // component matters: a descending platform would otherwise drop out from
    // under the player, who free-falls and re-lands on it every few ticks -
    // which reads as the platform bouncing. Upward velocity means they jumped,
    // so let them go.
    if (wasRiding && this.player.vy >= 0) {
      this.player.x += wasRiding.deltaX
      if (wasRiding.deltaY > 0) this.player.y += wasRiding.deltaY
    }

    for (const platform of this.platforms) {
      const { left, right, y } = platform.surface
      if (this.player.x < left || this.player.x > right) continue

      // Land only when coming down onto it, so you can still jump up through
      // one. The reach below the surface is the platform's own `start_accel`,
      // which is what the original uses to pull a boarding player up.
      const distance = y - this.player.y
      if (this.player.vy < 0 || distance > 1 || distance < -platform.boardingReach) continue

      this.player.landOn(y)
      this.riding = platform

      if (activating) platform.trigger()
      return
    }
  }

  /**
   * Lets the logic network drive the world: doors and force fields play their
   * `running` state while switched on, and a platform wired to a switch runs
   * on its own whenever that switch is live.
   */
  private applySignals(): void {
    for (const prop of this.props) {
      if (prop.objectIndex < 0 || prop.isDying || prop.isDead) continue
      if (!this.assets.hasState(prop.character, 'running')) continue
      if ((this.level.links[prop.objectIndex] ?? []).length === 0) continue

      const on = this.signals.isDriven(prop.objectIndex)
      const wanted = on ? 'running' : 'stopped'
      if (prop.state !== wanted) prop.setState(wanted, true)
    }

    for (const platform of this.platforms) {
      if (platform.isMoving) continue
      // The third link is the platform's switch; with one wired, the switch
      // runs it rather than the player.
      const switches = (this.level.links[platform.objectIndex] ?? []).slice(2)
      if (switches.length === 0) continue
      if (switches.some((i) => this.signals.isActive(i))) platform.trigger()
    }
  }

  /**
   * Fires the machine gun and advances the shots already in the air.
   *
   * Impact sounds alternate at random between the two the original uses
   * (lisp/weapons.lsp, mbullet_ai).
   */
  private fireWeapon(wantsToFire: boolean): void {
    const shot = this.player.tryFire(wantsToFire)
    if (shot) {
      this.bullets.spawn(shot.x, shot.y, shot.angle)
      this.audio.playNamed('MGUN_SND', { volume: 0.5, x: shot.x, y: shot.y })
    }

    for (const impact of this.bullets.update(this.level, this.targets)) {
      if (impact.hit?.damage(BULLET_DAMAGE)) this.kills++
      const which = Math.random() < 0.5 ? 'MG_HIT_SND1' : 'MG_HIT_SND2'
      this.audio.playNamed(which, { volume: 0.6, x: impact.x, y: impact.y })
    }

    // Retire anything whose corpse has lingered long enough.
    for (let i = this.props.length - 1; i >= 0; i--) {
      const prop = this.props[i]
      if (!prop.isDead) continue
      prop.sprite.destroy()
      this.props.splice(i, 1)
      const t = this.targets.indexOf(prop)
      if (t >= 0) this.targets.splice(t, 1)
    }
  }

  /**
   * Runs the teleporter pads: standing on one and pressing down starts its
   * spin, and when the spin finishes the player is put down at the pad it is
   * linked to.
   */
  private useTeleporters(activating: boolean): void {
    for (const pad of this.teleporters) {
      const arrival = pad.update()
      if (arrival) {
        this.player.setPosition(arrival.x, arrival.y)
        this.player.vx = 0
        this.player.vy = 0
        this.riding = null
        continue
      }

      if (!activating || pad.isCharging) continue
      if (!pad.covers(this.player.x, this.player.y)) continue
      if (pad.trigger()) this.audio.playNamed('TELEPORTER_SND', { x: pad.x, y: pad.y })
    }
  }

  /** Standing on an exit with the action key held requests the next level. */
  private checkExits(): void {
    if (this.requestedLevel) return

    for (const exit of this.exits) {
      if (Math.abs(exit.x - this.player.x) > EXIT_REACH_X) continue
      if (Math.abs(exit.y - this.player.y) > EXIT_REACH_Y) continue

      const destination = exit.data.aistate
      this.requestedLevel = `levels/level${String(destination).padStart(2, '0')}`
      return
    }
  }

  get exitCount(): number {
    return this.exits.length
  }

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
    this.bullets.draw()

    // Layers are placed in world space; the containers carry the camera offset.
    this.backdrop.position.set(-bgX, -bgY)
    this.scene.position.set(-camera.x, -camera.y)

    // Renders to its own target, so it has to happen before the main pass.
    const { minLight, lights } = this.level.lighting
    this.lights.update(renderer, lights, minLight, camera.x, camera.y, this.zoom)

    this.messages.layout(viewW, viewH, this.zoom)
    this.statusBar.setHealth(this.player.health)
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
    for (const prop of [...this.props, ...this.platforms, ...this.teleporters]) {
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
      total: this.props.length + this.platforms.length + this.teleporters.length,
    }
  }

  get platformStatus(): string {
    const moving = this.platforms.filter((p) => p.isMoving).length
    const spinning = this.teleporters.filter((t) => t.isCharging).length
    const shots = this.bullets.liveCount
    return (
      `${this.platforms.length} plat${moving ? `(${moving} moving)` : ''}` +
      `${this.riding ? ' riding' : ''} ${this.teleporters.length} tele${spinning ? '(spinning)' : ''}` +
      `${shots ? ` ${shots} shots` : ''}` +
      ` sig ${this.signals.counts.active}/${this.signals.counts.sensors + this.signals.counts.gates}` +
      `${this.kills ? ` kills ${this.kills}` : ''}`
    )
  }

  get ambientCount(): number {
    return this.ambience.count
  }

  /**
   * Releases everything this world owns. Pixi does not free display objects on
   * removal, and swapping levels would otherwise leak a render texture plus a
   * few thousand sprites each time.
   */
  destroy(): void {
    this.bullets.clear()
    this.lights.destroy()
    this.messages.destroy()
    this.statusBar.destroy()
    this.root.destroy({ children: true })
  }

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

    for (let i = 0; i < 64 && isBlocked(this.level, probe); i++) probe.y -= 4
    for (let i = 0; i < 400 && !isGrounded(this.level, probe); i++) {
      probe.y += 2
      if (isBlocked(this.level, probe)) {
        probe.y -= 2
        break
      }
    }

    return { x: probe.x, y: probe.y }
  }

  /** Object markers, exposed for the debug HUD until real entities exist. */
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

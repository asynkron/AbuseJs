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
import { buildTurrets, type Turret } from './Turret'
import { buildCeilingAnts, type CeilingAnt } from './CeilingAnt'
import { buildFloaters, type Floater } from './Floater'
import { ammoPickup, POWERS } from './Weapons'
import { Effects } from './Effects'
import { StatusBar } from '../render/StatusBar'
import { TrainMessages } from './TrainMessages'
import { isBlocked, isGrounded } from './collision'

/** What a turret's shot takes off the player. */
const ENEMY_BULLET_DAMAGE = 6
/** Enemy tracers are red, so incoming fire reads at a glance. */
const ENEMY_TRACER = 0xff6a4a

/** What a HEALTH pickup restores. */
const HEALTH_PICKUP = 15
const MAX_HEALTH = 100
/** How close the player has to be to collect something. */
const PICKUP_REACH = 18

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
  private readonly effects: Effects

  /** Level objects, drawn behind the player. */
  private readonly props: Prop[]
  private readonly platforms: Platform[]
  private readonly teleporters: Teleporter[]
  private readonly turrets: Turret[]
  private readonly ants: CeilingAnt[]
  private readonly floaters: Floater[]
  /** Enemy fire, which hits the player rather than props. */
  private readonly enemyBullets = new Bullets()
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
    this.effects = new Effects(assets)
    this.bgTiles = new TileLayer(assets, level, 'back')
    this.fgTiles = new TileLayer(assets, level, 'fore', false)
    this.aboveTiles = new TileLayer(assets, level, 'fore', true)

    this.backdrop.addChild(this.bgTiles.container)
    this.scene.addChild(
      this.fgTiles.container,
      this.propLayer,
      this.entityLayer,
      this.bullets.graphics,
      this.enemyBullets.graphics,
      this.effects.container,
      this.aboveTiles.container,
    )
    this.root.addChild(this.backdrop, this.scene)

    this.props = spawnProps(assets, level.objects)
    // Platforms take over from the inert props the level spawned for them.
    this.platforms = buildPlatforms(assets, level.objects, level.links, this.props)
    this.teleporters = buildTeleporters(assets, level.objects, level.links, this.props)
    this.turrets = buildTurrets(assets, level.objects, this.props)
    this.ants = buildCeilingAnts(assets, level.objects, this.props, level)
    this.floaters = buildFloaters(assets, level.objects, this.props, level)

    for (const prop of [
      ...this.props,
      ...this.platforms,
      ...this.teleporters,
      ...this.turrets,
      ...this.ants,
      ...this.floaters,
    ]) {
      this.propLayer.addChild(prop.sprite)
      if (prop.character === 'NEXT_LEVEL') this.exits.push(prop)
    }

    this.signals = new Signals(level.objects, level.links)
    for (const prop of [...this.props, ...this.turrets, ...this.ants, ...this.floaters]) {
      if (prop.hurtable) this.targets.push(prop)
    }

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
    const slot = input.consumeWeapon()
    if (slot !== null) this.player.selectWeapon(slot)
    const step = input.consumeWeaponStep()
    if (step) this.player.cycleWeapon(step > 0 ? 1 : -1)

    this.player.updatePower(input.state.special)
    this.fireWeapon(input.state.fire)

    this.signals.update(this.player.x, this.player.y)
    this.applySignals()
    this.collectPickups()
    this.updateEnemies()
    this.retireDead()
    this.effects.update()

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
   * Runs the enemies: turrets track and shoot, ceiling ants drop and give
   * chase, and anything that lands on the player hurts them.
   */
  private updateEnemies(): void {
    const player = this.player

    const unseen = player.powerSneaky

    for (const turret of this.turrets) {
      turret.update(player.x, player.y, unseen)
      const shot = turret.takeShot()
      if (!shot) continue
      this.enemyBullets.spawn(shot.x, shot.y, shot.angle, ENEMY_TRACER)
      this.audio.playNamed('MGUN_SND', { volume: 0.35, x: shot.x, y: shot.y })
    }

    for (const ant of this.ants) {
      if (ant.isDying || ant.isDead) continue
      ant.update(player.x, player.y, unseen)

      const shot = ant.takeShot()
      if (shot) {
        this.enemyBullets.spawn(shot.x, shot.y, shot.angle, ENEMY_TRACER)
        this.audio.playNamed('MGUN_SND', { volume: 0.3, x: shot.x, y: shot.y })
      }

      const touch = ant.touchDamage(player.x, player.y, player.halfWidth, player.height)
      if (touch) this.hurtPlayer(touch)
    }

    for (const floater of this.floaters) {
      if (floater.isDying || floater.isDead) continue
      floater.update(player.x, player.y, unseen)
      const touch = floater.touchDamage(player.x, player.y, player.halfWidth, player.height)
      if (touch) this.hurtPlayer(touch)
    }

    const box = {
      left: player.x - player.halfWidth,
      top: player.y - player.height,
      right: player.x + player.halfWidth,
      bottom: player.y + 1,
    }
    for (const impact of this.enemyBullets.update(this.level, [], box)) {
      if (impact.hitPlayer) this.hurtPlayer(ENEMY_BULLET_DAMAGE)
      const which = Math.random() < 0.5 ? 'MG_HIT_SND1' : 'MG_HIT_SND2'
      this.audio.playNamed(which, { volume: 0.5, x: impact.x, y: impact.y })
    }

    // Respawn once the death animation has run its course.
    if (player.isDead) return
    if (player.health <= 0) {
      const spawn = this.findSpawn()
      player.revive(spawn.x, spawn.y)
      this.riding = null
    }
  }

  private hurtPlayer(amount: number): void {
    if (this.player.hurt(amount)) {
      this.audio.playNamed('MG_HIT_SND2', { volume: 0.8, x: this.player.x, y: this.player.y })
    }
  }

  /**
   * Picks up ammo and health the player walks over. The amount an ammo icon
   * gives is in its own name.
   */
  private collectPickups(): void {
    for (let i = this.props.length - 1; i >= 0; i--) {
      const prop = this.props[i]
      if (Math.abs(prop.x - this.player.x) > PICKUP_REACH) continue
      if (Math.abs(prop.y - this.player.y) > PICKUP_REACH) continue

      let taken = false
      const ammo = ammoPickup(prop.character)
      const power = POWERS[prop.character]
      if (ammo) {
        // Ammo goes to its own weapon's magazine, and picking up something you
        // did not have is also how you get the weapon.
        const had = this.player.magazines[ammo.slot]
        this.player.magazines[ammo.slot] += ammo.amount
        if (had <= 0) this.player.selectWeapon(ammo.slot)
        this.audio.playNamed('AMMO_SND', { volume: 0.6, x: prop.x, y: prop.y })
        taken = true
      } else if (power) {
        this.player.givePower(power)
        this.audio.playNamed('HEALTH_UP_SND', { volume: 0.6, x: prop.x, y: prop.y })
        taken = true
      } else if (prop.character === 'HEALTH' && this.player.health < MAX_HEALTH) {
        this.player.health = Math.min(MAX_HEALTH, this.player.health + HEALTH_PICKUP)
        this.audio.playNamed('HEALTH_UP_SND', { volume: 0.6, x: prop.x, y: prop.y })
        taken = true
      }

      if (!taken) continue
      prop.sprite.destroy()
      this.props.splice(i, 1)
      const t = this.targets.indexOf(prop)
      if (t >= 0) this.targets.splice(t, 1)
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
   * Fires whatever is in hand and advances the shots already in the air.
   *
   * Impact sounds alternate at random between the two the original uses
   * (lisp/weapons.lsp, mbullet_ai).
   */
  private fireWeapon(wantsToFire: boolean): void {
    const weapon = this.player.weaponDef
    const shot = this.player.tryFire(wantsToFire)
    if (shot) {
      for (const angle of shot.angles) this.bullets.spawn(shot.x, shot.y, angle, weapon.tracer)
      this.audio.playNamed('MGUN_SND', { volume: 0.5, x: shot.x, y: shot.y })
    }

    for (const impact of this.bullets.update(this.level, this.targets)) {
      if (impact.hit) this.hurtTarget(impact.hit, weapon.damage)
      // Splash catches anything standing near where the shot landed, including
      // things the tracer itself flew past.
      if (weapon.splash > 0) {
        this.effects.explode(impact.x, impact.y)
        for (const target of this.targets) {
          if (target === impact.hit || target.isDying || target.isDead) continue
          const dx = target.x - impact.x
          const dy = target.y - target.height / 2 - impact.y
          if (dx * dx + dy * dy > weapon.splash * weapon.splash) continue
          this.hurtTarget(target, Math.round(weapon.damage * 0.6))
        }
        this.audio.playNamed('P_EXPLODE_SND', { volume: 0.5, x: impact.x, y: impact.y })
      } else {
        const which = Math.random() < 0.5 ? 'MG_HIT_SND1' : 'MG_HIT_SND2'
        this.audio.playNamed(which, { volume: 0.6, x: impact.x, y: impact.y })
      }
    }

  }

  /** Damages a prop, and blows it up if that killed it. */
  private hurtTarget(target: Prop, amount: number): void {
    if (!target.damage(amount)) return
    this.kills++
    // Blow up over the middle of what died, not its feet.
    this.effects.explode(target.x, target.y - target.height / 2)
    this.audio.playNamed('P_EXPLODE_SND', { volume: 0.55, x: target.x, y: target.y })
  }

  /**
   * Ages every corpse and clears the ones that have run their timer out.
   *
   * The actors that got promoted out of `props` - turrets, ants, floaters -
   * have to be swept too. They were not, so a dead one hung around frozen on
   * whichever frame it died on, which for a character with no death state is
   * its flinch: shoot a WHO and it turned red and stayed there.
   */
  private retireDead(): void {
    for (const list of [this.props, this.turrets, this.ants, this.floaters] as Prop[][]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const prop = list[i]
        prop.tickLifetime()
        if (!prop.isDead) continue

        prop.sprite.destroy()
        list.splice(i, 1)
        const t = this.targets.indexOf(prop)
        if (t >= 0) this.targets.splice(t, 1)
      }
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
    this.enemyBullets.draw()
    this.effects.draw()

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
    const { minLight, lights } = this.level.lighting
    this.lights.update(renderer, lights, minLight, camera.x, camera.y, this.zoom)

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
      ...this.platforms,
      ...this.teleporters,
      ...this.turrets,
      ...this.ants,
      ...this.floaters,
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
      total:
        this.props.length +
        this.platforms.length +
        this.teleporters.length +
        this.turrets.length +
        this.ants.length,
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
      ` ${this.turrets.filter((t) => t.isAwake).length}/${this.turrets.length} turrets` +
      ` ${this.ants.filter((a) => a.isActive).length}/${this.ants.length} ants` +
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
    this.enemyBullets.clear()
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

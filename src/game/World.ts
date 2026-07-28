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
import { spawnProps, type Prop } from './Prop'
import { isBlocked, isGrounded } from './collision'

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

  constructor(
    assets: GameAssets,
    readonly level: Level,
    viewWidth: number,
    viewHeight: number,
    private readonly audio: AudioBank,
  ) {
    this.bgTiles = new TileLayer(assets, level, 'back')
    this.fgTiles = new TileLayer(assets, level, 'fore', false)
    this.aboveTiles = new TileLayer(assets, level, 'fore', true)

    this.backdrop.addChild(this.bgTiles.container)
    this.scene.addChild(
      this.fgTiles.container,
      this.propLayer,
      this.entityLayer,
      this.aboveTiles.container,
    )
    this.root.addChild(this.backdrop, this.scene)

    this.props = spawnProps(assets, level.objects)
    for (const prop of this.props) this.propLayer.addChild(prop.sprite)

    this.ambience = new AmbientSounds(audio, level.objects)

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

    this.player.update(input.state, input.consumeJump())
    this.camera.follow(this.player.x, this.player.y - this.player.height / 2, {
      width: this.level.widthPx,
      height: this.level.heightPx,
    })

    // The player is the listener, not the camera - the camera lags behind.
    this.audio.setListener(this.player.x, this.player.y)
    this.ambience.update(this.player.x, this.player.y)
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

    // Layers are placed in world space; the containers carry the camera offset.
    this.backdrop.position.set(-bgX, -bgY)
    this.scene.position.set(-camera.x, -camera.y)

    // Renders to its own target, so it has to happen before the main pass.
    const { minLight, lights } = this.level.lighting
    this.lights.update(renderer, lights, minLight, camera.x, camera.y, this.zoom)
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
    for (const prop of this.props) {
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
    return { visible: this.visibleProps, total: this.props.length }
  }

  get ambientCount(): number {
    return this.ambience.count
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

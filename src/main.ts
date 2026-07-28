import { Application } from 'pixi.js'

import { GameAssets } from './assets/loader'
import { GameLoop } from './core/loop'
import { Input } from './core/input'
import { Level } from './game/Level'
import { World } from './game/World'
import { CrtFilter, crtPixelScale } from './render/CrtFilter'

/**
 * Smallest logical view we are willing to show. The stage is scaled by an
 * integer factor so pixels stay square and crisp; whatever space that leaves
 * over widens the logical view rather than adding letterboxing.
 */
const MIN_VIEW_WIDTH = 480
const MIN_VIEW_HEIGHT = 270

const DEFAULT_LEVEL = 'levels/level00'

const boot = document.getElementById('boot')!
const hud = document.getElementById('hud')!

function say(message: string): void {
  boot.textContent = message
}

/* ------------------------------------------------------------------ */
/* picture controls                                                    */
/* ------------------------------------------------------------------ */

const PICTURE_KEY = 'abusejs.picture'
/**
 * Not 1.0/1.0: the CRT pass's additive ghosting and bloom wash the image out,
 * and this is the trim that reads best against Abuse's dark art.
 */
const PICTURE_DEFAULTS = { brightness: 1.2, contrast: 1.2 }

function loadPictureSettings(): { brightness: number; contrast: number } {
  try {
    const stored = localStorage.getItem(PICTURE_KEY)
    if (!stored) return { ...PICTURE_DEFAULTS }
    const parsed = JSON.parse(stored) as Partial<typeof PICTURE_DEFAULTS>
    return {
      brightness: Number(parsed.brightness) || PICTURE_DEFAULTS.brightness,
      contrast: Number(parsed.contrast) || PICTURE_DEFAULTS.contrast,
    }
  } catch {
    return { ...PICTURE_DEFAULTS }
  }
}

/** Wires the top-right brightness/contrast sliders to the CRT pass. */
function mountPictureControls(crt: CrtFilter): void {
  const panel = document.getElementById('controls') as HTMLDivElement | null
  const brightness = document.getElementById('brightness') as HTMLInputElement | null
  const contrast = document.getElementById('contrast') as HTMLInputElement | null
  const brightnessVal = document.getElementById('brightness-val')
  const contrastVal = document.getElementById('contrast-val')
  const reset = document.getElementById('reset-levels')
  if (!panel || !brightness || !contrast || !brightnessVal || !contrastVal || !reset) return

  const sync = (persist: boolean) => {
    crt.brightness = Number(brightness.value)
    crt.contrast = Number(contrast.value)
    brightnessVal.textContent = crt.brightness.toFixed(2)
    contrastVal.textContent = crt.contrast.toFixed(2)
    if (persist) {
      try {
        localStorage.setItem(
          PICTURE_KEY,
          JSON.stringify({ brightness: crt.brightness, contrast: crt.contrast }),
        )
      } catch {
        // Private browsing and the like - the sliders still work, just not across reloads.
      }
    }
  }

  brightness.value = String(crt.brightness)
  contrast.value = String(crt.contrast)
  sync(false)

  for (const slider of [brightness, contrast]) {
    slider.addEventListener('input', () => sync(true))
    // A focused slider would swallow space and the arrow keys, so hand the
    // keyboard straight back to the game once the drag is over.
    slider.addEventListener('change', () => slider.blur())
    slider.addEventListener('pointerup', () => slider.blur())
  }

  reset.addEventListener('click', () => {
    brightness.value = String(PICTURE_DEFAULTS.brightness)
    contrast.value = String(PICTURE_DEFAULTS.contrast)
    sync(true)
    reset.blur()
  })

  panel.hidden = false
}

function integerZoom(width: number, height: number): number {
  const byWidth = width / MIN_VIEW_WIDTH
  const byHeight = height / MIN_VIEW_HEIGHT
  return Math.max(1, Math.floor(Math.min(byWidth, byHeight)))
}

async function start() {
  const app = new Application()
  await app.init({
    background: 0x05060a,
    resizeTo: window,
    antialias: false,
    roundPixels: true,
    preference: 'webgl',
  })
  app.canvas.id = 'stage'
  document.body.appendChild(app.canvas)

  say('loading assets')
  const assets = await GameAssets.load((label) => say(`loading ${label}`))

  // #levels/level03 in the URL picks a level; anything in levels.json works.
  const requested = decodeURIComponent(location.hash.replace(/^#/, '')) || DEFAULT_LEVEL
  const levelId = assets.levels.some((l) => l.id === requested) ? requested : DEFAULT_LEVEL

  say(`loading ${levelId}`)
  const level = new Level(await assets.loadLevel(levelId), assets)

  let zoom = integerZoom(app.renderer.screen.width, app.renderer.screen.height)
  let viewWidth = Math.ceil(app.renderer.screen.width / zoom)
  let viewHeight = Math.ceil(app.renderer.screen.height / zoom)

  const world = new World(assets, level, viewWidth, viewHeight)
  world.root.scale.set(zoom)
  // The light overlay multiplies over the finished scene, so it sits on top of
  // the world but still inside the stage, and therefore under the CRT pass.
  app.stage.addChild(world.root, world.lights.overlay)

  const input = new Input()

  // The filter stays attached even with the CRT dialled off, so the
  // brightness/contrast trim still applies to the raw image.
  const crt = new CrtFilter(loadPictureSettings())
  app.stage.filters = [crt]

  let crtEnabled = true
  const setCrtEnabled = (on: boolean) => {
    crtEnabled = on
    crt.intensity = on ? 1 : 0
  }

  mountPictureControls(crt)

  // The renderer is the source of truth for size: Pixi's own resizeTo observer
  // can change it without a window resize event ever reaching us.
  let lastWidth = -1
  let lastHeight = -1
  const applySize = () => {
    const { width, height } = app.renderer.screen
    if (width === lastWidth && height === lastHeight) return
    lastWidth = width
    lastHeight = height
    zoom = integerZoom(width, height)
    viewWidth = Math.ceil(width / zoom)
    viewHeight = Math.ceil(height / zoom)
    world.root.scale.set(zoom)
    world.resize(viewWidth, viewHeight, zoom)
    // Keep the pass screen-space; the stage's own bounds are the whole level.
    app.stage.filterArea = app.screen
    crt.pixelScale = crtPixelScale(height)
    crt.setScreenSize(width, height)
  }
  applySize()

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyV') setCrtEnabled(!crtEnabled)
    else if (e.code === 'KeyL') world.lights.enabled = !world.lights.enabled
  })

  let frames = 0
  let fps = 0
  let fpsClock = performance.now()

  const loop = new GameLoop(
    () => world.update(input),
    (alpha) => {
      applySize()
      crt.time = performance.now() / 1000
      world.render(alpha, app.renderer)
      app.render()

      frames++
      const now = performance.now()
      if (now - fpsClock >= 500) {
        fps = Math.round((frames * 1000) / (now - fpsClock))
        frames = 0
        fpsClock = now
        hud.textContent = [
          `${levelId}  "${level.name}"  ${level.fgWidth}x${level.fgHeight} tiles`,
          `pos ${world.player.x.toFixed(0)},${world.player.y.toFixed(0)}  ${world.player.state}` +
            `${world.player.onGround ? '' : ' (air)'}  x${zoom}  ${fps}fps  ${world.spriteCount} sprites` +
            `  ${world.lights.visibleCount}/${level.lighting.lights.length} lights` +
            ` @ambient ${level.lighting.minLight}/63`,
          `props ${world.propCounts.visible}/${world.propCounts.total} drawn   ${world.objectSummary}`,
          `arrows/WASD move   space jump   shift run` +
            `   V crt:${crtEnabled ? 'on' : 'off'}   L light:${world.lights.enabled ? 'on' : 'off'}`,
        ].join('\n')
      }
    },
  )

  // We drive rendering from our own fixed-step loop.
  app.ticker.stop()
  loop.start()

  if (import.meta.env.DEV) {
    // Lets a headless browser step the simulation deterministically; rAF is
    // paused whenever the document reports itself hidden.
    ;(window as unknown as Record<string, unknown>).game = {
      app,
      world,
      input,
      level,
      step(ticks = 1) {
        for (let i = 0; i < ticks; i++) world.update(input)
        applySize()
        world.render(0, app.renderer)
        app.render()
      },
      press(action: keyof typeof input.state, down = true) {
        input.state[action] = down
      },
    }
  }

  boot.classList.add('hidden')
  setTimeout(() => boot.remove(), 400)

  window.addEventListener('hashchange', () => location.reload())
}

start().catch((err) => {
  console.error(err)
  say(`failed: ${err instanceof Error ? err.message : String(err)}`)
})

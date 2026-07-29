import { Application } from 'pixi.js'

import { GameAssets } from './assets/loader'
import { AudioBank, type SoundManifest } from './audio/AudioBank'
import { MusicPlayer } from './audio/MusicPlayer'
import { GameLoop } from './core/loop'
import { Input } from './core/input'
import { Level } from './game/Level'
import { World } from './game/World'
import { CrtFilter, crtGridPeriod, crtPixelScale } from './render/CrtFilter'
import { setDifficulty } from './game/powers'
import { showTitleScreen } from './ui/TitleScreen'
import { readSave } from './game/SaveGame'

/**
 * Smallest logical view we are willing to show. The stage is scaled by an
 * integer factor so pixels stay square and crisp; whatever space that leaves
 * over widens the logical view rather than adding letterboxing.
 */
const MIN_VIEW_WIDTH = 480
const MIN_VIEW_HEIGHT = 270

/**
 * level00 is Abuse's training level and contains no monsters at all - 258
 * objects, not one of them hostile. Starting there makes a game with working
 * enemies look completely inert, so the default is the first level that
 * actually fights back. `#levels/level00` still loads the tutorial.
 */
const DEFAULT_LEVEL = 'levels/level01'

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
 * and this is the trim that reads best against Abuse's dark art. Volume starts
 * at 0 on purpose - a page should not start screaming at you.
 */
const PICTURE_DEFAULTS = { brightness: 1.2, contrast: 1.2, glow: 1, volume: 0 }

function loadPictureSettings(): typeof PICTURE_DEFAULTS {
  try {
    const stored = localStorage.getItem(PICTURE_KEY)
    if (!stored) return { ...PICTURE_DEFAULTS }
    const parsed = JSON.parse(stored) as Partial<typeof PICTURE_DEFAULTS>
    const volume = Number(parsed.volume)
    return {
      brightness: Number(parsed.brightness) || PICTURE_DEFAULTS.brightness,
      contrast: Number(parsed.contrast) || PICTURE_DEFAULTS.contrast,
      // Same reasoning as volume: 0 glow is a deliberate setting, not a miss.
      glow: Number.isFinite(Number(parsed.glow)) ? Number(parsed.glow) : PICTURE_DEFAULTS.glow,
      // `||` would turn a deliberate 0 back into the default, but 0 is the
      // default here anyway - be explicit so it stays correct if that changes.
      volume: Number.isFinite(volume) ? volume : PICTURE_DEFAULTS.volume,
    }
  } catch {
    return { ...PICTURE_DEFAULTS }
  }
}

/** Wires the top-right picture and volume sliders. */
function mountPictureControls(
  crt: CrtFilter,
  audio: AudioBank,
  initialGlow: number,
  initialVolume: number,
  onVolumeChange: (muted: boolean) => void,
): void {
  const panel = document.getElementById('controls') as HTMLDivElement | null
  const brightness = document.getElementById('brightness') as HTMLInputElement | null
  const contrast = document.getElementById('contrast') as HTMLInputElement | null
  const glow = document.getElementById('glow') as HTMLInputElement | null
  const volume = document.getElementById('volume') as HTMLInputElement | null
  const brightnessVal = document.getElementById('brightness-val')
  const contrastVal = document.getElementById('contrast-val')
  const glowVal = document.getElementById('glow-val')
  const volumeVal = document.getElementById('volume-val')
  const reset = document.getElementById('reset-levels')
  if (!panel || !brightness || !contrast || !glow || !volume) return
  if (!brightnessVal || !contrastVal || !glowVal || !volumeVal || !reset) return

  const sync = (persist: boolean) => {
    crt.brightness = Number(brightness.value)
    crt.contrast = Number(contrast.value)
    crt.glow = Number(glow.value)
    audio.volume = Number(volume.value)

    brightnessVal.textContent = crt.brightness.toFixed(2)
    contrastVal.textContent = crt.contrast.toFixed(2)
    glowVal.textContent = crt.glow.toFixed(2)
    volumeVal.textContent = audio.muted ? 'off' : audio.volume.toFixed(2)

    if (persist) {
      try {
        localStorage.setItem(
          PICTURE_KEY,
          JSON.stringify({
            brightness: crt.brightness,
            contrast: crt.contrast,
            glow: crt.glow,
            volume: audio.volume,
          }),
        )
      } catch {
        // Private browsing and the like - the sliders still work, just not across reloads.
      }
    }
  }

  brightness.value = String(crt.brightness)
  contrast.value = String(crt.contrast)
  glow.value = String(initialGlow)
  volume.value = String(initialVolume)
  sync(false)

  let wasMuted = audio.muted
  for (const slider of [brightness, contrast, glow, volume]) {
    slider.addEventListener('input', () => {
      sync(true)
      if (audio.muted !== wasMuted) {
        wasMuted = audio.muted
        onVolumeChange(audio.muted)
      }
    })
    // A focused slider would swallow space and the arrow keys, so hand the
    // keyboard straight back to the game once the drag is over.
    slider.addEventListener('change', () => slider.blur())
    slider.addEventListener('pointerup', () => slider.blur())
  }

  reset.addEventListener('click', () => {
    brightness.value = String(PICTURE_DEFAULTS.brightness)
    contrast.value = String(PICTURE_DEFAULTS.contrast)
    glow.value = String(PICTURE_DEFAULTS.glow)
    volume.value = String(PICTURE_DEFAULTS.volume)
    sync(true)
    reset.blur()
  })

  panel.hidden = false
}

/** Stable, tiny hash so a level always picks the same fallback track. */
function hashString(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return hash
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

  // Read before anything loads: `loadLevel` writes the current level into the
  // hash, so by the time the title screen asks whether this was a deep link,
  // the game has already put one there and it would skip itself.
  const deepLinked = location.hash.length > 1

  // #levels/level03 in the URL picks a level; anything in levels.json works.
  const requested = decodeURIComponent(location.hash.replace(/^#/, '')) || DEFAULT_LEVEL
  const levelId = assets.levels.some((l) => l.id === requested) ? requested : DEFAULT_LEVEL

  const soundManifest = (await fetch('assets/sounds.json').then((r) => r.json())) as SoundManifest
  const audio = new AudioBank(soundManifest)
  const trainMessages = (await fetch('assets/messages.json').then((r) => r.json())) as {
    train: Record<number, string>
  }
  const musicTracks = (await fetch('assets/music.json').then((r) => r.json())) as {
    id: string
    file: string
  }[]
  const music = new MusicPlayer(audio)
  // Browsers will not start an AudioContext without a gesture. A level can
  // therefore load before there is anywhere to play music, so the first
  // gesture also has to kick the soundtrack off.
  const unlockAudio = () => {
    audio.unlock()
    startMusicFor(currentLevelId)
  }
  window.addEventListener('keydown', unlockAudio)
  window.addEventListener('pointerdown', unlockAudio)

  let zoom = integerZoom(app.renderer.screen.width, app.renderer.screen.height)
  let viewWidth = Math.ceil(app.renderer.screen.width / zoom)
  let viewHeight = Math.ceil(app.renderer.screen.height / zoom)

  let currentLevelId = levelId
  let level!: Level
  let world!: World

  /**
   * Builds the world for a level and swaps it in. Exit portals call this, so
   * everything the old world owned has to go - Pixi does not free display
   * objects for us.
   */
  const loadLevel = async (id: string) => {
    World.currentLevelId = id
    say(`loading ${id}`)
    const data = await assets.loadLevel(id)

    if (world) {
      app.stage.removeChild(world.root, world.lights.overlay, world.statusBar.container, world.messages.container)
      world.destroy()
    }

    currentLevelId = id
    level = new Level(data, assets)
    world = new World(assets, level, viewWidth, viewHeight, audio, trainMessages.train)
    world.root.scale.set(zoom)
    // The light overlay multiplies over the finished scene, so it sits on top
    // of the world but still inside the stage, and therefore under the CRT.
    // Messages go above the lighting - a tutorial line should not be in shadow.
    app.stage.addChild(world.root, world.lights.overlay, world.statusBar.container, world.messages.container)
    world.resize(viewWidth, viewHeight, zoom)
    // Deliberately not written back to the URL. Doing so left `#levels/level01`
    // in the address bar, which the next visit read as a deep link and used to
    // skip the title screen - so the menu appeared exactly once, ever. The hash
    // now means only what someone typed there.
    startMusicFor(id)
  }

  /**
   * Picks a track for a level. `levels/levelNN` maps to `abuseNN` where that
   * exists - the naming lines up - and anything else cycles the list so every
   * level gets something.
   */
  const startMusicFor = (id: string) => {
    if (musicTracks.length === 0 || audio.muted) return
    const number = /level(\d+)/.exec(id)?.[1]
    const named = number ? musicTracks.find((t) => t.id === `abuse${number}`) : undefined
    const chosen = named ?? musicTracks[Math.abs(hashString(id)) % musicTracks.length]
    if (music.track === chosen.file) return
    void music.play(chosen.file)
  }

  await loadLevel(levelId)

  const input = new Input()

  // The filter stays attached even with the CRT dialled off, so the
  // brightness/contrast trim still applies to the raw image.
  const picture = loadPictureSettings()
  const crt = new CrtFilter(picture)
  app.stage.filters = [crt]
  audio.volume = picture.volume

  let crtEnabled = true
  const setCrtEnabled = (on: boolean) => {
    crtEnabled = on
    crt.intensity = on ? 1 : 0
  }

  mountPictureControls(crt, audio, picture.glow, picture.volume, (muted) => {
    // Unmuting has to (re)start the soundtrack, since it never started while
    // silent - and the AudioContext may only just have been unlocked.
    if (muted) music.stop()
    else {
      audio.unlock()
      startMusicFor(currentLevelId)
    }
  })

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
    crt.gridPeriod = crtGridPeriod(zoom, app.renderer.resolution)
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

  let switching = false

  /** One simulation step. The debug harness uses this too, so exits work there. */
  const tick = () => {
    world.update(input)

    // An exit was used. Only levels we actually have are accepted; the
    // original's training level points at a few that were never shipped.
    const requested = world.requestedLevel
    if (requested && !switching) {
      world.requestedLevel = null
      if (assets.levels.some((l) => l.id === requested)) {
        switching = true
        void loadLevel(requested).finally(() => {
          switching = false
        })
      }
    }
  }

  const loop = new GameLoop(tick, (alpha) => {
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
          `${currentLevelId}  "${level.name}"  ${level.fgWidth}x${level.fgHeight} tiles`,
          `pos ${world.player.x.toFixed(0)},${world.player.y.toFixed(0)}  ${world.player.state}` +
            `${world.player.onGround ? '' : ' (air)'}  x${zoom}  ${fps}fps  ${world.spriteCount} sprites` +
            `  ${world.lights.visibleCount}/${level.lighting.lights.length} lights` +
            ` @ambient ${level.lighting.minLight}/63`,
          `props ${world.propCounts.visible}/${world.propCounts.total} drawn   ${world.status}` +
            `   audio ${
              audio.muted
                ? 'muted'
                : `${audio.loadedCount} clips, ${world.ambientCount} emitters, music ${music.track ?? 'none'}`
            }`,
          world.objectSummary,
          `arrows/WASD move   space jump   shift run   down/E use   X or LMB fire` +
        `   1-8/Q weapon   C or RMB special` +
        `${world.savedMessage > 0 ? '   *** GAME SAVED ***' : ''}` +
        `   [${world.player.weaponSlot.name}` +
        `${world.powerLabel ? `  ${world.powerLabel.toUpperCase()}${world.powerActive ? '*' : ''}` : ''}]` +
            `   V crt:${crtEnabled ? 'on' : 'off'}   L light:${world.lights.enabled ? 'on' : 'off'}`,
        ].join('\n')
      }
    },
  )

  // We drive rendering from our own fixed-step loop.
  app.ticker.stop()

  if (import.meta.env.DEV) {
    // Lets a headless browser step the simulation deterministically; rAF is
    // paused whenever the document reports itself hidden.
    ;(window as unknown as Record<string, unknown>).game = {
      app,
      input,
      audio,
      music,
      // Getters, not values: both are replaced whenever a level is loaded.
      get world() {
        return world
      },
      get level() {
        return level
      },
      get levelId() {
        return currentLevelId
      },
      step(ticks = 1) {
        for (let i = 0; i < ticks; i++) tick()
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

  // The title screen waits for a choice before the first tick. It is also the
  // gesture the AudioContext needs, so the game no longer starts making noise
  // the moment you happen to touch a key.
  const choice = await showTitleScreen({
    canResume: readSave() !== null,
    // A deep link like #levels/level14 means someone already chose a level.
    skip: deepLinked,
  })
  setDifficulty(choice.difficulty)

  // Resuming means the level the save was taken in, not the one we booted
  // into. Without this you always started on level01 - and then the save's
  // own level check failed, so nothing was restored either.
  if (choice.resume) {
    const saved = readSave()
    World.resumeFromSave = true
    if (saved && saved.level !== currentLevelId && assets.levels.some((l) => l.id === saved.level)) {
      await loadLevel(saved.level)
    } else {
      await loadLevel(currentLevelId)
    }
  }

  unlockAudio()

  // Started only now, so the world does not tick away behind the title screen -
  // the cop would be falling, and anything that noticed him would be shooting.
  loop.start()

  window.addEventListener('hashchange', () => location.reload())
}

start().catch((err) => {
  console.error(err)
  say(`failed: ${err instanceof Error ? err.message : String(err)}`)
})

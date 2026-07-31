/**
 * A page for watching the sprites animate, away from the game.
 *
 * The point is not to look at frames - the export tool already writes those as
 * PNGs. It is to see them *move*, and to see the cop assembled: he is two
 * characters, legs and torso, joined by a baseline and a shoulder offset that
 * have both been wrong at some point and are both invisible in a still frame.
 * The join is imported from the game rather than reimplemented here, so a
 * viewer that agrees with the game keeps agreeing with it.
 *
 * It reads the packed atlas the game loads, not the export, so it needs no
 * build step and cannot show something the game does not have.
 */
import type { CharsManifest, FrameMeta } from '../assets/types'
import {
  aimFrameForAngle,
  AIM_PIVOT_X,
  AIM_PIVOT_Y,
  TOP_BASELINE,
  TOP_SHOULDER_NUDGE,
} from '../game/copRig'
import { atan2Deg } from '../game/weapons/angles'

/** The legs. Every animation state lives on this character. */
const BOTTOM = 'DARNEL'

/** One torso per weapon, in weapon-slot order. */
const TOPS = ['MGUN_TOP', 'GRENADE_TOP', 'ROCKET_TOP', 'FIREBOMB_TOP', 'PGUN_TOP', 'DFRIS_TOP']

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const ui = {
  canvas: el<HTMLCanvasElement>('canvas'),
  stage: el<HTMLDivElement>('stage'),
  info: el<HTMLDivElement>('info'),
  character: el<HTMLSelectElement>('character'),
  state: el<HTMLSelectElement>('state'),
  weapon: el<HTMLSelectElement>('weapon'),
  fps: el<HTMLInputElement>('fps'),
  fpsVal: el<HTMLSpanElement>('fps-val'),
  zoom: el<HTMLInputElement>('zoom'),
  zoomVal: el<HTMLSpanElement>('zoom-val'),
  play: el<HTMLButtonElement>('play'),
  facing: el<HTMLButtonElement>('facing'),
  prev: el<HTMLButtonElement>('prev'),
  next: el<HTMLButtonElement>('next'),
  anchor: el<HTMLButtonElement>('anchor'),
}

interface Frame {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Anchor distance from the left edge - nothing can be placed without it. */
  readonly xcfg: number
  /** Pixels the character moves when this frame plays. */
  readonly advance: number
}

const view = {
  character: BOTTOM,
  state: 'running',
  /** Index into TOPS, or -1 for bare legs. */
  weapon: 0,
  frame: 0,
  playing: true,
  facingRight: true,
  anchors: true,
  /** Aim heading in degrees, driven by the pointer. Starts level and right. */
  aim: 0,
}

let manifest: CharsManifest
let pages: ImageBitmap[] = []

function frameOf(file: string, name: string): Frame | undefined {
  const meta = manifest.frames[`${file}#${name}`] as FrameMeta | undefined
  if (!meta) return undefined
  const [page, x, y, width, height, xcfg, advance] = meta
  return { page, x, y, width, height, xcfg, advance }
}

/** The frames of one state, skipping any the atlas does not have. */
function animation(character: string, state: string): Frame[] {
  const entry = manifest.characters[character]
  if (!entry) return []
  return (entry.states[state] ?? [])
    .map((name) => frameOf(entry.file, name))
    .filter((frame): frame is Frame => frame !== undefined)
}

/** Characters worth listing: the cop first, then everything with art. */
function characterNames(): string[] {
  const rest = Object.keys(manifest.characters)
    .filter((name) => name !== BOTTOM && !TOPS.includes(name))
    .filter((name) => Object.values(manifest.characters[name].states).some((f) => f.length > 0))
    .sort()
  return [BOTTOM, ...TOPS, ...rest]
}

function fillSelect(select: HTMLSelectElement, values: readonly string[], selected: string): void {
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      option.selected = value === selected
      return option
    }),
  )
}

function statesOf(character: string): string[] {
  const entry = manifest.characters[character]
  if (!entry) return []
  return Object.keys(entry.states).filter((state) => entry.states[state].length > 0).sort()
}

/** The cop's torso only goes on the cop's legs. */
function wearsTorso(): boolean {
  return view.character === BOTTOM && view.weapon >= 0
}

function draw(): void {
  const dpr = window.devicePixelRatio || 1
  const rect = ui.stage.getBoundingClientRect()
  if (ui.canvas.width !== Math.round(rect.width * dpr)) {
    ui.canvas.width = Math.round(rect.width * dpr)
    ui.canvas.height = Math.round(rect.height * dpr)
    ui.canvas.style.width = `${rect.width}px`
    ui.canvas.style.height = `${rect.height}px`
  }

  const ctx = ui.canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height)
  ctx.imageSmoothingEnabled = false

  const frames = animation(view.character, view.state)
  const legs = frames[view.frame % Math.max(1, frames.length)]

  // Everything below is in the character's own pixels, anchored at his feet -
  // the same coordinates the engine places him in, so the arithmetic can be
  // lifted from it unchanged.
  const zoom = Number(ui.zoom.value)
  ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, ui.canvas.width / 2, ui.canvas.height * 0.62)

  const mirrored = !view.facingRight
  const blit = (frame: Frame, x: number, y: number, mirror: boolean) => {
    const page = pages[frame.page]
    if (!page) return
    // `x - xcfg`, or `x - (width - xcfg - 1)` flipped (Player.blit).
    const left = mirror ? x - (frame.width - frame.xcfg - 1) : x - frame.xcfg
    const top = y - frame.height + 1
    ctx.save()
    if (mirror) {
      ctx.translate(left + frame.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(
      page,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      mirror ? 0 : left,
      top,
      frame.width,
      frame.height,
    )
    ctx.restore()
  }

  let torso: Frame | undefined
  let aimFrame = 0
  if (legs) blit(legs, 0, 0, mirrored)

  if (legs && wearsTorso()) {
    aimFrame = aimFrameForAngle(view.aim)
    const tops = animation(TOPS[view.weapon], 'stopped')
    torso = tops[aimFrame % Math.max(1, tops.length)]
    if (torso) {
      // `o->x=bot->x (+4 facing left); o->y=bot->y+29-bot->height`, drawn
      // unmirrored whichever way the legs face (src/cop.cpp, top_draw).
      const x = mirrored ? TOP_SHOULDER_NUDGE : 0
      blit(torso, x, TOP_BASELINE - legs.height, false)
    }
  }

  if (view.anchors) {
    const thin = 1 / zoom
    // The anchor itself, the ground it stands on, and - when the torso is on -
    // the pivot the aim angle is measured from.
    ctx.lineWidth = thin
    ctx.strokeStyle = 'rgba(140, 190, 230, 0.30)'
    ctx.beginPath()
    ctx.moveTo(-200, 0.5)
    ctx.lineTo(200, 0.5)
    ctx.moveTo(0.5, -120)
    ctx.lineTo(0.5, 20)
    ctx.stroke()

    ctx.fillStyle = '#f0662a'
    ctx.fillRect(-thin, -thin, thin * 3, thin * 3)

    if (wearsTorso()) {
      const px = (mirrored ? TOP_SHOULDER_NUDGE : 0) + AIM_PIVOT_X
      const py = -AIM_PIVOT_Y
      ctx.fillStyle = 'rgba(120, 220, 160, 0.9)'
      ctx.fillRect(px - thin, py - thin, thin * 3, thin * 3)
    }
  }

  const count = frames.length
  const lines = [
    `${view.character}  ${view.state}`,
    `frame     ${count ? (view.frame % count) + 1 : 0} / ${count}`,
    legs ? `size      ${legs.width} x ${legs.height}` : 'size      -',
    legs ? `x_center  ${legs.xcfg}` : 'x_center  -',
    legs ? `advance   ${legs.advance}` : 'advance   -',
    `facing    ${view.facingRight ? 'right' : 'left'}`,
  ]
  if (wearsTorso()) {
    lines.push(
      '',
      `torso     ${TOPS[view.weapon]}`,
      `aim       ${Math.round(view.aim)}°  frame ${aimFrame + 1} / 24`,
      torso ? `size      ${torso.width} x ${torso.height}` : 'size      -',
    )
  }
  ui.info.textContent = lines.join('\n')
}

function advanceClock(): void {
  let last = performance.now()
  let carry = 0
  const tick = (now: number) => {
    const step = 1000 / Number(ui.fps.value)
    carry += now - last
    last = now
    if (view.playing) {
      while (carry >= step) {
        carry -= step
        const count = animation(view.character, view.state).length
        if (count) view.frame = (view.frame + 1) % count
      }
    } else {
      carry = 0
    }
    draw()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function bind(): void {
  ui.character.addEventListener('change', () => {
    view.character = ui.character.value
    const states = statesOf(view.character)
    view.state = states.includes(view.state) ? view.state : (states[0] ?? '')
    fillSelect(ui.state, states, view.state)
    view.frame = 0
    ui.weapon.disabled = view.character !== BOTTOM
  })

  ui.state.addEventListener('change', () => {
    view.state = ui.state.value
    view.frame = 0
  })

  ui.weapon.addEventListener('change', () => {
    view.weapon = Number(ui.weapon.value)
  })

  ui.fps.addEventListener('input', () => {
    ui.fpsVal.textContent = ui.fps.value
  })
  ui.zoom.addEventListener('input', () => {
    ui.zoomVal.textContent = `${ui.zoom.value}×`
  })

  ui.play.addEventListener('click', () => {
    view.playing = !view.playing
    ui.play.textContent = view.playing ? 'Pause' : 'Play'
  })

  ui.facing.addEventListener('click', () => {
    view.facingRight = !view.facingRight
    ui.facing.textContent = view.facingRight ? 'Face left' : 'Face right'
  })

  const step = (by: number) => {
    view.playing = false
    ui.play.textContent = 'Play'
    const count = animation(view.character, view.state).length
    if (count) view.frame = (view.frame + by + count) % count
  }
  ui.prev.addEventListener('click', () => step(-1))
  ui.next.addEventListener('click', () => step(1))

  ui.anchor.addEventListener('click', () => {
    view.anchors = !view.anchors
    ui.anchor.setAttribute('aria-pressed', String(view.anchors))
  })

  // The torso follows the pointer, the way it does in the game - the whole
  // reason for 24 frames is that they sweep the circle, and a slider would not
  // show that nearly as well as moving the mouse does.
  ui.stage.addEventListener('mousemove', (event) => {
    const rect = ui.stage.getBoundingClientRect()
    const zoom = Number(ui.zoom.value)
    const x = (event.clientX - rect.left - rect.width / 2) / zoom
    const y = (event.clientY - rect.top - rect.height * 0.62) / zoom
    const originX = view.facingRight ? 0 : TOP_SHOULDER_NUDGE
    view.aim = atan2Deg(-AIM_PIVOT_Y - y, x - originX - AIM_PIVOT_X)
  })

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      ui.play.click()
      event.preventDefault()
    } else if (event.code === 'ArrowLeft') step(-1)
    else if (event.code === 'ArrowRight') step(1)
  })
}

async function main(): Promise<void> {
  manifest = (await (await fetch('assets/chars.json')).json()) as CharsManifest
  pages = await Promise.all(
    manifest.pages.map(async (page) => createImageBitmap(await (await fetch(`assets/${page}`)).blob())),
  )

  fillSelect(ui.character, characterNames(), view.character)
  fillSelect(ui.state, statesOf(view.character), view.state)
  ui.weapon.replaceChildren(
    ...['(legs only)', ...TOPS].map((label, i) => {
      const option = document.createElement('option')
      option.value = String(i - 1)
      option.textContent = label
      option.selected = i - 1 === view.weapon
      return option
    }),
  )

  bind()
  advanceClock()
}

main().catch((error: unknown) => {
  document.body.innerHTML = `<div id="error">${String(error)}</div>`
})

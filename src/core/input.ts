export interface InputState {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  jump: boolean
  run: boolean
  /** Use / enter - the original's "action key". */
  action: boolean
  /** Left mouse button. */
  fire: boolean
}

const BINDINGS: Record<string, keyof InputState> = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'up',
  KeyW: 'up',
  // Down is the original's action key - `pressing_action_key` in
  // lisp/people.lsp is literally `(> (player_y_suggest) 0)`, which is why the
  // tutorial text says "press the down key to activate objects".
  ArrowDown: 'down',
  KeyS: 'down',
  Space: 'jump',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  KeyE: 'action',
  Enter: 'action',
}

export class Input {
  readonly state: InputState = {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    run: false,
    action: false,
    fire: false,
  }

  /** Latest pointer position in CSS pixels, for aiming. */
  readonly pointer = { x: 0, y: 0, seen: false }

  /** True only on the frame a jump was pressed, so holding does not re-jump. */
  private jumpWasDown = false
  private jumpBuffered = false

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (e) => this.set(e as KeyboardEvent, true))
    target.addEventListener('keyup', (e) => this.set(e as KeyboardEvent, false))
    window.addEventListener('blur', () => {
      for (const key of Object.keys(this.state) as (keyof InputState)[]) this.state[key] = false
    })
    window.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX
      this.pointer.y = e.clientY
      this.pointer.seen = true
    })
    window.addEventListener('pointerdown', (e) => {
      // Left button only; the panel's sliders live on the same surface.
      if (e.button === 0 && !(e.target as HTMLElement)?.closest?.('#controls')) {
        this.state.fire = true
      }
    })
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.state.fire = false
    })
  }

  private set(event: KeyboardEvent, down: boolean) {
    const action = BINDINGS[event.code]
    if (!action) return
    // Arrows and space scroll the page otherwise.
    event.preventDefault()
    this.state[action] = down
    if (action === 'jump' && down) this.jumpBuffered = true
  }

  /** Consumes a buffered jump press. */
  consumeJump(): boolean {
    const pressed = this.jumpBuffered || (this.state.jump && !this.jumpWasDown)
    this.jumpBuffered = false
    this.jumpWasDown = this.state.jump
    return pressed
  }

  get axis(): number {
    return (this.state.right ? 1 : 0) - (this.state.left ? 1 : 0)
  }
}

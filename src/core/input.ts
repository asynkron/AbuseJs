export interface InputState {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  jump: boolean
  run: boolean
  /** Use / enter - the original's "action key". */
  action: boolean
  /** Left mouse button, or its keyboard equivalent. */
  fire: boolean
  /**
   * The original's secondary action - "hold down the right mouse button to use
   * special powers". Nothing uses it yet, but it is bound so a trackpad is
   * never the thing standing in the way.
   */
  special: boolean
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
  // Mac trackpads have no second button, and holding a click for sustained
  // fire is miserable, so both mouse actions have keys of their own.
  KeyX: 'fire',
  Slash: 'fire',
  KeyC: 'special',
  Period: 'special',
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
    special: false,
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
      // The panel's sliders live on the same surface; leave those alone.
      if ((e.target as HTMLElement)?.closest?.('#controls')) return
      if (e.button === 0) this.state.fire = true
      if (e.button === 2) this.state.special = true
    })
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.state.fire = false
      if (e.button === 2) this.state.special = false
    })
    // A two-finger tap would otherwise drop a context menu over the game.
    window.addEventListener('contextmenu', (e) => {
      if (!(e.target as HTMLElement)?.closest?.('#controls')) e.preventDefault()
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

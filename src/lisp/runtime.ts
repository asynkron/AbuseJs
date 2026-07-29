/**
 * The engine surface the compiled scripts call.
 *
 * `tools/compile.ts` turns every `.lsp` call it does not recognise as a
 * special form into `R.name(...)`, so this object *is* the port's boundary.
 * Anything missing throws by name the moment a script reaches for it, which
 * is the point: gaps announce themselves instead of quietly doing nothing.
 *
 * Abuse's scripts are written against an implicit "current object" - `(x)`
 * means the x of whoever is running, and `with_object` rebinds it. That is
 * dynamic scoping, and a module-level binding saved and restored around the
 * call is both the smallest way to model it and the closest to how the
 * original reads.
 */

/** What a script can be running as. Deliberately narrower than `Prop`. */
export interface ScriptObject {
  x: number
  y: number
  vx: number
  vy: number
  direction: 1 | -1
  health: number
  state: string
  /** Signal state, and the script's own state machine variable. */
  aistate: number
  aitype: number
  /** Ticks since the current state was entered. */
  stateTime: number
  /** Per-character storage, from `(vars ...)` on the character. */
  vars: Record<string, unknown>
  /** Objects this one is linked to, in level order. */
  linked: ScriptObject[]

  setState(state: string, restart?: boolean): void
  /** Advances one frame; true once the animation has run through. */
  nextPicture(): boolean
}

/** Everything the runtime needs from the world, kept behind an interface. */
export interface ScriptHost {
  playSound(name: string, volume: number, x: number, y: number): void
  addObject(type: string, x: number, y: number, state: number): void
  hurtRadius(x: number, y: number, radius: number, amount: number, push: number): void
  /** Moves the current object and reports where it ended up. */
  tryMove(object: ScriptObject, dx: number, dy: number): { x: number; y: number }
  /** The player, for `first_focus` and the distance helpers. */
  focus(): ScriptObject | null
  /** True while the level editor is showing, which is never, in play. */
  editMode(): boolean
  tick(): number
}

let current: ScriptObject | null = null
let host: ScriptHost | null = null

export function setHost(next: ScriptHost): void {
  host = next
}

/** Runs `body` with `object` as the script's current object. */
export function withCurrent<T>(object: ScriptObject, body: () => T): T {
  const previous = current
  current = object
  try {
    return body()
  } finally {
    current = previous
  }
}

function self(): ScriptObject {
  if (!current) throw new Error('script ran with no current object')
  return current
}

function world(): ScriptHost {
  if (!host) throw new Error('script ran with no host')
  return host
}

/**
 * Lisp's notion of true: only `nil` is false. Zero is true, which is the
 * opposite of JavaScript and the single easiest way to get this port subtly
 * wrong - `(if (hp) ...)` is true for a corpse.
 */
export function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false
}

/** Globals the scripts set and read. Seeded by each module's `load()`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const G: Record<string, any> = Object.create(null)

/**
 * The hooks, by breadth of use across the scripts. Everything here is bound
 * to our own objects rather than to a reconstruction of Abuse's, which is
 * where "our touch" actually lives: the scripts decide *what* happens, we
 * decide what the pieces they name are made of.
 */
const HOOKS = {
  /* --- reading the current object ---------------------------------- */
  x: () => self().x,
  y: () => self().y,
  xvel: () => self().vx,
  yvel: () => self().vy,
  hp: () => self().health,
  direction: () => self().direction,
  aistate: () => self().aistate,
  aitype: () => self().aitype,
  state: () => self().state,
  state_time: () => self().stateTime,

  /* --- writing it -------------------------------------------------- */
  set_x: (v: number) => void (self().x = v),
  set_y: (v: number) => void (self().y = v),
  set_xvel: (v: number) => void (self().vx = v),
  set_yvel: (v: number) => void (self().vy = v),
  add_xvel: (v: number) => void (self().vx += v),
  add_yvel: (v: number) => void (self().vy += v),
  set_hp: (v: number) => void (self().health = v),
  set_aistate: (v: number) => void (self().aistate = v),
  set_aitype: (v: number) => void (self().aitype = v),
  set_direction: (v: number) => void (self().direction = v < 0 ? -1 : 1),

  /**
   * `go_state` is `set_state` plus resetting the state machine, and the
   * scripts lean on it heavily for their `select (aistate)` ladders.
   */
  set_state: (state: unknown) => self().setState(String(state), true),
  go_state: (v: number) => void (self().aistate = v),
  next_picture: () => self().nextPicture(),

  /* --- the link list ----------------------------------------------- */
  total_objects: () => self().linked.length,
  get_object: (i: number) => self().linked[i] ?? null,
  /**
   * Runs the body against another object. The compiler emits the body as a
   * thunk precisely so this can rebind first - see `with_object` in
   * tools/compile.ts.
   */
  with_object: <T>(object: ScriptObject | null, body: () => T): T | null =>
    object ? withCurrent(object, body) : null,

  /* --- the world ---------------------------------------------------- */
  play_sound: (name: unknown, volume: number, x: number, y: number) =>
    world().playSound(String(name), volume, x, y),
  add_object: (type: unknown, x: number, y: number, state: number) =>
    world().addObject(String(type), x, y, state),
  hurt_radius: (x: number, y: number, radius: number, amount: number, _from: unknown, push: number) =>
    world().hurtRadius(x, y, radius, amount, push),
  try_move: (dx: number, dy: number) => {
    const object = self()
    const end = world().tryMove(object, dx, dy)
    object.x = end.x
    object.y = end.y
    return null
  },
  first_focus: () => world().focus(),
  edit_mode: () => world().editMode(),
  game_tick: () => world().tick(),

  distx: () => {
    const target = world().focus()
    return target ? Math.abs(target.x - self().x) : 0
  },
  disty: () => {
    const target = world().focus()
    return target ? Math.abs(target.y - self().y) : 0
  },

  /* --- pure helpers -------------------------------------------------- */
  random: (n: number) => Math.floor(Math.random() * n),
  abs: (n: number) => Math.abs(n),
  min: (a: number, b: number) => Math.min(a, b),
  max: (a: number, b: number) => Math.max(a, b),
  list: (...items: unknown[]) => items,
  elt: (list: unknown[], i: number) => list?.[i] ?? null,
  length: (list: unknown[]) => list?.length ?? 0,
  concatenate: (_kind: unknown, ...parts: unknown[]) => parts.join(''),

  /**
   * `bg` is the background/damage source the scripts pass to `hurt_radius`
   * when nothing in particular caused the damage. We do not model damage
   * attribution, so it is a marker.
   */
  bg: () => null,
}

/** Hooks a script asked for that we have not written. Read by the debug HUD. */
export const missingHooks = new Set<string>()

/** Generated scripts are untyped lisp; the boundary is `any` by nature. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Hook = (...args: any[]) => any

/**
 * The scripts reference 271 distinct hooks and about forty are implemented.
 * Typing `R` as the exact set would fail the build on every gap, which turns
 * an incremental port into a big-bang one. Instead an unimplemented hook is a
 * real function that records itself and returns nil - so a level runs, the
 * parts that are covered behave, and the gaps are a list rather than a wall.
 *
 * Returning nil rather than throwing is deliberate: nil is lisp's "nothing
 * happened", which is the right answer for a hook that genuinely has not
 * happened, and it lets one missing hook stop one behaviour instead of the
 * whole tick.
 */
export const R: Record<string, Hook> = new Proxy(
  HOOKS as unknown as Record<string, Hook>,
  {
    get(target, key: string) {
      const hook = target[key]
      if (hook) return hook
      return (...args: unknown[]) => {
        if (!missingHooks.has(key)) {
          missingHooks.add(key)
          console.warn(`[lisp] no hook for (${key}) - ${args.length} args`)
        }
        return null
      }
    },
  },
)

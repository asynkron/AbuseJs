/**
 * Sim ticks per original engine tick.
 *
 * Every duration in this subsystem is in the original's ticks: `exp_ai`
 * advances exactly one animation frame per tick (lisp/explo.lsp), `head_ai`
 * adds 3 to a gib's yvel per tick (lisp/ant.lsp), `explo_light` counts five of
 * them and takes its light away again. Our loop runs at 60 Hz
 * (src/core/loop.ts TICK_HZ), so the whole subsystem is stepped once every
 * fourth sim tick and every lisp constant can be written down as it stands.
 *
 * Invented: the engine's own tick rate is not recorded anywhere in the shipped
 * data. Four gives 15 Hz, which is the rate the stub Effects.ts already held
 * each explosion frame for, and it keeps a 7-frame fireball on screen for
 * about half a second rather than a tenth of one.
 */
export const SIM_TICKS_PER_TICK = 4

/**
 * The subsystem's own clock.
 *
 * Counts sim ticks down to engine ticks, and reports how far through the
 * current engine tick we are so that anything which moves - the gibs, in
 * practice - can be drawn between its 15 Hz positions instead of stepping.
 */
export class TickClock {
  private sub = 0
  private count = 0
  private steppedNow = false

  /** Call once per sim tick. True when an engine tick fell on this one. */
  step(): boolean {
    this.steppedNow = ++this.sub >= SIM_TICKS_PER_TICK
    if (this.steppedNow) {
      this.sub = 0
      this.count++
    }
    return this.steppedNow
  }

  /** Whether the most recent sim tick was also an engine tick. */
  get stepped(): boolean {
    return this.steppedNow
  }

  /** Engine ticks since the clock started - the scripts' `(game_tick)`. */
  get ticks(): number {
    return this.count
  }

  /** How far the current engine tick has run, 0..1. `alpha` is the sim tick's own fraction. */
  fraction(alpha: number): number {
    return (this.sub + alpha) / SIM_TICKS_PER_TICK
  }

  reset(): void {
    this.sub = 0
    this.count = 0
    this.steppedNow = false
  }
}

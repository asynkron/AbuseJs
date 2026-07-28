export const TICK_HZ = 60
export const TICK_MS = 1000 / TICK_HZ

/**
 * Fixed-timestep loop with an accumulator.
 *
 * Physics runs at a constant rate so jump arcs and friction are identical on
 * every display; `render` receives the leftover fraction of a tick so drawing
 * can interpolate and stay smooth on 120Hz+ screens.
 */
export class GameLoop {
  private accumulator = 0
  private last = 0
  private running = false
  private frameId = 0

  /** Guard against the spiral of death after a tab has been backgrounded. */
  private readonly maxCatchUpMs = 200

  constructor(
    private readonly update: () => void,
    private readonly render: (alpha: number) => void,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    this.frameId = requestAnimationFrame(this.frame)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.frameId)
  }

  private readonly frame = (now: number) => {
    if (!this.running) return
    this.frameId = requestAnimationFrame(this.frame)

    this.accumulator += Math.min(now - this.last, this.maxCatchUpMs)
    this.last = now

    while (this.accumulator >= TICK_MS) {
      this.update()
      this.accumulator -= TICK_MS
    }

    this.render(this.accumulator / TICK_MS)
  }
}

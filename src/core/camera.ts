/**
 * Follow camera with a dead zone and exponential smoothing.
 *
 * The dead zone stops small movements from nudging the whole screen; the
 * smoothing keeps the catch-up motion from snapping. Position stays fractional
 * here - rounding happens once, in device pixels, at draw time.
 */
export class Camera {
  x = 0
  y = 0

  /** Half-size of the box the target may move in before the camera follows. */
  deadZoneX = 24
  deadZoneY = 16
  /** Fraction of the remaining distance closed per 60Hz step. */
  stiffness = 0.16

  private targetX = 0
  private targetY = 0

  constructor(
    public viewWidth: number,
    public viewHeight: number,
  ) {}

  /** Jumps straight to the target - use on level load. */
  snapTo(x: number, y: number, bounds: { width: number; height: number }): void {
    this.targetX = x
    this.targetY = y
    this.x = x - this.viewWidth / 2
    this.y = y - this.viewHeight / 2
    this.clamp(bounds)
  }

  follow(x: number, y: number, bounds: { width: number; height: number }): void {
    const centreX = this.x + this.viewWidth / 2
    const centreY = this.y + this.viewHeight / 2

    const dx = x - centreX
    const dy = y - centreY

    if (dx > this.deadZoneX) this.targetX = x - this.deadZoneX
    else if (dx < -this.deadZoneX) this.targetX = x + this.deadZoneX
    else this.targetX = centreX

    if (dy > this.deadZoneY) this.targetY = y - this.deadZoneY
    else if (dy < -this.deadZoneY) this.targetY = y + this.deadZoneY
    else this.targetY = centreY

    this.x += (this.targetX - this.viewWidth / 2 - this.x) * this.stiffness
    this.y += (this.targetY - this.viewHeight / 2 - this.y) * this.stiffness
    this.clamp(bounds)
  }

  private clamp(bounds: { width: number; height: number }): void {
    const maxX = Math.max(0, bounds.width - this.viewWidth)
    const maxY = Math.max(0, bounds.height - this.viewHeight)
    this.x = Math.min(Math.max(this.x, 0), maxX)
    this.y = Math.min(Math.max(this.y, 0), maxY)
  }
}

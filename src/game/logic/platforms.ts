import { Behaviour } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'

/**
 * SMART_PLAT_BIG / SMART_PLAT_SMALL / SMART_PLAT_RED - lisp/platform.lsp.
 *
 * A lift that shuttles between two endpoint objects, usually MARKERs or
 * SENSORs. Links 0 and 1 are those endpoints; an optional link 2 is an enable
 * switch, and with it off the lift is frozen.
 *
 * The level fields are the tuning: `xacel` is plat_speed, `yacel` plat_2speed,
 * `xvel` plat_pos (steps remaining), `yvel` plat_wait - which is saved as 50
 * everywhere and read by nothing, so it is ignored here too.
 */

/** `platform_cons` sets xacel 20. Also the fallback for a level that saved 0. */
const DEFAULT_SPEED = 20

/** PLAT_D_SND fires when six steps remain - the deceleration cue. */
const DECELERATION_STEP = 6

const SOUND_VOLUME = 127

/** Which of the two endpoint links a value refers to. */
type EndpointSlot = 0 | 1

/**
 * The lift's phases. `aistate` 0, 2 and 3 in the original - 1 is unused - and
 * all three can run on the same tick, because `go_state` re-enters the ai
 * immediately. Stepping on and pressing down launches the lift in one tick.
 */
type LiftPhase = 'parked' | 'launching' | 'travelling'

const LIFT_AISTATE: Record<LiftPhase, number> = { parked: 0, launching: 2, travelling: 3 }
const LIFT_PHASE: Record<number, LiftPhase> = { 0: 'parked', 2: 'launching', 3: 'travelling' }

export class Platform extends Behaviour {
  /**
   * `aitype`. While parked it names the endpoint whose signal launches the
   * lift - the far end, so a sensor there calls the lift over. The launching
   * phase flips it, after which it names the end being travelled *from*.
   */
  private endpoint: EndpointSlot
  /** `xvel` - steps left in the current trip, counted down to zero. */
  private stepsLeft: number
  /** How far above the lift's own y a boarding player is placed. */
  private readonly boardingReach: number

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    this.endpoint = self.data.aitype === 1 ? 1 : 0
    this.stepsLeft = Math.max(0, self.data.xvel)
    // 26 big, 22 small, 72 red - `make_smart_plat`'s start_accel argument.
    // Not the sprite height: small_off is 15px tall and carries 22.
    this.boardingReach = world.host.ability(self.type, 'start_accel') ?? 0
  }

  /** `can_block`, and unlike a door it is solid in every state. */
  override get solid(): boolean {
    return true
  }

  protected run(): void {
    const links = this.signals.linksOf(this.self.index)
    const enabled =
      links.length === 2 || (links.length === 3 && this.signals.isOn(links[2]))
    if (!enabled) {
      this.self.setState('stopped')
      return
    }

    // The two-frame blink. chars.json has only `stopped` for these characters
    // - tools/lisp.ts does not expand the `(list off_frame on_frame)` form
    // make_smart_plat builds `running` with - so setState no-ops today and the
    // lift shows its off frame throughout. Harmless, and it fixes itself when
    // the extractor learns that form.
    if (this.self.state === 'stopped') this.self.setState('running')
    else this.self.nextPicture()

    switch (LIFT_PHASE[this.self.aistate]) {
      case 'parked':
        this.tryLaunch(links)
        return

      case 'launching':
        this.host.playSound('PLAT_A_SND', SOUND_VOLUME, this.self.x, this.self.y)
        this.endpoint = (1 - this.endpoint) as EndpointSlot
        this.stepsLeft = this.speed
        this.goState(LIFT_AISTATE.travelling)
        return

      case 'travelling':
        if (this.stepsLeft === DECELERATION_STEP) {
          this.host.playSound('PLAT_D_SND', SOUND_VOLUME, this.self.x, this.self.y)
        }
        this.travel(links)
    }
  }

  /**
   * `plat_speed` - the number of interpolation steps a trip takes, so lower is
   * faster. yacel is 0 in every shipped platform, which makes the second
   * branch dead code in practice, but it costs a line to keep.
   */
  private get speed(): number {
    const primary = this.self.data.xacel || DEFAULT_SPEED
    if (this.self.aistate === 0) return primary
    return this.self.data.yacel || primary
  }

  /** Either the far endpoint signals, or a player stands on it and presses. */
  private tryLaunch(links: readonly number[]): void {
    const trigger = links[this.endpoint]
    const called = trigger !== undefined && this.signals.isOn(trigger)

    const focus = this.focus
    const boarding =
      focus !== undefined && this.host.touching(this.self.index, focus) && focus.pressingAction

    if (!called && !boarding) return
    // Snap the rider onto the deck before it moves, so the trip does not start
    // by leaving them behind.
    if (boarding && focus) focus.setFeetY(this.self.y - this.boardingReach)
    this.goState(LIFT_AISTATE.launching)
  }

  /**
   * `platform_move` - integer linear interpolation from one endpoint to the
   * other, carrying riders by the delta before the lift itself moves.
   *
   * `xvel` starts equal to the step count, so the first tick produces no
   * movement at all and a trip takes speed + 1 ticks including the final snap.
   */
  private travel(links: readonly number[]): void {
    const source = this.world.positionOf(links[this.endpoint])
    const destination = this.world.positionOf(links[1 - this.endpoint])
    if (!source || !destination) {
      this.self.setAiState(LIFT_AISTATE.parked)
      return
    }

    if (this.stepsLeft === 0) {
      this.host.carryRiders(this.self.index, destination.x - this.self.x, destination.y - this.self.y)
      this.self.x = destination.x
      this.self.y = destination.y
      this.self.setAiState(LIFT_AISTATE.parked)
      return
    }

    // Lisp integer division truncates toward zero, and the rounding is
    // visible: it is what puts the lift exactly on its endpoints.
    const speed = this.speed
    const nextX = destination.x - Math.trunc(((destination.x - source.x) * this.stepsLeft) / speed)
    const nextY = destination.y - Math.trunc(((destination.y - source.y) * this.stepsLeft) / speed)

    this.host.carryRiders(this.self.index, nextX - this.self.x, nextY - this.self.y)
    this.stepsLeft--
    this.self.x = nextX
    this.self.y = nextY
  }
}

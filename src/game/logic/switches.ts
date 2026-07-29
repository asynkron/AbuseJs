import { Behaviour, distanceX, distanceY } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'
import type { LogicFocus } from './types'

/**
 * The player-operated switches - lisp/switch.lsp.
 *
 * All three share one activation test, and all three sit behind everything
 * else in the draw order because their reload_fun is `lower_reload`.
 */

/** `(< (distx) 20)` and `(< (disty) 30)` - switcher_ai, and the other two. */
const REACH_X = 20
const REACH_Y = 30

/** Every sound in this file is SWITCH_SND at full volume. */
const SWITCH_VOLUME = 127

function withinReach(self: LogicObject, focus: LogicFocus): boolean {
  return distanceX(self, focus) < REACH_X && distanceY(self, focus) < REACH_Y
}

/**
 * The four steps of SWITCH's cycle. The original numbers them 0, 1, 2, 4 -
 * three is skipped - and consumers only test non-zero, so a switch reads as on
 * through `pressedOn` and `on`. The pair of "wait for release" steps is what
 * stops one press from toggling it twice.
 */
type ToggleStep = 'off' | 'pressedOn' | 'on' | 'pressedOff'

const TOGGLE_AISTATE: Record<ToggleStep, number> = {
  off: 0,
  pressedOn: 1,
  on: 2,
  pressedOff: 4,
}

const TOGGLE_STEP: Record<number, ToggleStep> = {
  0: 'off',
  1: 'pressedOn',
  2: 'on',
  4: 'pressedOff',
}

/** SWITCH - switcher_ai. 52 instances. A latching wall toggle. */
export class ToggleSwitch extends Behaviour {
  protected run(): void {
    // Unconditional and outside the select, so the two-frame art keeps
    // flicking over whatever step the switch is on.
    this.self.nextPicture()

    const focus = this.focus
    if (!focus) return
    const step = TOGGLE_STEP[this.self.aistate]

    switch (step) {
      case 'off':
        if (withinReach(this.self, focus) && focus.pressingAction) {
          this.press('running', TOGGLE_AISTATE.pressedOn)
        }
        return

      case 'pressedOn':
        if (!focus.pressingAction) this.self.setAiState(TOGGLE_AISTATE.on)
        return

      case 'on':
        if (withinReach(this.self, focus) && focus.pressingAction) {
          this.press('stopped', TOGGLE_AISTATE.pressedOff)
        }
        return

      case 'pressedOff':
        if (!focus.pressingAction) this.self.setAiState(TOGGLE_AISTATE.off)
    }
  }

  private press(state: string, next: number): void {
    this.host.playSound('SWITCH_SND', SWITCH_VOLUME, this.self.x, this.self.y)
    this.self.setState(state)
    this.self.setAiState(next)
  }
}

/**
 * SWITCH_ONCE - switch_once_ai. 91 instances, the most-used player trigger.
 *
 * Once pressed it is on forever: the `select` has no arm for aistate 1, so
 * nothing runs again and the art freezes on whatever frame it reached.
 */
export class OnceSwitch extends Behaviour {
  protected run(): void {
    if (this.self.aistate !== 0) return

    this.self.nextPicture()

    const focus = this.focus
    if (!focus) return
    if (!withinReach(this.self, focus) || !focus.pressingAction) return

    this.host.playSound('SWITCH_SND', SWITCH_VOLUME, this.self.x, this.self.y)
    this.self.setState('running')
    this.self.setAiState(1)
  }
}

/** `switch_delay_cons` sets this; the one shipped instance saves 45. */
const DEFAULT_RESET_TIME = 14

/** The steps of SWITCH_DELAY's cycle - aistate 0, 1, 2. */
type DelayStep = 'off' | 'pressed' | 'holding'

const DELAY_AISTATE: Record<DelayStep, number> = { off: 0, pressed: 1, holding: 2 }
const DELAY_STEP: Record<number, DelayStep> = { 0: 'off', 1: 'pressed', 2: 'holding' }

/**
 * SWITCH_DELAY - switch_delay_ai. One instance in the whole game.
 *
 * A switch that resets itself. Note where the clock starts: `state_time` is
 * reset by `set_aistate`, and the holding step is entered when the player lets
 * go, so the hold runs from the release, not from the press.
 */
export class DelaySwitch extends Behaviour {
  private readonly resetTime: number

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    this.resetTime = self.variable('reset_time', DEFAULT_RESET_TIME)
  }

  protected run(): void {
    const step = DELAY_STEP[this.self.aistate]
    const focus = this.focus

    switch (step) {
      case 'off': {
        this.self.nextPicture()
        if (!focus || !withinReach(this.self, focus) || !focus.pressingAction) return
        this.host.playSound('SWITCH_SND', SWITCH_VOLUME, this.self.x, this.self.y)
        this.self.setState('running')
        this.self.setAiState(DELAY_AISTATE.pressed)
        return
      }

      case 'pressed':
        if (focus && !focus.pressingAction) this.self.setAiState(DELAY_AISTATE.holding)
        return

      case 'holding':
        if (this.self.stateTime > this.resetTime) {
          this.host.playSound('SWITCH_SND', SWITCH_VOLUME, this.self.x, this.self.y)
          this.self.setState('stopped')
          this.self.setAiState(DELAY_AISTATE.off)
        }
    }
  }
}

/** A behaviour that reacts to being shot. */
export interface DamageSink {
  onDamaged(): void
}

export function isDamageSink(behaviour: Behaviour): behaviour is Behaviour & DamageSink {
  return typeof (behaviour as Partial<DamageSink>).onDamaged === 'function'
}

/**
 * SWITCH_BALL - lisp/general.lsp, `sball_damage`. 15 instances, feeding
 * GATE_AND and SWITCH_DOOR.
 *
 * It has no ai of its own - `do_nothing` just runs the animation - and its
 * whole behaviour is the damage hook: the first hit while it is in `stopped`
 * latches it on for good.
 */
export class BallSwitch extends Behaviour implements DamageSink {
  protected run(): void {
    this.self.nextPicture()
  }

  onDamaged(): void {
    if (this.self.state !== 'stopped') return
    this.self.setAiState(1)
    this.self.setState('running')
  }
}

import { Behaviour } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'

/**
 * The logic gates - lisp/gates.lsp.
 *
 * All of them write their result to both `aistate` (1 or 0) and `state`
 * (`on_state` or `stopped`), and all of them are editor-only art: what you see
 * in game is whatever they drive.
 */

const ON = 1
const OFF = 0

/** Sets a gate's output, keeping signal and sprite in lockstep. */
function emit(self: LogicObject, on: boolean): void {
  self.setState(on ? 'on_state' : 'stopped')
  self.setAiState(on ? ON : OFF)
}

export type CombinationalKind = 'or' | 'and' | 'xor' | 'not'

/**
 * GATE_OR, GATE_AND, GATE_XOR and GATE_NOT - or_ai, and_ai, xor_ai, not_ai.
 *
 * Recomputed from scratch every tick from the gate's own link list. The empty
 * cases are worth keeping rather than tidying: `or_check` bottoms out at nil so
 * an unwired OR is off, `and_check` bottoms out at T so an unwired AND is
 * permanently ON, and `not_ai` guards its whole body with
 * `(> (total_objects) 0)` so an unwired NOT holds whatever it had.
 *
 * XOR is odd parity, not two-input exclusive-or - `xor_check` flips its
 * accumulator once per non-zero input. Every shipped instance has two inputs,
 * so the distinction never shows, but the code says parity.
 *
 * NOT reads link 0 only and ignores any further links; all 42 in the shipped
 * levels have exactly one.
 */
export class CombinationalGate extends Behaviour {
  constructor(
    self: LogicObject,
    world: LogicWorld,
    private readonly kind: CombinationalKind,
  ) {
    super(self, world)
  }

  protected run(): void {
    const inputs = this.signals.linksOf(this.self.index)

    switch (this.kind) {
      case 'or':
        emit(this.self, inputs.some((input) => this.signals.isOn(input)))
        return
      case 'and':
        emit(this.self, inputs.every((input) => this.signals.isOn(input)))
        return
      case 'xor':
        emit(this.self, inputs.filter((input) => this.signals.isOn(input)).length % 2 === 1)
        return
      case 'not':
        if (inputs.length === 0) return
        emit(this.self, !this.signals.isOn(inputs[0]))
    }
  }
}

/**
 * Fallback delay for GATE_DELAY, ours rather than the original's.
 *
 * `delay_time` is a saved lvar with no constructor default, so with the lvars
 * chunk unread it would come through as 0 - and a delay of 0 never flips,
 * because `delay_ai` only counts down while `xvel` is above zero. 10 is the
 * most common shipped value (30 of the 228 gates; 1, 14, 24 and 3 are the
 * next four).
 */
const FALLBACK_DELAY_TIME = 10

/**
 * GATE_DELAY - delay_ai. The most common gate in the game by a distance, and
 * 152 of the 228 take another GATE_DELAY as their input, which is how the
 * levels build sequences.
 *
 * It follows its input after a fixed number of ticks in both directions. The
 * countdown restarts from scratch on every mismatch, so a pulse shorter than
 * the delay still gets through: it is a delay line, not a debounce.
 */
export class DelayGate extends Behaviour {
  /** The original keeps this countdown in `xvel`, which the level saves. */
  private countdown: number
  private readonly delayTime: number

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    this.countdown = Math.max(0, self.data.xvel)
    this.delayTime = self.variable('delay_time', FALLBACK_DELAY_TIME)
  }

  protected run(): void {
    if (this.countdown > 0) {
      this.countdown--
      // The flip is decided from `state`, not from aistate - delay_ai does
      // exactly this, which is why the two must be kept in lockstep.
      if (this.countdown === 0) emit(this.self, this.self.state === 'stopped')
      return
    }

    const input = this.signals.driverOf(this.self.index)
    if (input === undefined) return
    if (this.signals.isOn(input) === this.signals.isOn(this.self.index)) return
    this.countdown = this.delayTime
  }
}

/**
 * Fallback for GATE_PULSE's `pulse_speed`: 0 in three of the four shipped
 * gates, 1 in the fourth. Ours only in the sense that one had to be picked.
 */
const FALLBACK_PULSE_SPEED = 0

/**
 * GATE_PULSE - pulse_ai. Four instances in the whole game.
 *
 * Does nothing at all unless its input is on, and there is no reset when the
 * input goes away, so it freezes mid-cycle. The duty cycle is asymmetric
 * because `time_left` is reloaded only on the off -> on edge: on for
 * `pulse_speed` + 1 ticks, off for exactly one.
 */
export class PulseGate extends Behaviour {
  private timeLeft: number
  private readonly pulseSpeed: number

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    this.pulseSpeed = self.variable('pulse_speed', FALLBACK_PULSE_SPEED)
    this.timeLeft = self.variable('time_left', 0)
  }

  protected run(): void {
    const input = this.signals.driverOf(this.self.index)
    if (input === undefined || !this.signals.isOn(input)) return

    if (this.timeLeft !== 0) {
      this.timeLeft--
      return
    }

    if (this.self.aistate === 0) {
      this.timeLeft = this.pulseSpeed
      emit(this.self, true)
    } else {
      emit(this.self, false)
    }
  }
}

/**
 * INDICATOR - indicator_ai. A lamp that mirrors link 0 into its own aistate
 * and its sprite. Unlike the gates it is drawn in game, and unlike them it is
 * also a signal source for anything reading it. With no links it holds.
 */
export class Indicator extends Behaviour {
  protected run(): void {
    const input = this.signals.driverOf(this.self.index)
    if (input === undefined) return
    emit(this.self, this.signals.isOn(input))
  }
}

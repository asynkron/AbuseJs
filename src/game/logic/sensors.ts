import { Behaviour, distanceX, distanceY } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'

/**
 * The two sensors - lisp/switch.lsp.
 *
 * SENSOR is the workhorse producer of the whole game: 657 instances, more than
 * any other logic object.
 */

/** Half-extents of a sensor's trigger and release boxes. */
interface SensorBoxes {
  onX: number
  onY: number
  offX: number
  offY: number
}

/**
 * `sensor_ct`, the type_change_fun, loads these whenever `aitype` is set - so
 * they are what a sensor has before the level's own saved fields land on top.
 * There is no case for aitype 0 or 4, and three shipped sensors are aitype 4,
 * so those keep whatever the level saved.
 */
const BOX_PRESETS: Record<number, SensorBoxes> = {
  1: { onX: 50, onY: 50, offX: 100, offY: 100 },
  2: { onX: 50, onY: 30, offX: 100, offY: 50 },
  3: { onX: 50, onY: 15, offX: 100, offY: 30 },
}

/** What a sensor falls back to with nothing saved and no preset: aitype 1's. */
const DEFAULT_BOXES: SensorBoxes = BOX_PRESETS[1]

/**
 * SENSOR - sensor_ai, which ships compiled but is left in switch.lsp as a
 * commented-out reference implementation.
 *
 * Two nested boxes measured from the sensor to the player: a tight one to trip
 * it and a wider one to release it, so standing on the edge does not chatter.
 * `hp` doubles as a hold time - non-zero means the aistate is loaded with it
 * and counts down, making the sensor a one-shot. Every one of the 657 shipped
 * sensors saves hp 0, so that branch never runs in the real game;
 * `sensor_cons` is what forces it, with `(add_hp -10)` on a default 6.
 */
export class Sensor extends Behaviour {
  private readonly boxes: SensorBoxes
  private readonly holdTicks: number
  /**
   * `unoffable` (field sens_unoff): once tripped, the sensor stays tripped.
   *
   * The reference lisp in switch.lsp never reads it, but the compiled sensor
   * does - src/sensor.cpp:45, `else if (!o->lvars[un_offable])`, where the
   * underscore is why the field is easy to miss. 372 sensors set it.
   */
  private readonly latching: boolean

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)

    // The presets are only a fallback: every shipped sensor saves real boxes.
    const preset = BOX_PRESETS[self.data.aitype] ?? DEFAULT_BOXES
    this.boxes = {
      onX: self.data.xvel || preset.onX,
      onY: self.data.yvel || preset.onY,
      offX: self.data.xacel || preset.offX,
      offY: self.data.yacel || preset.offY,
    }
    this.holdTicks = self.data.hp
    this.latching = self.variable('unoffable', 0) !== 0
  }

  protected run(): void {
    const focus = this.focus
    if (!focus) return

    const distX = distanceX(this.self, focus)
    const distY = distanceY(this.self, focus)

    if (this.self.aistate === 0) {
      if (distX < this.boxes.onX && distY < this.boxes.onY) {
        this.self.setAiState(this.holdTicks === 0 ? 1 : this.holdTicks)
        this.self.setState('blocking')
      } else {
        this.self.setState('stopped')
      }
      return
    }

    // src/sensor.cpp:45 tests un_offable *before* the hold countdown, so a
    // latching sensor freezes outright rather than counting itself back down.
    // Six sensors save both fields, and this is the difference for them.
    if (this.latching) return

    if (this.holdTicks !== 0) {
      // The aistate value is the remaining hold, counted down a tick at a time.
      this.self.setAiState(this.self.aistate - 1)
      return
    }

    if (distX > this.boxes.offX || distY > this.boxes.offY) this.self.setAiState(0)
  }
}

/**
 * DEATH_SENSOR - death_sen_ai. 201 instances, one of the main sources feeding
 * the gates.
 *
 * It watches the objects it links to and turns on for good once they are all
 * gone. Only link 0 is examined per tick, so a sensor watching n corpses takes
 * n ticks to clear - which is the original's behaviour, not an oversight worth
 * fixing, since nothing downstream can tell the difference.
 */
export class DeathSensor extends Behaviour {
  protected run(): void {
    const watched = this.signals.linksOf(this.self.index)
    if (watched.length === 0) {
      this.self.setState('running')
      this.self.setAiState(1)
      return
    }

    if (this.host.isDefeated(watched[0])) this.signals.unlink(this.self.index, watched[0])
  }
}

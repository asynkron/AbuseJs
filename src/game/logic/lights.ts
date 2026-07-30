import { Behaviour } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'
import { distanceX, distanceY } from './behaviour'

/**
 * The two objects that do something to a light at runtime - LIGHTHOLD, which
 * carries one about, and DIMMER / SWITCH_DIMMER, which fade one up and down
 * (lisp/common.lsp:28-40, lisp/light.lsp:4-78).
 *
 * Both hinge on `(get_light 0)`, an object owning a light. That association is
 * in the level format as a `light_links` table and the converter reads it now,
 * so these are exact rather than guessed: a LIGHTHOLD moves the lamp it was
 * saved holding, and a dimmer fades its own.
 *
 * `set_light_value` falls back to the level's ambient when an object owns no
 * light at all, which is `general_dim_ai`'s own behaviour and is how a bare
 * DIMMER darkens a whole room.
 */

/** `dim_cons`: step 20 a tick, over 5 ticks. */
const DIM_DEFAULT_STEP = 20
const DIM_DEFAULT_STEPS = 5

/** `dim_ai`'s vertical trigger band, which is not a field. */
const DIM_TRIGGER_Y = 50

const FADEON_VOLUME = 127

/**
 * LIGHTHOLD - `lhold_ai`. Rides on top of link 0 and drags its light with it,
 * so a lamp carried by a lift or a mover actually travels.
 */
export class LightHold extends Behaviour {
  protected run(): void {
    const links = this.signals.linksOf(this.self.index)
    if (links.length > 0) {
      const carrier = this.world.positionOf(links[0])
      if (carrier) {
        this.self.x = carrier.x
        // `(- (y) (/ (picture_height) 2))` - it sits at the carrier's middle.
        this.self.y = carrier.y - this.self.picture.height / 2
      }
    }

    // `(if (eq (total_lights) 1) ...)` - exactly one, or it leaves it alone.
    const lights = this.world.lightsOf(this.self.index)
    if (lights.length === 1) this.world.moveLight(lights[0], this.self.x, this.self.y)
  }
}

/**
 * DIMMER and SWITCH_DIMMER - `general_dim_ai`, which both feed with their own
 * pair of conditions.
 *
 * Six aistates: wait, fade one way over `dimmer_steps` ticks, tell link 0 it is
 * done, wait for the reverse condition, fade back, tell link 0 again. The sound
 * only plays on whichever direction is the darkening one, and only when
 * `dimmer_silent` is zero.
 */
export class Dimmer extends Behaviour {
  private readonly step: number
  private readonly steps: number
  private readonly silent: boolean
  private readonly triggerX: number
  private readonly releaseX: number
  private readonly switched: boolean

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    this.step = self.data.xvel || DIM_DEFAULT_STEP
    this.steps = self.data.yvel || DIM_DEFAULT_STEPS
    this.silent = self.data.yacel !== 0
    this.triggerX = self.data.aitype
    this.releaseX = self.data.xacel
    this.switched = self.data.type === 'SWITCH_DIMMER'
  }

  /** `switch_dim_ai` watches its link; `dim_ai` watches the player's distance. */
  private get activating(): boolean {
    if (this.switched) return this.signals.isDriven(this.self.index)
    const focus = this.focus
    if (!focus) return false
    return (
      distanceX(this.self, focus) < this.triggerX && distanceY(this.self, focus) < DIM_TRIGGER_Y
    )
  }

  private get deactivating(): boolean {
    if (this.switched) {
      const driver = this.signals.driverOf(this.self.index)
      return driver !== undefined && !this.signals.isOn(driver)
    }
    const focus = this.focus
    if (!focus) return false
    return distanceX(this.self, focus) > this.releaseX
  }

  /** The signed amount one tick of fading moves the light by. */
  private get delta(): number {
    return this.step * this.self.direction
  }

  protected run(): void {
    switch (this.self.aistate) {
      case 0:
        if (!this.activating) return
        // `(if (< (* (xvel) (direction)) 0) ...)` - only the darkening pass
        // announces itself.
        if (this.delta < 0 && !this.silent) this.sound()
        this.goState(1)
        return

      case 1:
        if (this.self.stateTime > this.steps) {
          this.goState(2)
          return
        }
        this.world.setLightValue(this.self.index, this.world.lightValue(this.self.index) - this.delta)
        return

      case 2:
        this.tellDriver(1)
        this.self.setAiState(3)
        return

      case 3:
        if (!this.deactivating) return
        if (this.delta > 0 && !this.silent) this.sound()
        this.goState(4)
        return

      case 4:
        if (this.self.stateTime > this.steps) {
          this.goState(5)
          return
        }
        this.world.setLightValue(this.self.index, this.world.lightValue(this.self.index) + this.delta)
        return

      case 5:
        this.tellDriver(4)
        this.self.setAiState(0)
        return
    }
  }

  /** `(with_object (get_object 0) (set_aistate n))` - it reports back upstream. */
  private tellDriver(aistate: number): void {
    const driver = this.signals.driverOf(this.self.index)
    if (driver !== undefined) this.signals.setState(driver, aistate)
  }

  private sound(): void {
    this.host.playSound('FADEON_SND', FADEON_VOLUME, this.self.x, this.self.y)
  }
}

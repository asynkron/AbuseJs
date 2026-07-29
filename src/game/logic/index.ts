import { Behaviour } from './behaviour'
import type { LogicWorld } from './behaviour'
import { DisappearingStep, SlidingDoor } from './doors'
import { CombinationalGate, DelayGate, Indicator, PulseGate } from './gates'
import type { CombinationalKind } from './gates'
import { LogicObject } from './object'
import { Platform } from './platforms'
import { DeathSensor, Sensor } from './sensors'
import { SignalNetwork } from './signals'
import { Spring } from './springs'
import { BallSwitch, DelaySwitch, isDamageSink, OnceSwitch, ToggleSwitch } from './switches'
import type { LogicHost, LogicObjectData, LogicView } from './types'

export type { LogicFocus, LogicHost, LogicObjectData, LogicSound, LogicView, PictureSize } from './types'
export { SignalNetwork } from './signals'

/** Builds the ai for one character type. */
type BehaviourFactory = (self: LogicObject, world: LogicWorld) => Behaviour

const gate =
  (kind: CombinationalKind): BehaviourFactory =>
  (self, world) =>
    new CombinationalGate(self, world, kind)

const BEHAVIOURS: Record<string, BehaviourFactory> = {
  // Producers.
  SENSOR: (self, world) => new Sensor(self, world),
  DEATH_SENSOR: (self, world) => new DeathSensor(self, world),
  SWITCH: (self, world) => new ToggleSwitch(self, world),
  SWITCH_ONCE: (self, world) => new OnceSwitch(self, world),
  SWITCH_DELAY: (self, world) => new DelaySwitch(self, world),
  SWITCH_BALL: (self, world) => new BallSwitch(self, world),

  // Gates.
  GATE_OR: gate('or'),
  GATE_AND: gate('and'),
  GATE_XOR: gate('xor'),
  GATE_NOT: gate('not'),
  GATE_DELAY: (self, world) => new DelayGate(self, world),
  GATE_PULSE: (self, world) => new PulseGate(self, world),
  INDICATOR: (self, world) => new Indicator(self, world),

  // Consumers.
  SWITCH_DOOR: (self, world) => new SlidingDoor(self, world, true),
  TRAP_DOOR2: (self, world) => new SlidingDoor(self, world, false),
  TRAP_DOOR3: (self, world) => new SlidingDoor(self, world, false),
  STEP: (self, world) => new DisappearingStep(self, world),
  SPRING: (self, world) => new Spring(self, world),
  SMART_PLAT_BIG: (self, world) => new Platform(self, world),
  SMART_PLAT_SMALL: (self, world) => new Platform(self, world),
  SMART_PLAT_RED: (self, world) => new Platform(self, world),
}

/** True for a character this subsystem takes over from the generic prop. */
export function hasLevelLogic(type: string): boolean {
  return type in BEHAVIOURS
}

interface Entry {
  readonly object: LogicObject
  readonly behaviour: Behaviour
}

/** A live window onto one logic object; the fields track it, nothing copies. */
class EntryView implements LogicView {
  constructor(private readonly entry: Entry) {}

  get index(): number {
    return this.entry.object.index
  }

  get type(): string {
    return this.entry.object.type
  }

  get x(): number {
    return this.entry.object.x
  }

  get y(): number {
    return this.entry.object.y
  }

  get state(): string {
    return this.entry.object.state
  }

  get frame(): number {
    return this.entry.object.frame
  }

  get aistate(): number {
    return this.entry.object.aistate
  }

  get solid(): boolean {
    return this.entry.behaviour.solid
  }
}

/**
 * The level's logic subsystem: the signal network plus every object that
 * drives it or is driven by it.
 *
 * One `tick` per game tick, and everything else is a query. Objects run in
 * level order, exactly as the original does, which is why a chain of delay
 * gates advances one link per tick rather than settling instantly.
 */
export class LevelLogic implements LogicWorld {
  readonly signals: SignalNetwork
  private readonly entries: Entry[] = []
  private readonly byIndex = new Map<number, Entry>()
  private readonly viewList: LogicView[] = []
  private readonly viewByIndex = new Map<number, LogicView>()

  constructor(
    private readonly objects: readonly LogicObjectData[],
    links: readonly (readonly number[])[],
    readonly host: LogicHost,
  ) {
    this.signals = new SignalNetwork(objects, links)

    objects.forEach((data, index) => {
      const factory = BEHAVIOURS[data.type]
      if (!factory) return

      const object = new LogicObject(index, data, this.signals, host)
      const entry: Entry = { object, behaviour: factory(object, this) }
      this.entries.push(entry)
      this.byIndex.set(index, entry)

      const view = new EntryView(entry)
      this.viewList.push(view)
      this.viewByIndex.set(index, view)
    })
  }

  /** One game tick. Call it once, before anything reads the signals. */
  tick(): void {
    for (const entry of this.entries) entry.behaviour.tick()
  }

  /** The raw signal: non-zero means on. */
  isOn(index: number): boolean {
    return this.signals.isOn(index)
  }

  /** `(activated)` - see SignalNetwork. Force fields and bombs are gated on it. */
  isActivated(index: number): boolean {
    return this.signals.isActivated(index)
  }

  /** Every object this subsystem drives, in level order. */
  get views(): readonly LogicView[] {
    return this.viewList
  }

  viewOf(index: number): LogicView | undefined {
    return this.viewByIndex.get(index)
  }

  /** True when the logic owns this object, so the world should not also drive it. */
  owns(index: number): boolean {
    return this.byIndex.has(index)
  }

  /**
   * Damage taken by a logic object. Only SWITCH_BALL cares - it latches on the
   * first hit - but routing all damage through here keeps the caller from
   * having to know that.
   */
  reportDamage(index: number): void {
    const entry = this.byIndex.get(index)
    if (entry && isDamageSink(entry.behaviour)) entry.behaviour.onDamaged()
  }

  /** Live position of any level object, moving or not. */
  positionOf(index: number): { x: number; y: number } | undefined {
    const entry = this.byIndex.get(index)
    if (entry) return { x: entry.object.x, y: entry.object.y }
    const data = this.objects[index]
    return data ? { x: data.x, y: data.y } : undefined
  }

  /** Counts for the debug overlay: how much of the network is live. */
  get counts(): { objects: number; on: number } {
    let on = 0
    for (const entry of this.entries) if (entry.object.aistate !== 0) on++
    return { objects: this.entries.length, on }
  }
}

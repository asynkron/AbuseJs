import type { LevelObjectData } from '../assets/types'

/**
 * The level's logic network.
 *
 * Abuse wires levels with a single idea: every object has an `aistate`, and
 * non-zero means "on". Sensors set their own from the player's position, logic
 * gates compute theirs from the objects they link to, and consumers - doors,
 * platforms, force fields - read the state of whatever they link to
 * (lisp/switch.lsp, lisp/gates.lsp, `(with_object (get_object 0) (aistate))`).
 *
 * Links point from the driven object to its driver, so a gate links to its
 * inputs and a door links to its switch.
 */

/** Sensor configuration, packed into fields it does not otherwise use. */
interface Sensor {
  index: number
  x: number
  y: number
  /** Half-extents of the region that switches it on. */
  onX: number
  onY: number
  /** Half-extents it must be left before it switches off again. */
  offX: number
  offY: number
  /** Non-zero means it latches for this many ticks instead of tracking. */
  timeout: number
  countdown: number
}

interface Gate {
  index: number
  kind: 'and' | 'or' | 'xor' | 'not'
  inputs: number[]
}

const GATE_KINDS: Record<string, Gate['kind']> = {
  GATE_AND: 'and',
  GATE_OR: 'or',
  GATE_XOR: 'xor',
  GATE_NOT: 'not',
}

/** Sensor types that watch for the player. */
const SENSOR_TYPES = new Set(['SENSOR', 'DIFFICULTY_SENSOR'])

/** Gate chains are shallow; a few passes settle any ordering. */
const SETTLE_PASSES = 4

export class Signals {
  /** Current `aistate` per object index. */
  private readonly state: Int32Array

  private readonly sensors: Sensor[] = []
  private readonly gates: Gate[] = []
  /** Objects that produce a signal rather than consume one. */
  private readonly sources = new Set<number>()
  private readonly drivers: number[][]

  constructor(objects: LevelObjectData[], private readonly links: number[][]) {
    this.state = new Int32Array(objects.length)

    objects.forEach((object, index) => {
      // Levels save the state each object was last in; keep it as the start.
      this.state[index] = object.aistate

      if (SENSOR_TYPES.has(object.type)) {
        this.sensors.push({
          index,
          x: object.x,
          y: object.y,
          onX: object.xvel || 50,
          onY: object.yvel || 50,
          offX: object.xacel || (object.xvel || 50) * 2,
          offY: object.yacel || (object.yvel || 50) * 2,
          timeout: object.hp,
          countdown: 0,
        })
        this.state[index] = 0
        return
      }

      const kind = GATE_KINDS[object.type]
      if (kind) {
        this.gates.push({ index, kind, inputs: links[index] ?? [] })
      }
    })

    for (const sensor of this.sensors) this.sources.add(sensor.index)
    for (const gate of this.gates) this.sources.add(gate.index)
    // Switches are driven by the player rather than computed, but they feed
    // the same network.
    objects.forEach((object, index) => {
      if (object.type.startsWith('SWITCH')) this.sources.add(index)
    })

    this.drivers = this.buildDrivers(objects.length)
  }

  /** True when this object's driver - or the object itself - is switched on. */
  isActive(index: number): boolean {
    return (this.state[index] ?? 0) !== 0
  }

  /**
   * True when a switch, sensor or gate wired to this object is on.
   *
   * The link can be recorded in either direction - a door links to its switch,
   * but level00's sensor links to the platform it drives - so both are
   * considered, and only sources count. Any one of them being on is enough.
   */
  isDriven(index: number): boolean {
    const drivers = this.drivers[index]
    return drivers !== undefined && drivers.some((d) => this.isActive(d))
  }

  /** Sources wired to each object, from links in either direction. */
  private buildDrivers(objectCount: number): number[][] {
    const drivers: number[][] = Array.from({ length: objectCount }, () => [])

    const connect = (consumer: number, source: number) => {
      if (!this.sources.has(source) || consumer === source) return
      if (!drivers[consumer].includes(source)) drivers[consumer].push(source)
    }

    for (let i = 0; i < objectCount; i++) {
      for (const target of this.links[i] ?? []) {
        connect(i, target)
        connect(target, i)
      }
    }

    return drivers
  }

  update(playerX: number, playerY: number): void {
    for (const sensor of this.sensors) this.updateSensor(sensor, playerX, playerY)

    // Gates read each other, so settle rather than assuming an order.
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      let changed = false
      for (const gate of this.gates) {
        const next = this.evaluate(gate) ? 1 : 0
        if (this.state[gate.index] !== next) {
          this.state[gate.index] = next
          changed = true
        }
      }
      if (!changed) break
    }
  }

  private updateSensor(sensor: Sensor, playerX: number, playerY: number): void {
    const dx = Math.abs(playerX - sensor.x)
    const dy = Math.abs(playerY - sensor.y)

    if (this.state[sensor.index] === 0) {
      if (dx < sensor.onX && dy < sensor.onY) {
        // hp non-zero makes it a one-shot that holds for that many ticks.
        this.state[sensor.index] = 1
        sensor.countdown = sensor.timeout
      }
      return
    }

    if (sensor.timeout > 0) {
      if (--sensor.countdown <= 0) this.state[sensor.index] = 0
      return
    }

    // Hysteresis: a wider box to leave than to enter, so standing on the edge
    // does not chatter.
    if (dx > sensor.offX || dy > sensor.offY) this.state[sensor.index] = 0
  }

  private evaluate(gate: Gate): boolean {
    const states = gate.inputs.map((i) => this.isActive(i))
    switch (gate.kind) {
      case 'and':
        return states.length > 0 && states.every(Boolean)
      case 'or':
        return states.some(Boolean)
      case 'xor':
        return states.filter(Boolean).length % 2 === 1
      case 'not':
        return states.length > 0 && !states[0]
    }
  }

  get counts(): { sensors: number; gates: number; active: number } {
    let active = 0
    for (const sensor of this.sensors) if (this.state[sensor.index]) active++
    for (const gate of this.gates) if (this.state[gate.index]) active++
    return { sensors: this.sensors.length, gates: this.gates.length, active }
  }
}

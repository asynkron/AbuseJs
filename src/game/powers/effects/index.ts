import type { PowerEffect, PowerKind } from '../types'
import { FastPower } from './fast'
import { FlyPower, type Random } from './fly'
import { HealthPower } from './health'
import { SneakyPower } from './sneaky'

export { FastPower } from './fast'
export { FlyPower, type Random } from './fly'
export { HealthPower } from './health'
export { SneakyPower } from './sneaky'

/**
 * Builds a fresh effect. Each one owns its own ramp or trail, so picking a
 * power up twice starts it clean rather than resuming a half-faded cloak.
 */
export function createPowerEffect(kind: PowerKind, random?: Random): PowerEffect {
  switch (kind) {
    case 'fast':
      return new FastPower()
    case 'fly':
      return new FlyPower(random)
    case 'sneaky':
      return new SneakyPower()
    case 'health':
      return new HealthPower()
  }
}

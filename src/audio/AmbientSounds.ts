import type { LevelObjectData } from '../assets/types'
import type { AudioBank } from './AudioBank'

/**
 * The AMBIENT_SOUND emitters a level places - dripping caves, machinery hum,
 * distant screams.
 *
 * Configuration is packed into fields the object otherwise uses for physics
 * (lisp/sfx.lsp, `ambs_cons` and `amb_sound_ai`):
 *
 *   aitype -> index into the 17-entry AMB_SOUNDS table
 *   yvel   -> volume, 0..127
 *   xvel   -> ticks between repeats
 *   xacel  -> extra random ticks on top
 *
 * The original only ticks emitters while their region is active; we use plain
 * earshot instead, which keeps distant machinery from firing constantly.
 */

interface Emitter {
  path: string
  x: number
  y: number
  volume: number
  /** Base repeat delay in ticks. */
  delay: number
  /** Extra random delay in ticks. */
  spread: number
  countdown: number
}

/** Emitters further than this from the listener do not tick. */
const EARSHOT = 700
/** Fallback when a level leaves the repeat delay at zero. */
const DEFAULT_DELAY_TICKS = 100

export class AmbientSounds {
  private readonly emitters: Emitter[] = []

  constructor(
    private readonly audio: AudioBank,
    objects: LevelObjectData[],
    private readonly random: () => number = Math.random,
  ) {
    for (const object of objects) {
      if (object.type !== 'AMBIENT_SOUND' && object.type !== 'AMBIENT_SOUND2') continue
      const path = audio.ambientPath(object.aitype)
      if (!path) continue

      const delay = object.xvel > 0 ? object.xvel : DEFAULT_DELAY_TICKS
      this.emitters.push({
        path,
        x: object.x,
        y: object.y,
        volume: Math.max(0, Math.min(1, (object.yvel || 127) / 127)),
        delay,
        spread: Math.max(0, object.xacel),
        // Stagger the first trigger so a room full of emitters does not fire
        // in unison the moment the level loads.
        countdown: Math.floor(this.random() * delay),
      })
    }
  }

  update(listenerX: number, listenerY: number): void {
    if (!this.audio.ready) return

    for (const emitter of this.emitters) {
      const dx = emitter.x - listenerX
      const dy = emitter.y - listenerY
      if (Math.abs(dx) > EARSHOT || Math.abs(dy) > EARSHOT) continue

      if (emitter.countdown > 0) {
        emitter.countdown--
        continue
      }

      this.audio.play(emitter.path, { volume: emitter.volume, x: emitter.x, y: emitter.y })
      emitter.countdown = emitter.delay + Math.floor(this.random() * (emitter.spread + 1))
    }
  }

  get count(): number {
    return this.emitters.length
  }
}

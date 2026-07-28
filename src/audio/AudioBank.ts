/**
 * Sound playback for the original Abuse effects.
 *
 * The samples are 8-bit unsigned mono 11 kHz PCM, which `decodeAudioData`
 * handles directly, so the wavs ship as-is. Clips are fetched on first use and
 * cached; nothing is preloaded, since a level only ever touches a handful of
 * the 133.
 *
 * Browsers refuse to start an AudioContext before a user gesture, so this
 * stays suspended until the first key or click and silently drops anything
 * asked for before then.
 */

export interface SoundManifest {
  /** Symbol name -> path under public/assets. */
  named: Record<string, string>
  /** AMBIENT_SOUND's 17-entry table, indexed by the object's `aitype`. */
  ambient: (string | null)[]
  arrays: Record<string, (string | null)[]>
}

export interface PlayOptions {
  /** 0..1 before distance falloff. Abuse stores 0..127. */
  volume?: number
  /** World position; omit for a non-positional sound. */
  x?: number
  y?: number
  loop?: boolean
}

/** Beyond this many world pixels a positional sound is inaudible. */
const EARSHOT = 640

export class AudioBank {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private readonly buffers = new Map<string, AudioBuffer | null>()
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>()

  /** Listener position in world space, kept in sync with the camera. */
  private listenerX = 0
  private listenerY = 0
  /** Starts muted; the volume slider is the only way to turn it up. */
  private masterVolume = 0

  constructor(
    private readonly manifest: SoundManifest,
    private readonly base = 'assets',
  ) {}

  /**
   * Creates or resumes the context. Must be called from a user gesture; safe
   * to call repeatedly.
   */
  unlock(): void {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.context = new Ctor()
      this.master = this.context.createGain()
      // Silent until asked for. Abuse's ambience is mostly distant screaming,
      // which is not what anyone wants a page to do unprompted.
      this.master.gain.value = this.masterVolume
      this.master.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') void this.context.resume()
  }

  get ready(): boolean {
    return this.context !== null && this.context.state === 'running'
  }

  setListener(x: number, y: number): void {
    this.listenerX = x
    this.listenerY = y
  }

  get volume(): number {
    return this.masterVolume
  }

  set volume(value: number) {
    this.masterVolume = Math.max(0, Math.min(1, value))
    if (this.master) this.master.gain.value = this.masterVolume
  }

  get muted(): boolean {
    return this.masterVolume <= 0
  }

  /** The shared context, once unlocked. */
  get context_(): AudioContext | null {
    return this.context
  }

  /**
   * A gain node feeding the master bus, for something that manages its own
   * scheduling - the music player. Null until the context is unlocked.
   */
  createBus(gain = 1): GainNode | null {
    if (!this.context || !this.master) return null
    const bus = this.context.createGain()
    bus.gain.value = gain
    bus.connect(this.master)
    return bus
  }

  /** Resolves a symbolic name like `LSABER_SND` to its path. */
  pathFor(name: string): string | undefined {
    return this.manifest.named[name]
  }

  ambientPath(index: number): string | null {
    return this.manifest.ambient[index] ?? null
  }

  private async load(path: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(path)
    if (cached !== undefined) return cached

    const inFlight = this.pending.get(path)
    if (inFlight) return inFlight

    const task = (async () => {
      try {
        const res = await fetch(`${this.base}/${path}`)
        if (!res.ok) throw new Error(String(res.status))
        const bytes = await res.arrayBuffer()
        const buffer = await this.context!.decodeAudioData(bytes)
        this.buffers.set(path, buffer)
        return buffer
      } catch {
        // A sample that will not decode should not take the game with it.
        this.buffers.set(path, null)
        return null
      } finally {
        this.pending.delete(path)
      }
    })()

    this.pending.set(path, task)
    return task
  }

  /**
   * Plays a clip by path. Returns the source so callers can stop a loop.
   * Positional sounds attenuate linearly to silence at EARSHOT and pan by
   * their horizontal offset, which is close enough to how the original placed
   * them and costs nothing.
   */
  play(path: string, options: PlayOptions = {}): void {
    if (!this.context || !this.master) return
    // Muted means muted: do not even fetch the clip.
    if (this.masterVolume <= 0) return

    let gain = options.volume ?? 1
    let pan = 0

    if (options.x !== undefined && options.y !== undefined) {
      const dx = options.x - this.listenerX
      const dy = options.y - this.listenerY
      const distance = Math.hypot(dx, dy)
      if (distance >= EARSHOT) return
      gain *= 1 - distance / EARSHOT
      pan = Math.max(-1, Math.min(1, dx / (EARSHOT * 0.5)))
    }

    if (gain <= 0.001) return

    void this.load(path).then((buffer) => {
      if (!buffer || !this.context || !this.master) return

      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.loop = options.loop ?? false

      const gainNode = this.context.createGain()
      gainNode.gain.value = gain

      if (typeof this.context.createStereoPanner === 'function') {
        const panner = this.context.createStereoPanner()
        panner.pan.value = pan
        source.connect(gainNode).connect(panner).connect(this.master)
      } else {
        source.connect(gainNode).connect(this.master)
      }

      source.start()
    })
  }

  /** Plays a clip by its lisp symbol, e.g. `APPEAR_SND`. */
  playNamed(name: string, options: PlayOptions = {}): void {
    const path = this.pathFor(name)
    if (path) this.play(path, options)
  }

  get loadedCount(): number {
    return [...this.buffers.values()].filter(Boolean).length
  }
}

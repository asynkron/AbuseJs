/**
 * Plays the SC-55 patches lifted out of the shipped soundfont at build time
 * (tools/sf2.ts).
 *
 * The build step emits the zone tables as JSON plus one blob of 16-bit PCM
 * holding only the samples the soundtrack actually reaches - 137 of them,
 * 1.2MB - so this just has to pick a zone for the note and play the sample at
 * the right rate.
 */

interface Zone {
  keyLo: number
  keyHi: number
  velLo: number
  velHi: number
  sample: number
  rootKey: number
  coarseTune: number
  fineTune: number
  attenuation: number
  loopMode: number
  loopStart: number
  loopEnd: number
  release: number
}

interface SampleHeader {
  name: string
  offset: number
  length: number
  sampleRate: number
}

interface SoundFontData {
  presets: Record<string, Zone[]>
  samples: SampleHeader[]
}

export interface Voice {
  source: AudioBufferSourceNode
  gain: GainNode
  release: number
}

export class SoundFont {
  private data: SoundFontData | null = null
  private pcm: Int16Array | null = null
  private readonly buffers = new Map<number, AudioBuffer>()

  get loaded(): boolean {
    return this.data !== null && this.pcm !== null
  }

  get presetCount(): number {
    return this.data ? Object.keys(this.data.presets).length : 0
  }

  async load(base = 'assets'): Promise<boolean> {
    if (this.loaded) return true
    try {
      const [json, pcm] = await Promise.all([
        fetch(`${base}/music/soundfont.json`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${base}/music/samples.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)),
      ])
      if (!json || !pcm) return false
      this.data = json as SoundFontData
      this.pcm = new Int16Array(pcm)
      return true
    } catch {
      return false
    }
  }

  /**
   * Picks the zone covering this key and velocity. Zones overlap in a
   * soundfont; first match wins, which is what a simple player does.
   */
  private zoneFor(bank: number, program: number, key: number, velocity: number): Zone | null {
    if (!this.data) return null
    const zones =
      this.data.presets[`${bank}:${program}`] ??
      // Fall back within the same bank, then to the first melodic patch, so an
      // unmapped program still makes a sound.
      this.data.presets[`${bank}:0`] ??
      this.data.presets['0:0']
    if (!zones) return null

    for (const zone of zones) {
      if (key < zone.keyLo || key > zone.keyHi) continue
      if (velocity < zone.velLo || velocity > zone.velHi) continue
      return zone
    }
    return zones[0] ?? null
  }

  private bufferFor(context: AudioContext, index: number): AudioBuffer | null {
    const cached = this.buffers.get(index)
    if (cached) return cached
    if (!this.data || !this.pcm) return null

    const header = this.data.samples[index]
    if (!header) return null

    const buffer = context.createBuffer(1, header.length, header.sampleRate)
    const channel = buffer.getChannelData(0)
    const start = header.offset / 2
    for (let i = 0; i < header.length; i++) channel[i] = this.pcm[start + i] / 32768
    this.buffers.set(index, buffer)
    return buffer
  }

  /** Starts a note. Returns a handle for releasing it, or null. */
  noteOn(
    context: AudioContext,
    destination: AudioNode,
    bank: number,
    program: number,
    key: number,
    velocity: number,
    time: number,
  ): Voice | null {
    const zone = this.zoneFor(bank, program, key, velocity)
    if (!zone) return null
    const buffer = this.bufferFor(context, zone.sample)
    if (!buffer) return null

    const source = context.createBufferSource()
    source.buffer = buffer

    const semitones = key - zone.rootKey + zone.coarseTune + zone.fineTune / 100
    source.playbackRate.value = Math.pow(2, semitones / 12)

    if (zone.loopMode === 1 || zone.loopMode === 3) {
      const loopStart = zone.loopStart / buffer.sampleRate
      const loopEnd = zone.loopEnd / buffer.sampleRate
      if (loopEnd > loopStart) {
        source.loop = true
        source.loopStart = loopStart
        source.loopEnd = loopEnd
      }
    }

    const gain = context.createGain()
    // Attenuation is in centibels, and velocity scales on top of it.
    const level = Math.pow(10, -zone.attenuation / 200) * (velocity / 127)
    gain.gain.setValueAtTime(0, time)
    gain.gain.linearRampToValueAtTime(level, time + 0.005)

    source.connect(gain).connect(destination)
    source.start(time)
    // A note whose note-off never arrives should still stop eventually.
    if (!source.loop) source.stop(time + buffer.duration / source.playbackRate.value + 0.1)

    return { source, gain, release: zone.release }
  }
}

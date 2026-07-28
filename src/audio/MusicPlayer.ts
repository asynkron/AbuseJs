import type { AudioBank } from './AudioBank'

/**
 * Plays Abuse's soundtrack, converted from HMI to standard MIDI at build time
 * (see tools/hmi.ts).
 *
 * The original renders these through a Roland SC-55 soundfont. Shipping a
 * 3MB SF2 and writing a sampler for it is a much bigger job than the music
 * warrants right now, so this synthesises the note data directly: one
 * oscillator voice per note, waveform chosen from the General MIDI program
 * family, plus a noise burst for the percussion channel. It plays the real
 * composition with a substitute voice, not the original timbres.
 *
 * Scheduling uses the standard lookahead pattern - a coarse timer that pushes
 * events into WebAudio's sample-accurate clock a fraction of a second ahead.
 */

interface MidiEvent {
  tick: number
  status: number
  data1: number
  data2: number
}

/** How far ahead events are queued, and how often the queue is topped up. */
const LOOKAHEAD_SECONDS = 0.3
const SCHEDULE_INTERVAL_MS = 100
/** MIDI's percussion channel. */
const DRUM_CHANNEL = 9

function waveformFor(program: number): OscillatorType {
  if (program < 16) return 'triangle' // pianos, chromatic percussion
  if (program < 24) return 'square' // organs
  if (program < 56) return 'sawtooth' // guitars, basses, strings, ensemble
  if (program < 80) return 'square' // brass, reeds, pipes
  if (program < 96) return 'sawtooth' // synth lead and pad
  return 'triangle'
}

function noteToFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12)
}

/** Parses a format 0/1 MIDI file into one tick-ordered event list. */
function parseMidi(buf: ArrayBuffer): { events: MidiEvent[]; secondsPerTick: number } | null {
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  if (view.byteLength < 14) return null
  if (bytes[0] !== 0x4d || bytes[1] !== 0x54 || bytes[2] !== 0x68 || bytes[3] !== 0x64) return null

  const headerLength = view.getUint32(4)
  const division = view.getUint16(12)
  let position = 8 + headerLength

  const events: MidiEvent[] = []
  // Default MIDI tempo, replaced by the file's own tempo meta event.
  let microsecondsPerBeat = 500000

  while (position + 8 <= view.byteLength) {
    const isTrack =
      bytes[position] === 0x4d &&
      bytes[position + 1] === 0x54 &&
      bytes[position + 2] === 0x72 &&
      bytes[position + 3] === 0x6b
    const length = view.getUint32(position + 4)
    const start = position + 8
    const end = Math.min(start + length, view.byteLength)
    position = start + length
    if (!isTrack) continue

    let i = start
    let tick = 0
    let runningStatus = 0

    while (i < end) {
      let delta = 0
      while (i < end) {
        const c = bytes[i++]
        delta = (delta << 7) | (c & 0x7f)
        if (!(c & 0x80)) break
      }
      tick += delta
      if (i >= end) break

      let status = bytes[i]
      if (status < 0x80) {
        if (!runningStatus) break
        status = runningStatus
      } else {
        i++
        runningStatus = status
      }

      if (status === 0xff) {
        const type = bytes[i++]
        let metaLength = 0
        while (i < end) {
          const c = bytes[i++]
          metaLength = (metaLength << 7) | (c & 0x7f)
          if (!(c & 0x80)) break
        }
        if (type === 0x51 && metaLength === 3) {
          microsecondsPerBeat = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
        }
        i += metaLength
        continue
      }

      if (status === 0xf0 || status === 0xf7) {
        let sysexLength = 0
        while (i < end) {
          const c = bytes[i++]
          sysexLength = (sysexLength << 7) | (c & 0x7f)
          if (!(c & 0x80)) break
        }
        i += sysexLength
        continue
      }

      const high = status & 0xf0
      if (high === 0xc0 || high === 0xd0) {
        events.push({ tick, status, data1: bytes[i++], data2: 0 })
      } else {
        events.push({ tick, status, data1: bytes[i], data2: bytes[i + 1] })
        i += 2
      }
    }
  }

  events.sort((a, b) => a.tick - b.tick)
  return { events, secondsPerTick: microsecondsPerBeat / 1e6 / (division || 192) }
}

export class MusicPlayer {
  private bus: GainNode | null = null
  private noise: AudioBuffer | null = null

  private events: MidiEvent[] = []
  private secondsPerTick = 0
  private cursor = 0
  private startTime = 0
  private timer: number | null = null

  private readonly programs = new Uint8Array(16)
  /** Currently sounding voices, so a note-off can release them. */
  private readonly voices = new Map<number, { osc: OscillatorNode; gain: GainNode }>()

  private currentTrack: string | null = null

  constructor(
    private readonly audio: AudioBank,
    private readonly base = 'assets',
  ) {}

  get playing(): boolean {
    return this.timer !== null
  }

  get track(): string | null {
    return this.currentTrack
  }

  /** Loads and starts a track, looping it. Silently does nothing while muted. */
  async play(path: string): Promise<void> {
    this.stop()
    if (this.audio.muted) return

    const context = this.audio.context_
    if (!context) return

    let parsed: ReturnType<typeof parseMidi> = null
    try {
      const res = await fetch(`${this.base}/${path}`)
      if (!res.ok) return
      parsed = parseMidi(await res.arrayBuffer())
    } catch {
      return
    }
    if (!parsed || parsed.events.length === 0) return

    this.events = parsed.events
    this.secondsPerTick = parsed.secondsPerTick
    this.cursor = 0
    this.programs.fill(0)
    this.currentTrack = path

    this.bus = this.audio.createBus(0.35)
    if (!this.noise) this.noise = this.makeNoiseBuffer(context)

    this.startTime = context.currentTime + 0.1
    this.timer = window.setInterval(() => this.schedule(), SCHEDULE_INTERVAL_MS)
    this.schedule()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const voice of this.voices.values()) {
      try {
        voice.osc.stop()
      } catch {
        // Already stopped.
      }
    }
    this.voices.clear()
    this.bus?.disconnect()
    this.bus = null
    this.currentTrack = null
  }

  private makeNoiseBuffer(context: AudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, context.sampleRate * 0.2, context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return buffer
  }

  private schedule(): void {
    const context = this.audio.context_
    if (!context || !this.bus) return

    const horizon = context.currentTime + LOOKAHEAD_SECONDS

    while (this.cursor < this.events.length) {
      const event = this.events[this.cursor]
      const time = this.startTime + event.tick * this.secondsPerTick
      if (time > horizon) return

      this.cursor++
      this.dispatch(event, Math.max(time, context.currentTime))
    }

    // Loop: restart from the top once the last event has been queued.
    const lastTick = this.events[this.events.length - 1].tick
    const end = this.startTime + lastTick * this.secondsPerTick
    if (this.cursor >= this.events.length && end <= horizon) {
      this.startTime = end + 1.5
      this.cursor = 0
    }
  }

  private dispatch(event: MidiEvent, time: number): void {
    const channel = event.status & 0x0f
    const high = event.status & 0xf0

    if (high === 0xc0) {
      this.programs[channel] = event.data1
      return
    }

    const key = channel * 128 + event.data1

    if (high === 0x80 || (high === 0x90 && event.data2 === 0)) {
      this.release(key, time)
      return
    }

    if (high !== 0x90) return

    this.release(key, time)
    const voice = channel === DRUM_CHANNEL ? this.startDrum(time, event) : this.startNote(time, event, channel)
    if (voice) this.voices.set(key, voice)
  }

  private startNote(
    time: number,
    event: MidiEvent,
    channel: number,
  ): { osc: OscillatorNode; gain: GainNode } | null {
    const context = this.audio.context_
    if (!context || !this.bus) return null

    const osc = context.createOscillator()
    osc.type = waveformFor(this.programs[channel])
    osc.frequency.value = noteToFrequency(event.data1)

    const gain = context.createGain()
    const peak = (event.data2 / 127) * 0.22
    gain.gain.setValueAtTime(0, time)
    gain.gain.linearRampToValueAtTime(peak, time + 0.008)
    gain.gain.linearRampToValueAtTime(peak * 0.7, time + 0.08)

    osc.connect(gain).connect(this.bus)
    osc.start(time)
    // Safety stop: a note whose note-off is lost should not sound forever.
    osc.stop(time + 8)
    return { osc, gain }
  }

  private startDrum(time: number, event: MidiEvent): null {
    const context = this.audio.context_
    if (!context || !this.bus || !this.noise) return null

    const source = context.createBufferSource()
    source.buffer = this.noise
    // Higher notes read as tighter, brighter hits.
    source.playbackRate.value = 0.6 + (event.data1 % 24) / 24

    const gain = context.createGain()
    const peak = (event.data2 / 127) * 0.18
    gain.gain.setValueAtTime(peak, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16)

    source.connect(gain).connect(this.bus)
    source.start(time)
    source.stop(time + 0.2)
    return null
  }

  private release(key: number, time: number): void {
    const voice = this.voices.get(key)
    if (!voice) return
    this.voices.delete(key)
    try {
      voice.gain.gain.cancelScheduledValues(time)
      voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), time)
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.09)
      voice.osc.stop(time + 0.1)
    } catch {
      // Node already stopped.
    }
  }
}

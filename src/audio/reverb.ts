/**
 * The room the soundtrack is played in.
 *
 * The patches are already the real thing - SC-55 samples lifted out of the
 * shipped soundfont (SoundFont.ts) - so what was left between them and sounding
 * like a module was the module's own output stage. A Sound Canvas ran
 * everything through reverb and chorus and shipped with both turned up; the
 * patches on their own are dry mono one-shots, and dry mono one-shots are
 * exactly what "MIDI" means as a complaint.
 *
 * No files. The impulse response is generated: decaying noise is what a plate
 * reverb approximates anyway, and a 1.6s tail costs nothing to synthesise
 * against the 1.1MB of samples it is processing.
 */

/** Seconds of tail. Long enough to hear, short enough not to smear the beat. */
const REVERB_SECONDS = 1.6

/**
 * How sharply the tail decays. Higher is tighter; 3 gives a hall that has
 * mostly gone by the next bar at the soundtrack's tempo.
 */
const REVERB_DECAY = 3

/** Wet fraction. The SC-55's default reverb send sat around here. */
const REVERB_MIX = 0.28

/**
 * Chorus: two taps either side of ~20ms, swept slowly in opposite directions.
 * One tap reads as a flanger, two as the width a module had.
 */
const CHORUS_DELAY = 0.02
const CHORUS_SWEEP = 0.003
const CHORUS_RATE = 0.6
const CHORUS_MIX = 0.22

export interface MusicChain {
  /** Connect every voice here instead of straight to the output. */
  readonly input: GainNode
  /** Stops the oscillators the chorus runs on. */
  dispose(): void
}

/** Decaying stereo noise - a plate, near enough, and free. */
function impulseResponse(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * REVERB_SECONDS)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) {
      // The two channels get independent noise, which is what makes it wide.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, REVERB_DECAY)
    }
  }
  return buffer
}

/**
 * Builds dry + chorus + reverb in parallel onto `output`.
 *
 * Parallel rather than in series: a send, as a module has it. In series the
 * chorus would smear the reverb tail as well as the notes, which sounds
 * underwater rather than wide.
 */
export function buildMusicChain(context: AudioContext, output: AudioNode): MusicChain {
  const input = context.createGain()

  const dry = context.createGain()
  dry.gain.value = 1 - REVERB_MIX * 0.5
  input.connect(dry).connect(output)

  // --- chorus: a modulated delay per side, panned apart.
  const chorusOut = context.createGain()
  chorusOut.gain.value = CHORUS_MIX
  chorusOut.connect(output)

  const oscillators: OscillatorNode[] = []
  for (const side of [-1, 1]) {
    const delay = context.createDelay(1)
    delay.delayTime.value = CHORUS_DELAY

    const lfo = context.createOscillator()
    lfo.frequency.value = CHORUS_RATE
    // Opposite phase per side, faked by inverting the depth.
    const depth = context.createGain()
    depth.gain.value = CHORUS_SWEEP * side
    lfo.connect(depth).connect(delay.delayTime)
    lfo.start()
    oscillators.push(lfo)

    const pan = context.createStereoPanner()
    pan.pan.value = side * 0.6
    input.connect(delay).connect(pan).connect(chorusOut)
  }

  // --- reverb send.
  const send = context.createGain()
  send.gain.value = REVERB_MIX
  const convolver = context.createConvolver()
  convolver.buffer = impulseResponse(context)
  input.connect(send).connect(convolver).connect(output)

  return {
    input,
    dispose(): void {
      for (const lfo of oscillators) {
        try {
          lfo.stop()
        } catch {
          // Already stopped - stop() throws on a node that never started.
        }
      }
      input.disconnect()
    },
  }
}

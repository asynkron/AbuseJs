/**
 * Minimal SoundFont 2 reader, enough to play the game's MIDI with the shipped
 * Roland SC-55 patches instead of synthesised waveforms.
 *
 * SF2 is RIFF: a `sdta` list holding one big block of 16-bit PCM, and a `pdta`
 * list of parallel record arrays describing how to slice it —
 *
 *   phdr -> preset headers        pbag/pgen -> preset zones
 *   inst -> instrument headers    ibag/igen -> instrument zones
 *   shdr -> sample headers (offsets into the PCM, loop points, root key)
 *
 * A note is resolved preset -> preset zone -> instrument -> instrument zone ->
 * sample, with generators overriding as you descend. Only the generators that
 * matter for straightforward sample playback are kept; modulators, filters and
 * LFOs are ignored.
 */

/** SF2 generator operators we care about. */
const GEN = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  endAddrsCoarseOffset: 12,
  releaseVolEnv: 38,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  startloopAddrsCoarseOffset: 45,
  initialAttenuation: 48,
  endloopAddrsCoarseOffset: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  overridingRootKey: 58,
} as const

interface Chunk {
  id: string
  start: number
  size: number
}

function readChunks(buf: Buffer, start: number, end: number): Chunk[] {
  const out: Chunk[] = []
  let p = start
  while (p + 8 <= end) {
    const id = buf.toString('latin1', p, p + 4)
    const size = buf.readUInt32LE(p + 4)
    out.push({ id, start: p + 8, size })
    p += 8 + size + (size & 1)
  }
  return out
}

export interface Sf2Zone {
  keyLo: number
  keyHi: number
  velLo: number
  velHi: number
  /** Index into the emitted sample table. */
  sample: number
  rootKey: number
  /** Semitone + cent offsets from the sample's own root. */
  coarseTune: number
  fineTune: number
  /** Attenuation in centibels; 0 is full volume. */
  attenuation: number
  /** 0 = one shot, 1 = loop, 3 = loop until release. */
  loopMode: number
  loopStart: number
  loopEnd: number
  /** Release time in seconds, from the volume envelope. */
  release: number
}

export interface Sf2Sample {
  name: string
  /** Byte offset into the emitted PCM blob. */
  offset: number
  /** Sample frames (not bytes). */
  length: number
  sampleRate: number
}

export interface Sf2Result {
  /** Key is `bank:program`, e.g. `0:24` or `128:0` for percussion. */
  presets: Record<string, Sf2Zone[]>
  samples: Sf2Sample[]
  pcm: Buffer
}

type GeneratorSet = Map<number, number>

function applyGenerators(target: GeneratorSet, source: GeneratorSet): GeneratorSet {
  const merged = new Map(target)
  for (const [op, value] of source) merged.set(op, value)
  return merged
}

/** Timecents to seconds, the SF2 unit for envelope stages. */
function timecentsToSeconds(value: number): number {
  return Math.pow(2, value / 1200)
}

export function readSoundFont(buf: Buffer, wanted: Set<string>): Sf2Result | null {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'sfbk') return null

  const top = readChunks(buf, 12, buf.length)
  let smpl: Chunk | undefined
  const pdta = new Map<string, Chunk>()

  for (const chunk of top) {
    if (chunk.id !== 'LIST') continue
    const type = buf.toString('latin1', chunk.start, chunk.start + 4)
    const inner = readChunks(buf, chunk.start + 4, chunk.start + chunk.size)
    if (type === 'sdta') smpl = inner.find((c) => c.id === 'smpl')
    else if (type === 'pdta') for (const c of inner) pdta.set(c.id, c)
  }
  if (!smpl) return null

  const need = (id: string) => {
    const chunk = pdta.get(id)
    if (!chunk) throw new Error(`soundfont missing ${id}`)
    return chunk
  }

  // --- record arrays ---------------------------------------------------
  const phdr = need('phdr')
  const presetCount = Math.floor(phdr.size / 38) - 1 // last record is a terminator

  const readBags = (chunk: Chunk) => {
    const bags: { genIndex: number }[] = []
    for (let i = 0; i + 4 <= chunk.size; i += 4) {
      bags.push({ genIndex: buf.readUInt16LE(chunk.start + i) })
    }
    return bags
  }

  const readGens = (chunk: Chunk) => {
    const gens: { op: number; value: number }[] = []
    for (let i = 0; i + 4 <= chunk.size; i += 4) {
      gens.push({ op: buf.readUInt16LE(chunk.start + i), value: buf.readInt16LE(chunk.start + i + 2) })
    }
    return gens
  }

  const pbag = readBags(need('pbag'))
  const pgen = readGens(need('pgen'))
  const ibag = readBags(need('ibag'))
  const igen = readGens(need('igen'))

  const inst = need('inst')
  const instCount = Math.floor(inst.size / 22) - 1

  const shdr = need('shdr')
  const sampleCount = Math.floor(shdr.size / 46) - 1

  /** Collects a zone's generators from a bag range. */
  const zoneGenerators = (
    bags: { genIndex: number }[],
    gens: { op: number; value: number }[],
    bagStart: number,
    bagEnd: number,
  ): GeneratorSet[] => {
    const zones: GeneratorSet[] = []
    for (let b = bagStart; b < bagEnd && b < bags.length; b++) {
      const from = bags[b].genIndex
      const to = b + 1 < bags.length ? bags[b + 1].genIndex : gens.length
      const set: GeneratorSet = new Map()
      for (let g = from; g < to && g < gens.length; g++) set.set(gens[g].op, gens[g].value)
      zones.push(set)
    }
    return zones
  }

  // --- resolve wanted presets ------------------------------------------
  const usedSamples = new Map<number, number>() // shdr index -> emitted index
  const samples: Sf2Sample[] = []
  const pcmParts: Buffer[] = []
  let pcmBytes = 0

  const emitSample = (index: number): number | null => {
    const existing = usedSamples.get(index)
    if (existing !== undefined) return existing
    if (index < 0 || index >= sampleCount) return null

    const base = shdr.start + index * 46
    const name = buf.toString('latin1', base, base + 20).replace(/\0.*$/, '')
    const start = buf.readUInt32LE(base + 20)
    const end = buf.readUInt32LE(base + 24)
    const sampleRate = buf.readUInt32LE(base + 36)
    const type = buf.readUInt16LE(base + 44)
    // Skip ROM samples; there is no data for them in the file.
    if (type & 0x8000) return null
    if (end <= start) return null

    const byteStart = smpl.start + start * 2
    const byteEnd = smpl.start + end * 2
    if (byteEnd > smpl.start + smpl.size) return null

    const emitted = samples.length
    samples.push({ name, offset: pcmBytes, length: end - start, sampleRate: sampleRate || 44100 })
    const slice = buf.subarray(byteStart, byteEnd)
    pcmParts.push(slice)
    pcmBytes += slice.length
    usedSamples.set(index, emitted)
    return emitted
  }

  const presets: Record<string, Sf2Zone[]> = {}

  for (let p = 0; p < presetCount; p++) {
    const base = phdr.start + p * 38
    const program = buf.readUInt16LE(base + 20)
    const bank = buf.readUInt16LE(base + 22)
    const key = `${bank}:${program}`
    if (!wanted.has(key) || presets[key]) continue

    const bagStart = buf.readUInt16LE(base + 24)
    const bagEnd = buf.readUInt16LE(phdr.start + (p + 1) * 38 + 24)
    const presetZones = zoneGenerators(pbag, pgen, bagStart, bagEnd)

    const zones: Sf2Zone[] = []
    // A leading zone with no instrument is the preset's global zone.
    let presetGlobal: GeneratorSet = new Map()

    for (const presetZone of presetZones) {
      const instrumentIndex = presetZone.get(GEN.instrument)
      if (instrumentIndex === undefined) {
        presetGlobal = presetZone
        continue
      }
      if (instrumentIndex < 0 || instrumentIndex >= instCount) continue

      const merged = applyGenerators(presetGlobal, presetZone)
      const instBase = inst.start + instrumentIndex * 22
      const iBagStart = buf.readUInt16LE(instBase + 20)
      const iBagEnd = buf.readUInt16LE(inst.start + (instrumentIndex + 1) * 22 + 20)
      const instrumentZones = zoneGenerators(ibag, igen, iBagStart, iBagEnd)

      let instrumentGlobal: GeneratorSet = new Map()
      for (const instrumentZone of instrumentZones) {
        const sampleIndex = instrumentZone.get(GEN.sampleID)
        if (sampleIndex === undefined) {
          instrumentGlobal = instrumentZone
          continue
        }

        const g = applyGenerators(applyGenerators(merged, instrumentGlobal), instrumentZone)
        const emitted = emitSample(sampleIndex)
        if (emitted === null) continue

        const shdrBase = shdr.start + sampleIndex * 46
        const sampleStart = buf.readUInt32LE(shdrBase + 20)
        const rawLoopStart = buf.readUInt32LE(shdrBase + 28)
        const rawLoopEnd = buf.readUInt32LE(shdrBase + 32)
        const originalKey = buf.readUInt8(shdrBase + 40)
        const correction = buf.readInt8(shdrBase + 41)

        const keyRange = g.get(GEN.keyRange)
        const velRange = g.get(GEN.velRange)
        const offset = (fine: number, coarse: number) =>
          (g.get(fine) ?? 0) + (g.get(coarse) ?? 0) * 32768

        const loopStart =
          rawLoopStart - sampleStart + offset(GEN.startloopAddrsOffset, GEN.startloopAddrsCoarseOffset)
        const loopEnd =
          rawLoopEnd - sampleStart + offset(GEN.endloopAddrsOffset, GEN.endloopAddrsCoarseOffset)

        const releaseRaw = g.get(GEN.releaseVolEnv)
        zones.push({
          keyLo: keyRange === undefined ? 0 : keyRange & 0xff,
          keyHi: keyRange === undefined ? 127 : (keyRange >> 8) & 0xff,
          velLo: velRange === undefined ? 0 : velRange & 0xff,
          velHi: velRange === undefined ? 127 : (velRange >> 8) & 0xff,
          sample: emitted,
          rootKey: g.get(GEN.overridingRootKey) ?? originalKey,
          coarseTune: g.get(GEN.coarseTune) ?? 0,
          fineTune: (g.get(GEN.fineTune) ?? 0) + correction,
          attenuation: g.get(GEN.initialAttenuation) ?? 0,
          loopMode: g.get(GEN.sampleModes) ?? 0,
          loopStart: Math.max(0, loopStart),
          loopEnd: Math.max(0, loopEnd),
          release: releaseRaw === undefined ? 0.2 : Math.min(4, timecentsToSeconds(releaseRaw)),
        })
      }
    }

    if (zones.length) presets[key] = zones
  }

  return { presets, samples, pcm: Buffer.concat(pcmParts) }
}

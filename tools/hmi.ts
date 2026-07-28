/**
 * Converts Abuse's HMI music files to standard MIDI.
 *
 * Ported from src/sdlport/hmi.cpp (Jochen Schleu, WTFPL). HMI differs from
 * MIDI in three ways that matter:
 *
 *   - a header of offsets rather than MThd/MTrk chunks
 *   - note-on events carry the note's duration instead of a matching note-off,
 *     so note-offs have to be queued and emitted at the right delta
 *   - an extra 0xFE event of variable length whose purpose is undocumented;
 *     it is skipped
 *
 * Like the original, the tempo and time division are fixed rather than read
 * from the file, and running status is expanded rather than preserved.
 */

const HMI_TRACK_DATA_OFFSET = 0x57
const HMI_TRACK_OFFSET_POS = 0xe8
const HMI_NEXT_CHUNK_POS = 0xf4
/** The engine keeps at most this many note-offs pending. */
const MAX_NOTE_OFF_EVENTS = 30

interface PendingNoteOff {
  time: number
  command: number
  note: number
}

/** Reader for HMI's little-endian variable-length delta times. */
class Reader {
  constructor(
    readonly buf: Buffer,
    public pos: number,
  ) {}

  u8(): number {
    return this.buf[this.pos++]
  }

  /** MIDI variable-length quantity. */
  varint(): number {
    let value = this.u8()
    if (value & 0x80) {
      value &= 0x7f
      let c: number
      do {
        c = this.u8()
        value = (value << 7) | (c & 0x7f)
      } while (c & 0x80)
    }
    return value
  }
}

function writeVarint(out: number[], value: number): void {
  const bytes = [value & 0x7f]
  let v = value
  while ((v >>>= 7)) bytes.push((v & 0x7f) | 0x80)
  for (let i = bytes.length - 1; i >= 0; i--) out.push(bytes[i])
}

function convertTrack(buf: Buffer, start: number, size: number): number[] {
  const reader = new Reader(buf, start + buf[start + HMI_TRACK_DATA_OFFSET])
  const events: number[] = []
  const pending: PendingNoteOff[] = []

  let command = 0
  let currentTime = 0
  let lastTime = 0
  let done = false

  const flushNoteOffs = (before: number) => {
    pending.sort((a, b) => a.time - b.time)
    while (pending.length && pending[0].time < before) {
      const event = pending.shift()!
      writeVarint(events, event.time - lastTime)
      lastTime = event.time
      events.push(event.command, event.note, 0x00)
    }
  }

  while (!done && reader.pos - start < size && reader.pos < buf.length) {
    currentTime += reader.varint()

    let value = reader.u8()
    if (value >= 0x80) {
      command = value
      value = reader.u8()
    }

    flushNoteOffs(currentTime)

    if (command !== 0xfe) {
      writeVarint(events, currentTime - lastTime)
      lastTime = currentTime
      events.push(command)
    }

    switch (command & 0xf0) {
      case 0xc0: // program change
      case 0xd0: // channel aftertouch
        events.push(value)
        break

      case 0x80: // note off
      case 0xa0: // aftertouch
      case 0xb0: // controller
      case 0xe0: // pitch bend
        events.push(value, reader.u8())
        break

      case 0x90: {
        // Note on, followed by the note's duration - this is the whole reason
        // note-offs have to be queued.
        events.push(value, reader.u8())
        const duration = reader.varint()
        if (pending.length < MAX_NOTE_OFF_EVENTS) {
          pending.push({ time: currentTime + duration, command, note: value })
        }
        break
      }

      case 0xf0:
        if (command === 0xfe) {
          // Undocumented HMI event; skip its payload.
          if (value === 0x10) {
            reader.pos += 2
            reader.pos += buf[reader.pos]
            reader.pos += 5
          } else if (value === 0x14) {
            reader.pos += 2
          } else if (value === 0x15) {
            reader.pos += 6
          }
        } else {
          events.push(value, reader.u8())
          done = true
        }
        break
    }
  }

  if (!done) events.push(0x00, 0xff, 0x2f, 0x00)

  const chunk = [0x4d, 0x54, 0x72, 0x6b] // "MTrk"
  const length = events.length
  chunk.push((length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
  return chunk.concat(events)
}

/** Returns a standard MIDI file, or null if the input is not usable HMI. */
export function hmiToMidi(buf: Buffer): Buffer | null {
  if (buf.length < HMI_NEXT_CHUNK_POS + 4) return null

  const trackOffsets = buf.readUInt32LE(HMI_TRACK_OFFSET_POS)
  const nextChunk = buf.readUInt32LE(HMI_NEXT_CHUNK_POS)
  if (nextChunk <= trackOffsets) return null

  const trackCount = Math.floor((nextChunk - trackOffsets) / 4)
  if (trackCount <= 0 || trackCount > 64) return null
  if (trackOffsets + trackCount * 4 > buf.length) return null

  const out: number[] = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length
    0x00, 0x01, // format 1
    0x00, trackCount + 1, // track count, plus the tempo track
    0x00, 0xc0, // 192 ticks per quarter note
    // Tempo track, fixed exactly as the engine writes it.
    0x4d, 0x54, 0x72, 0x6b,
    0x00, 0x00, 0x00, 0x0b,
    0x00, 0xff, 0x51, 0x03,
    0x18, 0x7f, 0xff,
    0x00, 0xff, 0x2f, 0x00,
  ]

  for (let i = 0; i < trackCount; i++) {
    const position = buf.readUInt32LE(trackOffsets + i * 4)
    if (position >= buf.length) continue
    const size =
      i === trackCount - 1
        ? buf.length - position
        : buf.readUInt32LE(trackOffsets + (i + 1) * 4) - position
    if (size <= 0) continue
    out.push(...convertTrack(buf, position, size))
  }

  return Buffer.from(out)
}

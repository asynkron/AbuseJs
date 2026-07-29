import type { Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../../assets/loader'

/**
 * The one-shot sprite characters.
 *
 * `def_explo` (lisp/explo.lsp) is a factory that stamps out eleven identical
 * characters: same ai function, same draw function, a `stopped` sequence and
 * nothing else. Because it builds them with `eval`, tools/lisp.ts never sees a
 * literal `def_char` for any of them and none appear in chars.json - so the
 * catalogue is repeated here and the frames are addressed directly. All of
 * them exist in the atlas.
 *
 * EG_EXPLO is a real `def_char` (lisp/ant.lsp) rather than a `def_explo`, but
 * it behaves the same way: `animate_ai` is a bare `(next_picture)`. The last
 * two come from the fRaBs Twist addon, which is not in the converter's script
 * list either; their frames are in the atlas under their own names.
 */
export type PuffKind =
  | 'EXPLODE1'
  | 'EXPLODE2'
  | 'EXPLODE3'
  | 'EXPLODE4'
  | 'EXPLODE5'
  | 'EXPLODE6'
  | 'EXPLODE7'
  | 'EXPLODE8'
  | 'CLOUD'
  | 'SMALL_DARK_CLOUD'
  | 'SMALL_LIGHT_CLOUD'
  | 'EG_EXPLO'
  | 'EG_EXPLO_WALL'
  | 'EXPDRAY'
  | 'EXPDRL'

interface PuffArt {
  /** The .spe the frames were packed from. */
  file: string
  /** Sequence base name; frames are `<base>0001.pcx` upward (lisp/userfuns.lsp seq). */
  base: string
  /** How many frames the character declares, which is not always how many the art holds. */
  frames: number
  /**
   * False for the one character that does not draw through `middle_draw`.
   * EG_EXPLO declares no draw_fun at all (lisp/ant.lsp), so it gets the
   * engine's ordinary feet anchor like any other object.
   */
  anchored?: boolean
}

/**
 * File, sequence and length for each, straight off the `def_explo` calls at
 * lisp/explo.lsp:80-92.
 *
 * EXPLODE4 and EXPLODE7 are defined by the original and spawned by nothing in
 * assets/original; they are here because leaving two holes in a table copied
 * from one contiguous block invites someone to "fix" it later.
 */
const PUFF_ART: Record<PuffKind, PuffArt> = {
  EXPLODE1: { file: 'art/exp1.spe', base: 'fire', frames: 7 },
  EXPLODE2: { file: 'art/blowups.spe', base: 'b1', frames: 7 },
  EXPLODE3: { file: 'art/blowups.spe', base: 'b2', frames: 7 },
  EXPLODE4: { file: 'art/blowups.spe', base: 'b3', frames: 7 },
  // b4 has nine frames in the art; the character declares five.
  EXPLODE5: { file: 'art/blowups.spe', base: 'b4', frames: 5 },
  EXPLODE6: { file: 'art/exp1.spe', base: 'small_fire', frames: 7 },
  EXPLODE7: { file: 'art/exp1.spe', base: 'small_wite', frames: 8 },
  EXPLODE8: { file: 'art/exp1.spe', base: 'wite', frames: 8 },
  CLOUD: { file: 'art/cloud.spe', base: 'cloud', frames: 5 },
  SMALL_DARK_CLOUD: { file: 'art/cloud.spe', base: 'smo2', frames: 5 },
  SMALL_LIGHT_CLOUD: { file: 'art/cloud.spe', base: 'smo1', frames: 5 },
  // (states "art/missle.spe" (stopped (seq "bifl" 1 4)) (blocking (seq "bilw" 1 4)))
  // - lisp/ant.lsp. The second state is the wall splash, picked by
  // `eg_explo_ufun` from bmove's block flags, so it is a kind of its own here.
  EG_EXPLO: { file: 'art/missle.spe', base: 'bifl', frames: 4, anchored: true },
  EG_EXPLO_WALL: { file: 'art/missle.spe', base: 'bilw', frames: 4, anchored: true },
  // addon/twist/lisp/weapons.lsp: the death ray's impact and expiry bursts.
  EXPDRAY: { file: 'addon/twist/art/dray.spe', base: 'dexp', frames: 6 },
  EXPDRL: { file: 'addon/twist/art/dray.spe', base: 'drl', frames: 6 },
}

/** True when this character draws at its feet rather than through `middle_draw`. */
export function puffIsAnchored(kind: PuffKind): boolean {
  return PUFF_ART[kind].anchored === true
}

/** `(concatenate 'string name (digstr n 4) ".pcx")` - lisp/userfuns.lsp forward-seq. */
export function sequenceFrameName(base: string, index: number): string {
  return `${base}${String(index).padStart(4, '0')}.pcx`
}

/** Resolves a character's `stopped` sequence. Missing frames are skipped, not faked. */
export function puffFrames(assets: GameAssets, kind: PuffKind): Frame[] {
  const art = PUFF_ART[kind]
  const frames: Frame[] = []
  for (let i = 1; i <= art.frames; i++) {
    const frame = assets.frame(art.file, sequenceFrameName(art.base, i))
    if (frame) frames.push(frame)
  }
  return frames
}

/**
 * `middle_draw` (lisp/common.lsp): the sprite's vertical centre goes on `y`,
 * while horizontally the ordinary `x - xcfg` anchor still applies. Ten of the
 * eleven explosion characters draw this way, so a fireball asked for at head
 * height is centred there rather than standing on it.
 *
 * Not centred on both axes: several of these frames have an xcfg that is not
 * half their width, and centring horizontally shifts them off the point the
 * script picked.
 */
export function placeMiddle(sprite: Sprite, frame: Frame, x: number, y: number): void {
  sprite.texture = frame.texture
  sprite.x = Math.round(x - frame.xcfg)
  sprite.y = Math.round(y - frame.height / 2 + 1)
}

/**
 * The ordinary draw: anchor column at `x`, feet on `y`, matching Entity.ts and
 * the engine's own `game_object::drawer`. The gibs use this - `head_ai` draws
 * through `ant_draw`, which is a plain `(draw)`.
 */
export function placeAnchored(sprite: Sprite, frame: Frame, x: number, y: number): void {
  sprite.texture = frame.texture
  sprite.x = Math.round(x - frame.xcfg)
  sprite.y = Math.round(y - frame.height + 1)
}

/**
 * Who bleeds, and what colour.
 *
 * There is no blood anywhere in Abuse - DeathEffects.ts says so at the top of
 * the file, and it is still true of the original. A killed ant comes apart
 * into five tumbling sprites and leaves nothing behind. All of this is an
 * addition; none of it has a lisp citation, because there is no lisp.
 *
 * The classification the original does have is implicit rather than declared:
 * `World.deathEffect` sends ants to `create_dead_parts` and machines to a
 * fireball, and nothing anywhere carries an "is alive" flag. This table makes
 * that split explicit without touching the switch that already encodes it,
 * and it keys on the lisp character name the same way `GIB_ART` and
 * `gibFlavourFor` already do, so the subsystem stays clear of the world.
 *
 * Note which way round the lookup goes. `gibFlavourFor` reads the *weapon*
 * that landed the kill, which is why it needs a `BlastSource` and why it
 * returns `normal` whenever the caller has lost track of one. This reads the
 * *victim*, which is always known, so a creature bleeds the same colour
 * however it died.
 */

export interface BloodProfile {
  /** Fresh, settled, dried. Sprite tints, applied over pure white art. */
  readonly ramp: readonly [number, number, number]
  /** Scales every droplet and mark count. 1 is one ant. */
  readonly amount: number
}

/**
 * Invented, like everything else here. Three tints rather than one because a
 * hundred identical squares read as static; a short ramp gives the spray a
 * palette and gives the marks somewhere to go as they dry.
 *
 * Red for everything with a pulse, aliens included. It cannot collide with the
 * original's own red - `tint_palette`, the full-screen damage ramp - because
 * that is one of the things this port has not implemented.
 *
 * Deliberately dark for a fresh colour. A brighter red reads as pink or violet
 * on screen rather than as blood, because these are one- and two-pixel marks
 * and the CRT pass puts a bloom and a channel offset over everything: on a
 * small bright element the fringe *is* the element. Keeping the whole ramp
 * below half brightness leaves the bloom nothing to work with.
 */
const BLOOD_RED: BloodProfile = { ramp: [0x9e0f16, 0x5e0a10, 0x2a0508], amount: 1 }

/** The ants proper: the only things in the game that already gib. */
const ANT: BloodProfile = BLOOD_RED

/** A hole in the wall full of ant. Less of it, but the same stuff. */
const ANT_CRACK_BLOOD: BloodProfile = { ramp: BLOOD_RED.ramp, amount: 0.4 }

/** The last thing in the game, and the size of a room. */
const BOSS: BloodProfile = { ramp: BLOOD_RED.ramp, amount: 2 }

/**
 * The flyers. A judgement call: they explode into three fireballs like a
 * machine, but `flyer_damage` makes them *flinch* (lisp/flyer.lsp), which is a
 * creature's reaction and not a turret's. Slightly less of it, so the spray
 * sits inside the fireballs rather than fighting them.
 */
const FLYER_BLOOD: BloodProfile = { ramp: BLOOD_RED.ramp, amount: 0.8 }

/**
 * The cop. Unreachable today - `GibSet` has a `cop` entry and nothing calls
 * it - and kept here so the table is complete rather than surprising when
 * somebody wires it up.
 */
const COP: BloodProfile = BLOOD_RED

/**
 * WHO is deliberately absent. It shares `flyer_ai` with the two flyers, but it
 * draws from art/rob2.spe - the same file as WALK_ROB - and it is defined
 * among the robots in lisp/jugger.lsp. Treated as a machine. One line to flip
 * if it reads wrong in play.
 */
const BLEEDS: Record<string, BloodProfile> = {
  ANT_ROOF: ANT,
  HIDDEN_ANT: ANT,
  ANT_CRACK: ANT_CRACK_BLOOD,
  BOSS_ANT: BOSS,
  FLYER: FLYER_BLOOD,
  GREEN_FLYER: FLYER_BLOOD,
  DARNEL: COP,
}

/** What this character bleeds, or null for machines, rock and scenery. */
export function bloodFor(character: string): BloodProfile | null {
  return BLEEDS[character] ?? null
}

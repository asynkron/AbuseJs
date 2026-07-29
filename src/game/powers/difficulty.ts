/**
 * The difficulty global, which scales healing one way and damage the other.
 *
 * `lisp/startup.lsp:20` sets it: `(if (not (load "hardness.lsp")) (setf
 * difficulty 'hard))`, so a fresh install plays on hard - full damage, half
 * healing. There is no difficulty setting in this port yet, which means
 * everything already behaves as hard by accident; naming it makes that a
 * decision rather than an omission.
 */

export type Difficulty = 'easy' | 'medium' | 'hard' | 'extreme'

/** What a fresh install gets - lisp/startup.lsp:20. */
export const DEFAULT_DIFFICULTY: Difficulty = 'hard'

/**
 * The setting in force, which the title screen picks.
 *
 * A module-level value rather than a parameter threaded through every call
 * site: the original reads a global `difficulty` from wherever it happens to
 * be (ant.lsp, people.lsp, weapons), and there is exactly one game running at
 * a time. Every function below still takes an explicit override, so nothing is
 * forced to consult it.
 */
let current: Difficulty = DEFAULT_DIFFICULTY

export function setDifficulty(value: Difficulty): void {
  current = value
}

export function getDifficulty(): Difficulty {
  return current
}

/** Integer division, which is all the original's `/` ever does. */
function scale(amount: number, numerator: number, denominator: number): number {
  return Math.trunc((amount * numerator) / denominator)
}

/**
 * Scales an incoming hit. From `bottom_damage` in lisp/people.lsp, which is
 * the first thing it does to `amount`, before the flinch, the palette ramp or
 * the engine's own damage call.
 */
export function scaleDamage(amount: number, difficulty: Difficulty = current): number {
  switch (difficulty) {
    case 'easy':
      return scale(amount, 1, 2)
    case 'medium':
      return scale(amount, 3, 4)
    case 'hard':
      return amount
    case 'extreme':
      return amount * 3
  }
}

/**
 * Scales a heal. From `give_player_health` in lisp/people.lsp. Note it runs
 * the opposite way round to damage: the harder the game, the less a heart is
 * worth, so on the default hard a 20-point heart gives 10.
 */
export function scaleHeal(amount: number, difficulty: Difficulty = current): number {
  switch (difficulty) {
    case 'easy':
      return amount
    case 'medium':
      return scale(amount, 3, 4)
    case 'hard':
      return scale(amount, 1, 2)
    case 'extreme':
      return scale(amount, 1, 5)
  }
}

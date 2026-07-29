/**
 * `(random n)` from the original: a whole number in 0..n-1.
 *
 * The scripts wrap cosmetic randomness in a `rand_on` save/restore so that
 * smoke puffs do not advance the shared random table the multiplayer replay
 * depends on (lisp/weapons.lsp rocket_ai, lisp/ant.lsp create_dead_parts).
 * There is no shared table here and no replay, so there is nothing to protect.
 */
export function random(n: number): number {
  return Math.floor(Math.random() * n)
}

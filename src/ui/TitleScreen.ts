import { DEFAULT_DIFFICULTY, type Difficulty } from '../game/powers/difficulty'

/**
 * The title screen.
 *
 * The wording is the original's own, out of `lisp/english.lsp`: "Start New
 * Game", "Load Saved Game", and the four difficulties it calls Wimp, Easy,
 * Normal and Extreme - which map to the lisp's `easy`, `medium`, `hard` and
 * `extreme`. Abuse ships set to `hard`, so its "Normal" really is the default
 * and the two below it are concessions.
 *
 * It also earns its keep beyond decoration: browsers will not start an
 * AudioContext without a gesture, so the game needed a first click anyway.
 * Better a menu than a silent game that starts making noise when you happen
 * to touch the keyboard.
 */

export interface TitleChoice {
  difficulty: Difficulty
  /** Whether to resume the save rather than start at the first level. */
  resume: boolean
}

const DIFFICULTY_KEY = 'abusejs.difficulty'

function storedDifficulty(): Difficulty {
  try {
    const value = localStorage.getItem(DIFFICULTY_KEY)
    if (value === 'easy' || value === 'medium' || value === 'hard' || value === 'extreme') {
      return value
    }
  } catch {
    // Private browsing. The default is a fine answer.
  }
  return DEFAULT_DIFFICULTY
}

/**
 * Shows the screen and resolves once a game is chosen. Resolves immediately
 * without showing anything when `skip` is set, which is how a deep link like
 * `#levels/level14` still goes straight into the level.
 */
export function showTitleScreen(options: { canResume: boolean; skip: boolean }): Promise<TitleChoice> {
  const root = document.getElementById('title')
  const newGame = document.getElementById('start-new') as HTMLButtonElement | null
  const loadGame = document.getElementById('start-load') as HTMLButtonElement | null

  let difficulty = storedDifficulty()

  if (options.skip || !root || !newGame || !loadGame) {
    // Take it out of the document rather than just leaving it be. It is
    // `position: fixed` at `z-index: 20`, and returning here means none of the
    // buttons below ever get a click handler - so a screen left standing sits
    // over the running game looking like a menu that ignores you. Not relying
    // on the `hidden` attribute either: an id selector in the stylesheet
    // outranks it, which is what made this reachable in the first place.
    root?.remove()

    // Skipping means a deep link, which is an explicit request for *that*
    // level - resuming would quietly send you somewhere else instead. Only a
    // real press of Load Saved Game resumes.
    return Promise.resolve({ difficulty, resume: false })
  }

  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-difficulty]')]
  const paint = () => {
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.difficulty === difficulty))
    }
  }
  paint()

  loadGame.disabled = !options.canResume
  root.hidden = false
  newGame.focus()

  return new Promise<TitleChoice>((resolve) => {
    const finish = (resume: boolean) => {
      try {
        localStorage.setItem(DIFFICULTY_KEY, difficulty)
      } catch {
        // Same as above - not worth failing a game start over.
      }
      document.removeEventListener('keydown', onKey)
      root.classList.add('hidden')
      // Left in the DOM until the fade finishes, then taken out entirely so it
      // cannot eat clicks meant for the game.
      setTimeout(() => root.remove(), 450)
      resolve({ difficulty, resume })
    }

    newGame.addEventListener('click', () => finish(false))
    loadGame.addEventListener('click', () => finish(true))
    for (const button of buttons) {
      button.addEventListener('click', () => {
        difficulty = button.dataset.difficulty as Difficulty
        paint()
      })
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        const order: Difficulty[] = ['easy', 'medium', 'hard', 'extreme']
        const step = event.code === 'ArrowRight' ? 1 : -1
        difficulty = order[Math.min(order.length - 1, Math.max(0, order.indexOf(difficulty) + step))]
        paint()
        event.preventDefault()
        return
      }
      // Enter and space start; so does any other key, since a title screen
      // that ignores you is worse than one that starts a shade too eagerly.
      if (event.code === 'Escape') return
      finish(false)
    }
    document.addEventListener('keydown', onKey)
  })
}

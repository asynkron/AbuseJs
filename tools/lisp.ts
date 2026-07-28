/**
 * A deliberately tiny reader for the Abuse Lisp data files.
 *
 * We do not run these scripts - we only mine two things out of them:
 *   - the `(load_tiles ...)` call in lisp/startup.lsp, which lists every
 *     tile .spe file the game loads
 *   - every `(def_char NAME ... (states "file.spe" (state frames...)))` block,
 *     which is where all animation frame ordering lives
 *
 * Inside a `states` block only four shapes occur across the whole dataset,
 * defined in lisp/userfuns.lsp:
 *   "name"              a single frame
 *   (seq "4wlk" 1 10)   "4wlk0001.pcx" .. "4wlk0010.pcx", descending allowed
 *   (rep "x.pcx" 4)     that frame four times
 *   (app a b ...)       concatenation
 */

export type Sexp = string | number | LispSymbol | Sexp[]

export class LispSymbol {
  constructor(readonly name: string) {}
  toString() {
    return this.name
  }
}

export function isSymbol(x: Sexp, name?: string): x is LispSymbol {
  return x instanceof LispSymbol && (name === undefined || x.name === name)
}

/** Parses a whole file into a list of top-level forms. */
export function readForms(source: string): Sexp[] {
  const forms: Sexp[] = []
  let p = 0

  function skipTrivia() {
    for (;;) {
      while (p < source.length && /\s/.test(source[p])) p++
      if (source[p] === ';') {
        while (p < source.length && source[p] !== '\n') p++
        continue
      }
      return
    }
  }

  function readAtom(): Sexp {
    const start = p
    while (p < source.length && !/[\s()'"`;]/.test(source[p])) p++
    const text = source.slice(start, p)
    if (text.length === 0) {
      // A stray delimiter we do not model (e.g. ` or #). Consume and skip it.
      p++
      return new LispSymbol('')
    }
    if (/^[-+]?\d+$/.test(text)) return parseInt(text, 10)
    if (/^[-+]?\d*\.\d+$/.test(text)) return parseFloat(text)
    return new LispSymbol(text)
  }

  function readString(): string {
    p++ // opening quote
    let out = ''
    while (p < source.length && source[p] !== '"') {
      if (source[p] === '\\' && p + 1 < source.length) {
        p++
        out += source[p] === 'n' ? '\n' : source[p]
      } else {
        out += source[p]
      }
      p++
    }
    p++ // closing quote
    return out
  }

  function readForm(): Sexp {
    skipTrivia()
    const c = source[p]
    if (c === '(') {
      p++
      const list: Sexp[] = []
      for (;;) {
        skipTrivia()
        if (p >= source.length) break
        if (source[p] === ')') {
          p++
          break
        }
        list.push(readForm())
      }
      return list
    }
    if (c === ')') {
      // Unbalanced close - skip it rather than derailing the whole file.
      p++
      return new LispSymbol('')
    }
    if (c === '"') return readString()
    if (c === "'") {
      p++
      return readForm()
    }
    return readAtom()
  }

  for (;;) {
    skipTrivia()
    if (p >= source.length) break
    forms.push(readForm())
  }

  return forms
}

/** Depth-first walk over every list form in a parsed file. */
export function* walk(forms: Sexp[]): Generator<Sexp[]> {
  const stack: Sexp[] = [...forms]
  while (stack.length) {
    const node = stack.pop()!
    if (Array.isArray(node)) {
      yield node
      for (const child of node) stack.push(child)
    }
  }
}

/* ------------------------------------------------------------------ */
/* frame sequences                                                     */
/* ------------------------------------------------------------------ */

function digstr(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** Expands one state's value into the ordered list of .spe entry names. */
export function expandFrames(form: Sexp): string[] {
  if (typeof form === 'string') return [form]
  if (!Array.isArray(form) || form.length === 0) return []

  const head = form[0]
  if (!isSymbol(head)) {
    // A bare list of frame names.
    return form.flatMap(expandFrames)
  }

  switch (head.name) {
    case 'seq': {
      const name = form[1]
      const first = form[2]
      const last = form[3]
      if (typeof name !== 'string' || typeof first !== 'number' || typeof last !== 'number') {
        return []
      }
      const out: string[] = []
      const step = first <= last ? 1 : -1
      for (let i = first; step > 0 ? i <= last : i >= last; i += step) {
        out.push(`${name}${digstr(i, 4)}.pcx`)
      }
      return out
    }
    case 'rep': {
      const name = form[1]
      const count = form[2]
      if (typeof name !== 'string' || typeof count !== 'number') return []
      return new Array(Math.max(0, count)).fill(name)
    }
    case 'app':
      return form.slice(1).flatMap(expandFrames)
    default:
      return []
  }
}

/* ------------------------------------------------------------------ */
/* extraction                                                          */
/* ------------------------------------------------------------------ */

export interface CharacterDef {
  name: string
  /** The .spe file all of this character's frames live in. */
  file: string
  states: Record<string, string[]>
  /** Bounding box half-extents from `(range ...)`, when present. */
  range?: [number, number]
  /** Name from `(funs (draw_fun ...))`, used to spot editor-only markers. */
  drawFun?: string
  /** `(abilities (start_hp 100) (run_top_speed 9) ...)` as a plain record. */
  abilities?: Record<string, number>
}

/**
 * Names of draw functions that only ever draw inside the level editor.
 *
 * Objects like START, MARKER, the logic gates and AMBIENT_SOUND all carry art
 * so they can be placed in the editor, but are invisible while playing. The
 * built-in `dev_draw` marks most of them; the sensors use a hand-written
 * function whose whole body is one unguarded `(if (edit_mode) ...)`.
 *
 * The narrow "single if, no else" test matters. Several functions mention
 * `edit_mode` and still draw in game - `pred_draw` is
 * `(if (edit_mode) (ant_draw) (draw_predator))`, and `al_char_draw` calls
 * `(draw)` before its edit-mode extras - so a looser test would make real
 * monsters invisible.
 */
export function extractEditorOnlyDrawFuns(forms: Sexp[]): string[] {
  const out: string[] = []

  for (const form of walk(forms)) {
    if (!isSymbol(form[0], 'defun')) continue
    const name = form[1]
    if (!isSymbol(name) || !name.name.includes('draw')) continue

    const body = form.slice(3)
    if (body.length !== 1) continue

    const only = body[0]
    if (!Array.isArray(only) || !isSymbol(only[0], 'if')) continue

    const condition = only[1]
    if (!Array.isArray(condition) || !isSymbol(condition[0], 'edit_mode')) continue

    // An else branch means it draws something when playing - unless that
    // branch is literally `nil`, which is how sensor_draw spells "draw
    // nothing".
    const alternative = only[3]
    if (only.length > 3 && !isSymbol(alternative, 'nil')) continue

    out.push(name.name)
  }

  return out
}

/** Pulls every `def_char` with a usable `states` block out of parsed forms. */
export function extractCharacters(forms: Sexp[]): CharacterDef[] {
  const out: CharacterDef[] = []

  for (const form of walk(forms)) {
    if (!isSymbol(form[0], 'def_char')) continue
    const nameNode = form[1]
    if (!isSymbol(nameNode)) continue

    let statesForm: Sexp[] | undefined
    let range: [number, number] | undefined
    let drawFun: string | undefined
    let abilities: Record<string, number> | undefined

    for (const clause of form.slice(2)) {
      if (!Array.isArray(clause)) continue
      if (isSymbol(clause[0], 'states')) statesForm = clause
      else if (isSymbol(clause[0], 'range') && typeof clause[1] === 'number' && typeof clause[2] === 'number') {
        range = [clause[1], clause[2]]
      } else if (isSymbol(clause[0], 'abilities')) {
        abilities = {}
        for (const ability of clause.slice(1)) {
          if (Array.isArray(ability) && isSymbol(ability[0]) && typeof ability[1] === 'number') {
            abilities[ability[0].name] = ability[1]
          }
        }
      } else if (isSymbol(clause[0], 'funs')) {
        for (const fn of clause.slice(1)) {
          if (Array.isArray(fn) && isSymbol(fn[0], 'draw_fun') && isSymbol(fn[1])) {
            drawFun = fn[1].name.replace(/^,/, '')
          }
        }
      }
    }

    if (!statesForm || typeof statesForm[1] !== 'string') continue

    const states: Record<string, string[]> = {}
    for (const stateClause of statesForm.slice(2)) {
      if (!Array.isArray(stateClause)) continue
      const stateName = stateClause[0]
      if (!isSymbol(stateName)) continue
      const frames = stateClause.slice(1).flatMap(expandFrames)
      if (frames.length) states[stateName.name] = frames
    }

    if (Object.keys(states).length === 0) continue
    out.push({ name: nameNode.name, file: statesForm[1], states, range, drawFun, abilities })
  }

  return out
}

/* ------------------------------------------------------------------ */
/* template expansion                                                  */
/* ------------------------------------------------------------------ */

/**
 * Some characters are not written out literally. people.lsp defines helpers
 * like
 *
 *   (defun make_top_char (symbol base ufun dfun)
 *     (eval (list 'def_char symbol ... `(states "art/coptop.spe"
 *                                               (stopped (seq ,base 1 24))))))
 *   (make_top_char 'MGUN_TOP "4gma" 'laser_ufun 'top_draw)
 *
 * and the cop's aiming torso - the whole upper half of the player - only
 * exists through one of those calls. We expand any `defun` whose body wraps a
 * single `def_char` by substituting its parameters into the template, which
 * covers these without needing a real evaluator.
 */
function findDefCharTemplate(body: Sexp[]): Sexp[] | undefined {
  for (const node of walk(body)) {
    // Written directly, usually inside a backquote.
    if (isSymbol(node[0], 'def_char')) return node
    // Or assembled with (list 'def_char name clause...).
    if (isSymbol(node[0], 'list') && isSymbol(node[1], 'def_char')) return node.slice(1)
  }
  return undefined
}

function substitute(form: Sexp, bindings: Map<string, Sexp>): Sexp {
  if (Array.isArray(form)) return form.map((f) => substitute(f, bindings))
  if (form instanceof LispSymbol) {
    // Templates reference parameters both as `,name` (inside a backquote) and
    // occasionally as a bare `name`.
    const key = form.name.startsWith(',') ? form.name.slice(1) : form.name
    const bound = bindings.get(key)
    if (bound !== undefined) return bound
  }
  return form
}

function isLiteralArg(arg: Sexp): boolean {
  return typeof arg === 'string' || typeof arg === 'number' || arg instanceof LispSymbol
}

export function expandCharacterTemplates(forms: Sexp[]): CharacterDef[] {
  const templates = new Map<string, { params: string[]; template: Sexp[] }>()

  for (const form of walk(forms)) {
    if (!isSymbol(form[0], 'defun')) continue
    const name = form[1]
    const params = form[2]
    if (!isSymbol(name) || !Array.isArray(params)) continue

    const template = findDefCharTemplate(form.slice(3))
    if (!template) continue

    templates.set(name.name, {
      // Note the arrow: passing `isSymbol` directly would feed the array index
      // into its optional `name` parameter and match nothing.
      params: params.filter((p): p is LispSymbol => isSymbol(p)).map((p) => p.name),
      template,
    })
  }

  if (templates.size === 0) return []

  const out: CharacterDef[] = []
  for (const form of walk(forms)) {
    const head = form[0]
    if (!isSymbol(head)) continue
    const template = templates.get(head.name)
    if (!template) continue

    const args = form.slice(1)
    if (args.length < template.params.length || !args.every(isLiteralArg)) continue

    const bindings = new Map<string, Sexp>()
    template.params.forEach((param, i) => bindings.set(param, args[i]))

    const expanded = substitute(template.template, bindings)
    out.push(...extractCharacters([expanded]))
  }

  return out
}

/* ------------------------------------------------------------------ */
/* palette tints                                                       */
/* ------------------------------------------------------------------ */

/**
 * Arrays of tint palettes, such as
 * `(setq ant_tints (make-array 13 :initial-contents (list (def_tint "art/tints/ant/green.spe") ...)))`.
 *
 * A character indexes one of these with its `aitype` to pick a colour variant
 * (lisp/ant.lsp, `(draw_tint (aref ant_tints (aitype)))`). Entries that are
 * not a `def_tint` - `normal_tint` and friends - come back as null, meaning
 * "draw untinted".
 */
export function extractTintArrays(forms: Sexp[]): Record<string, (string | null)[]> {
  const arrays: Record<string, (string | null)[]> = {}

  for (const form of walk(forms)) {
    if (!isSymbol(form[0], 'setq') || !isSymbol(form[1])) continue
    const value = form[2]
    if (!Array.isArray(value) || !isSymbol(value[0], 'make-array')) continue

    const list = value.find((v) => Array.isArray(v) && isSymbol(v[0], 'list')) as Sexp[] | undefined
    if (!list) continue

    const entries = list.slice(1).map((entry) => {
      if (Array.isArray(entry) && isSymbol(entry[0], 'def_tint') && typeof entry[1] === 'string') {
        return entry[1]
      }
      return null
    })

    if (entries.some((e) => e !== null)) arrays[form[1].name] = entries
  }

  return arrays
}

/* ------------------------------------------------------------------ */
/* localised text                                                      */
/* ------------------------------------------------------------------ */

/**
 * The tutorial lines shown by TRAIN_MSG objects, keyed by the message number
 * the object stores in `aitype`.
 *
 * They live in a language file as
 * `(defun get_train_msg (n) (select n (0 "...") (1 "...") ...))`, so
 * lisp/english.lsp, lisp/french.lsp and lisp/german.lsp are all readable the
 * same way.
 */
export function extractTrainMessages(forms: Sexp[]): Record<number, string> {
  const messages: Record<number, string> = {}

  for (const form of walk(forms)) {
    if (!isSymbol(form[0], 'defun') || !isSymbol(form[1], 'get_train_msg')) continue

    for (const node of walk(form.slice(3))) {
      if (!isSymbol(node[0], 'select')) continue
      for (const clause of node.slice(2)) {
        if (!Array.isArray(clause)) continue
        if (typeof clause[0] === 'number' && typeof clause[1] === 'string') {
          messages[clause[0]] = clause[1]
        }
      }
    }
  }

  return messages
}

/* ------------------------------------------------------------------ */
/* sound effects                                                       */
/* ------------------------------------------------------------------ */

export interface SoundTable {
  /** Symbol name -> wav path relative to the data root. */
  named: Record<string, string>
  /** Named arrays such as AMB_SOUNDS and A_SCREAMS, resolved to paths. */
  arrays: Record<string, (string | null)[]>
}

/**
 * Resolves lisp/sfx.lsp into a plain lookup table.
 *
 * Sounds are declared as `(def_sound 'SYM (sfxdir "file.wav"))`, aliased with
 * `setq`, and collected into arrays like AMB_SOUNDS whose entries mix fresh
 * anonymous `def_sound` calls with references to earlier symbols and
 * `(aref OTHER_ARRAY n)`. Forms are processed in file order, which is enough
 * for every reference in the shipped scripts to already be defined.
 */
export function extractSounds(forms: Sexp[]): SoundTable {
  const named: Record<string, string> = {}
  const arrays: Record<string, (string | null)[]> = {}

  /** `(sfxdir "x.wav")` -> "sfx/x.wav"; a bare string passes through. */
  const path = (node: Sexp): string | null => {
    if (typeof node === 'string') return node
    if (Array.isArray(node) && isSymbol(node[0], 'sfxdir') && typeof node[1] === 'string') {
      return `sfx/${node[1]}`
    }
    return null
  }

  const resolve = (node: Sexp): string | null => {
    if (node instanceof LispSymbol) return named[node.name] ?? null
    if (!Array.isArray(node)) return path(node)

    if (isSymbol(node[0], 'def_sound')) {
      // Either (def_sound 'SYM <path>) or the anonymous (def_sound <path>).
      if (node.length >= 3 && isSymbol(node[1])) {
        const file = path(node[2])
        if (file) named[node[1].name] = file
        return file
      }
      return path(node[1])
    }

    if (isSymbol(node[0], 'aref') && isSymbol(node[1]) && typeof node[2] === 'number') {
      return arrays[node[1].name]?.[node[2]] ?? null
    }

    return null
  }

  // Strictly in file order: a reference like SPACE_SND inside AMB_SOUNDS only
  // resolves because its def_sound came earlier in the file. `walk` pops from
  // a stack and would visit them out of order.
  const visit = (node: Sexp): void => {
    if (!Array.isArray(node)) return

    if (isSymbol(node[0], 'def_sound')) {
      resolve(node)
      return
    }

    if (isSymbol(node[0], 'setq') && isSymbol(node[1])) {
      const target = node[1].name
      const value = node[2]

      // (setq NAME (make-array N :initial-contents (list ...)))
      if (Array.isArray(value) && isSymbol(value[0], 'make-array')) {
        const list = value.find((v) => Array.isArray(v) && isSymbol(v[0], 'list')) as
          | Sexp[]
          | undefined
        if (list) arrays[target] = list.slice(1).map(resolve)
        return
      }

      // (setq ALIAS OTHER_SND)
      const aliased = resolve(value)
      if (aliased) named[target] = aliased
      return
    }

    for (const child of node) visit(child)
  }

  for (const form of forms) visit(form)

  return { named, arrays }
}

/** Returns the ordered `.spe` paths from the `(load_tiles ...)` call. */
export function extractTileFiles(forms: Sexp[]): string[] {
  for (const form of walk(forms)) {
    if (isSymbol(form[0], 'load_tiles')) {
      return form.slice(1).filter((x): x is string => typeof x === 'string')
    }
  }
  return []
}

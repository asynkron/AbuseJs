import { LispSymbol, isSymbol, type Sexp } from './lisp'

/**
 * Compiles Abuse's `.lsp` scripts to JavaScript.
 *
 * Not an interpreter and not a transliteration of `src/lisp.cpp`: every
 * `defun` comes out as a real function, so V8 can optimise it, devtools can
 * break on it, and we can read the result. See PORTING.md.
 *
 * Everything that is not a special form compiles to a call on the runtime
 * (`R.name(...)`). That keeps the compiler small and makes the engine surface
 * an explicit list rather than something buried in a dispatch table - a script
 * that reaches for a hook we have not written yet fails loudly, by name, at
 * the moment it runs.
 */

/** Lisp names are not JS identifiers; `-`, `?` and `!` all appear. */
function ident(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '_')
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

/** Infix operators, with the arity lisp actually uses them at. */
const INFIX: Record<string, string> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
}

const COMPARE: Record<string, string> = {
  '<': '<',
  '>': '>',
  '<=': '<=',
  '>=': '>=',
}

/**
 * Scope of the names visible where a form is being compiled.
 *
 * Needed because `setq` writes to whichever scope already binds the symbol:
 * a local if one is in scope, otherwise a global. That is decided here, at
 * compile time, so the output is a plain assignment either way.
 */
class Scope {
  private readonly names = new Set<string>()

  constructor(private readonly parent: Scope | null = null) {}

  declare(name: string): void {
    this.names.add(name)
  }

  has(name: string): boolean {
    return this.names.has(name) || (this.parent?.has(name) ?? false)
  }

  child(): Scope {
    return new Scope(this)
  }
}

export interface CompileResult {
  code: string
  /** Every free name the file touched, so the runtime can seed them. */
  globals: Set<string>
  /** Every runtime hook the file reached for, so callers can report gaps. */
  hooks: Set<string>
  functions: string[]
}

export function compile(forms: Sexp[], moduleName: string): CompileResult {
  const hooks = new Set<string>()
  const functions: string[] = []
  // Globals are recorded, never scoped: a name is local only if a `let`,
  // `defun` parameter or character `vars` binds it. Letting globals answer
  // `has()` made the second reference to a name emit a bare identifier that
  // resolves to nothing - `ff_draw` came out reading an undeclared `end_y`.
  const globals = new Set<string>()
  const top = new Scope()
  const out: string[] = []

  /** Compiles a form in expression position. */
  function expr(form: Sexp, scope: Scope): string {
    if (typeof form === 'number') return String(form)
    if (typeof form === 'string') return JSON.stringify(form)

    if (form instanceof LispSymbol) {
      const name = form.name
      // `nil` and `T` are lisp's booleans; everything else is a variable if
      // something binds it and a global constant if not.
      if (name === 'nil') return 'null'
      if (name === 'T') return 'true'
      if (scope.has(name)) return ident(name)
      globals.add(name)
      return `G.${ident(name)}`
    }

    if (!Array.isArray(form) || form.length === 0) return 'null'

    const head = form[0]
    if (head instanceof LispSymbol) {
      const special = compileSpecial(head.name, form, scope)
      if (special !== null) return special
    }

    // A call. The head is a script function if the file defines one, and a
    // runtime hook otherwise.
    const name = head instanceof LispSymbol ? head.name : null
    const args = form.slice(1).map((a) => expr(a, scope))
    if (name === null) return 'null'
    if (defined.has(name)) return `${ident(name)}(${args.join(', ')})`
    hooks.add(name)
    return `R.${ident(name)}(${args.join(', ')})`
  }

  const defined = new Set<string>()

  function compileSpecial(name: string, form: Sexp[], scope: Scope): string | null {
    switch (name) {
      case 'if': {
        const [, test, then, otherwise] = form
        const alt = otherwise === undefined ? 'null' : expr(otherwise, scope)
        return `(truthy(${expr(test, scope)}) ? ${expr(then, scope)} : ${alt})`
      }

      case 'progn': {
        // Comma expressions keep this an expression, which every other form
        // here can rely on.
        const body = form.slice(1).map((f) => expr(f, scope))
        return body.length === 0 ? 'null' : `(${body.join(', ')})`
      }

      case 'setq': {
        const parts: string[] = []
        for (let i = 1; i + 1 < form.length; i += 2) {
          const target = form[i]
          if (!(target instanceof LispSymbol)) continue
          const value = expr(form[i + 1], scope)
          if (scope.has(target.name)) {
            parts.push(`${ident(target.name)} = ${value}`)
          } else {
            globals.add(target.name)
            parts.push(`G.${ident(target.name)} = ${value}`)
          }
        }
        return parts.length === 0 ? 'null' : `(${parts.join(', ')})`
      }

      case 'let': {
        const inner = scope.child()
        const bindings: string[] = []
        const spec = form[1]
        if (Array.isArray(spec)) {
          for (const pair of spec) {
            if (Array.isArray(pair) && pair[0] instanceof LispSymbol) {
              // Bindings are evaluated in the *outer* scope, as `let` requires.
              bindings.push(`${ident(pair[0].name)} = ${expr(pair[1], scope)}`)
              inner.declare(pair[0].name)
            } else if (pair instanceof LispSymbol) {
              bindings.push(`${ident(pair.name)} = null`)
              inner.declare(pair.name)
            }
          }
        }
        const body = form.slice(2).map((f) => expr(f, inner))
        const decl = bindings.length ? `let ${bindings.join(', ')}; ` : ''
        return `(() => { ${decl}return ${body.length ? body[body.length - 1] : 'null'}; })()`.replace(
          'return ',
          body.length > 1 ? `${body.slice(0, -1).join('; ')}; return ` : 'return ',
        )
      }

      case 'select': {
        // `(select key (v body...) (v body...) ...)` - no fallthrough.
        const key = expr(form[1], scope)
        const arms = form.slice(2).map((arm) => {
          if (!Array.isArray(arm)) return null
          const value = expr(arm[0], scope)
          const body = arm.slice(1).map((f) => expr(f, scope))
          return `k === ${value} ? (${body.length ? body.join(', ') : 'null'})`
        })
        const chain = arms.filter(Boolean).join(' : ')
        return `(($k) => { const k = $k; return ${chain ? `${chain} : null` : 'null'}; })(${key})`
      }

      case 'while': {
        const test = expr(form[1], scope)
        const body = form.slice(2).map((f) => expr(f, scope))
        return `(() => { while (truthy(${test})) { ${body.join('; ')}; } return null; })()`
      }

      case 'and':
        return `(${form.slice(1).map((f) => `truthy(${expr(f, scope)})`).join(' && ')})`

      case 'or':
        return `(${form.slice(1).map((f) => `truthy(${expr(f, scope)})`).join(' || ')})`

      case 'not':
        return `(!truthy(${expr(form[1], scope)}))`

      case 'eq':
      case 'equal':
        return `(${expr(form[1], scope)} === ${expr(form[2], scope)})`

      case 'mod':
        return `(${expr(form[1], scope)} % ${expr(form[2], scope)})`

      // Declaration forms the asset pipeline already owns. They are data, not
      // behaviour: `tools/convert.ts` turns them into chars.json and
      // sounds.json at build time, so emitting calls for them here would only
      // invent hooks nothing needs. Skipping them is also what keeps the hook
      // list honest - `funs`, `flags`, `range` and `abilities` are `def_char`
      // syntax and were being counted as engine surface.
      case 'def_char':
      case 'def_sound':
      case 'defvar':
      case 'load':
      case 'compile-file':
      case 'set_game_name':
        return 'null'

      case 'defun': {
        const fname = form[1]
        if (!(fname instanceof LispSymbol)) return 'null'
        const inner = scope.child()
        const params: string[] = []
        if (Array.isArray(form[2])) {
          for (const p of form[2]) {
            if (p instanceof LispSymbol) {
              params.push(ident(p.name))
              inner.declare(p.name)
            }
          }
        }
        const body = form.slice(3).map((f) => expr(f, inner))
        const last = body.length ? body[body.length - 1] : 'null'
        const lead = body.length > 1 ? `${body.slice(0, -1).join(';\n  ')};\n  ` : ''
        functions.push(fname.name)
        out.push(
          `export function ${ident(fname.name)}(${params.join(', ')}) {\n  ${lead}return ${last};\n}\n`,
        )
        return 'null'
      }

      default: {
        if (INFIX[name]) {
          const args = form.slice(1).map((f) => expr(f, scope))
          // Unary minus is the one arity that is not a fold.
          if (name === '-' && args.length === 1) return `(-${args[0]})`
          return `(${args.join(` ${INFIX[name]} `)})`
        }
        if (COMPARE[name]) {
          const args = form.slice(1).map((f) => expr(f, scope))
          return `(${args[0]} ${COMPARE[name]} ${args[1]})`
        }
        return null
      }
    }
  }

  // Two passes: collect the function names first, so a call to a function
  // defined further down the file still compiles to a direct call.
  for (const form of forms) {
    if (Array.isArray(form) && isSymbol(form[0], 'defun') && form[1] instanceof LispSymbol) {
      defined.add(form[1].name)
    }
  }

  const topLevel: string[] = []
  for (const form of forms) {
    if (Array.isArray(form) && isSymbol(form[0], 'defun')) {
      expr(form, top)
      continue
    }
    // Anything else at the top level runs once at load, the way `load` does.
    topLevel.push(`  ${expr(form, top)};`)
  }

  const header =
    `// Generated from ${moduleName} by tools/compile.ts. Do not edit.\n` +
    `import { R, G, truthy } from './runtime'\n\n`

  const init = topLevel.length
    ? `export function load() {\n${topLevel.join('\n')}\n}\n`
    : `export function load() {}\n`

  return { code: header + out.join('\n') + '\n' + init, hooks, functions, globals }
}

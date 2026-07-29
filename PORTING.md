# Running the original scripts

The decision: **port Abuse's behaviour by compiling its own `.lsp` scripts to TypeScript at build
time.** Not an interpreter, and not a transliteration of `src/lisp.cpp` — same behaviour, our code,
as a generated module. The player, weapons, camera, CRT and audio stay ours.

### Compile, don't interpret — and don't `eval`

The 431 `defun`s become 431 real functions that V8 can JIT, with real stack frames and breakpoints
in devtools, and output we can read and hand-tune. An interpreter gives none of that and pays a
cons-cell and environment lookup for every node of every tick.

Runtime `eval` is the wrong half of the idea. Generating the module **at build time**, in the same
pipeline as the sprites and levels, gives typechecking, source maps, no parse cost per page load,
nothing that trips CSP, and tree-shaking. `eval` gives none of those and costs a parse on every
load.

The one thing a compiler still needs is a *small* compile-time evaluator, because some definitions
are generated: `make_hidden_wall_char` in `doors.lsp` builds its `def_char` with backquote and
calls `(eval ...)` on the result. `tools/lisp.ts` already expands those templates for the asset
pipeline, so the machinery exists — it just needs to run before codegen rather than instead of it.

## Why

Every wrong call in this project so far has been the same mistake: guessing what a level object
does instead of reading `assets/original/lisp/`. Hidden walls, trap doors, force fields, delay
gates — none of that is *mechanics*, it is the **behaviour contract the levels are authored
against**. Get it wrong and the level is unplayable no matter how good our own mechanics are.

The scripts are that contract, executable. Running them ends the guessing.

## The measured surface

Counted by parsing all 100 `.lsp` files with `tools/lisp.ts`:

| | |
|---|---|
| Top-level forms | 1872 |
| `defun`s | 431 |
| Distinct call heads | 587 |

587 overstates it. The count includes `def_char` sub-forms (`states` 320, `funs` 320, `flags`,
`range`, `fields`) which are syntax, not calls, and bare constants (`CP_1`…`CP_12`, `AD_1`…`AD_12`).
It also includes the 431 `defun`s' own bodies calling each other, which cost nothing to support.

The distribution is steeply Zipf — `if` 1816, `setq` 1578, `progn` 918, `y` 840, `eq` 838, `x` 835 —
and **179 heads are called twice or less**. The real engine surface is roughly:

- **~25 special forms** — `if setq progn defun let select while and or not quote` and backquote
- **~40 pure primitives** — arithmetic, comparison, `list`/`elt`/`length`, `random`, `mod`
- **~120 engine hooks** — the ones that touch the world

Nothing here is hard. It is wide, not deep, and most hooks are one-liners.

## Where it stands

`tools/compile.ts` exists and compiles. Against the 31 core `lisp/*.lsp` files it produces **254
functions and 178KB of readable JavaScript**, and reports **284 distinct runtime hooks** — down from
the 587 raw call heads once `def_char` and friends are recognised as the declaration forms they are.
**142 of the 284 are used by a single file**, so the working set is far smaller than the total.

The output is verifiably right where it can be checked by hand. `hwall_ai` compiles to the same
`hurt_radius(x + 15 * direction, y - 7, 50, 60, bg, 20)` that was transcribed by hand into
`World.runBlasts` — derived independently, and matching.

By breadth of use the first thirty hooks are: `x y aistate with_object play_sound get_object
total_objects next_picture bg set_aistate xvel set_xvel set_x set_state aitype set_y state
add_object random set_yvel state_time list yvel hp activated concatenate direction go_state distx
set_aitype`. That set is the target for the first runtime.

### Still to do in the compiler

- **Quote and backquote.** `tools/lisp.ts` drops `'` and skips `` ` `` — fine for the asset
  pipeline, wrong for codegen. Quoted symbols currently land as global reads, which happens to work
  for character and state names but will not hold in general.
- **Per-object `vars`.** `(vars end_y)` on `FORCE_FIELD` should be storage on the object, not a
  module global. `ff_draw` currently compiles to `G.end_y`, which is shared by every force field in
  the level.
- **`select` on non-numbers.** Compiled as `===` against each arm; fine for `aistate`, needs
  checking for the string and symbol cases.

## Order of work

**1. Codegen.** `tools/lisp.ts` already reads s-expressions correctly, including the backquote
forms `def_char` templates use. Add `tools/compile.ts`: expand templates, then emit one TypeScript
module per `.lsp` file. The mappings are mostly obvious — `if` to a ternary or statement, `setq` to
assignment, `let` to `const`, `progn` to a block, `select` to `switch`, `defun` to `function`.
Two that need thought:

- **`with_object`** is dynamic scoping of "self". A module-level current-object binding, saved and
  restored around the call, is enough — and reads better in the output than threading a parameter.
- **Globals vs locals.** `setq` writes to whichever scope already binds the symbol. Resolve that at
  compile time from the enclosing `let`/`defun` and emit a plain assignment either way.

**2. Object model bridge.** `Prop` already carries `x`, `y`, `state`, `aistate`, `hp`, `direction`
and the link list, which is most of `game_object`. Add `aitype`, `state_time`, per-character `vars`
(for things like `FORCE_FIELD`'s `end_y`), and `next_picture`. Bind `with_object`, `get_object`,
`total_objects` against the link list we already parse.

**3. The hooks, by use count.** Start at the top of the frequency table and stop when the levels
work. `x y set_x set_y xvel yvel set_xvel set_yvel hp aistate set_aistate aitype state_time
set_state next_picture add_object play_sound random bg direction distx disty total_objects
get_object with_object try_move hurt_radius`. That set alone covers doors, walls, gates, switches,
platforms, teleporters and force fields.

**4. Run object AI from lisp; keep ours for the player.** This is the "our touch" line. `ai_fun`
and `draw_fun` are already extracted per character, so the runtime can dispatch to a script when one
exists and fall back to our TypeScript when it does not. That makes the port incremental and
reversible rather than a big-bang swap — and it means the enemy AI in `ant.lsp` and friends arrives
for free once the hooks are in.

**5. Delete our stand-ins as the scripts take over.** `Door`, `CeilingAnt`, `Turret`, `Floater` and
the hidden-wall blast in `World` were all reconstructions of script behaviour. They go when the
script runs. `Player`, `Weapons`, `Bullets`, the CRT, the lighting and the audio stay.

## What stays ours

Player physics, the eight weapons, the special powers, weapon selection, the save console, the CRT
pass, the lighting layer, the music player, the asset pipeline, and every rendering decision. The
scripts describe what the *level* does. What the game feels like is still ours to choose.

## Known trap

The converter's editor-only detection looks for a bare `(draw)` and misses `ff_draw`'s
`(if (edit_mode) (draw))`. Other characters likely hide their marker the same way. Worth a sweep
before trusting the extracted `drawFun` data.

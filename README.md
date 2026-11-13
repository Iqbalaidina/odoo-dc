# odoo-dc

Explore an Odoo codebase from the command line: views, inheritance chains, composed arches,
window actions, Python method override chains and access rules. It reads the addons source
directly, so you don't need a database, a running server or Python.

- **Views:** search by id, model, name, field or file. See the base view and every inheriting
  view, and print the composed arch as XML after all `xpath` patches are applied.
- **Impact:** before you edit a view, list everything that depends on it (transitive inheritors
  across addons roots, actions that open it, fields it uses, patches that would no longer apply).
- **Python:** fields and methods of a model across every `_inherit`, method override chains
  (`super()` order), and where a field is read or written.
- **Callers and duplicates:** who calls a method (Python call sites, XML buttons and `<function>`
  pointers, server-action code) and which method bodies are near-duplicates of each other.
- **Access:** groups, ACL rows, record rules, field-level `groups=`, and which views, menus and
  actions a group gates.
- **Builder:** scaffold a module, model, views and access rows. It prints a dry-run plan with diffs
  and writes only with `--apply`.

Requires Node.js 20 or newer. No dependencies.

## Install

```sh
npm install -g github:<owner>/odoo-dc   # or: git clone … && npm link
```

## Quick start

```sh
cd /path/to/odoo-checkout          # folder holding odoo/addons, custom addons, enterprise …
odoo-dc roots                      # which addons roots were detected
odoo-dc search "res.partner form" --format brief
odoo-dc compose sale.view_order_form --all > order_form.xml
odoo-dc impact sale.view_order_form --format brief
odoo-dc pymethod sale.order action_confirm
odoo-dc acl res.partner
```

Roots are discovered under `--base` (default `$ODOO_DC_BASE`, else the current directory). To
choose them yourself, pass `--addons <dir>` (repeatable) or set `$ODOO_DC_ADDONS` (colon list).
Output is JSON on stdout; errors are one JSON object on stderr with exit code 1 (2 for usage errors).

## Commands

```text
odoo-dc <command> [args] [--root <label|path|all>] [--addons <path>]... [--base <dir>] [--limit n] [--refresh]
        [--format brief|json|compact] [--fields a,b] [--no-meta] [--include-data] [--no-cache]
        [--db <name>] [--installed <file>] [--installed-only] [--module <glob>]

Lookup commands (read-only, JSON on stdout unless --format brief):
  roots                          list detected addons roots
  search <query> [--type t]      views by id/model/name/field/file ("res.partner form")
  view <xmlId>                   one view: source, line, fields, xpaths
  compose <xmlId> [--all]        composed arch as XML (base + chain; --all = every inheritor)
  related <xmlId>                base view, direct inheritors, xpath patches, actions
  impact <xmlId>                 everything affected by editing a view: all inheritors (transitive,
                                 cross-root), actions opening it, fields it uses, compose skips
  actions [query] [--model m]    window actions
  action <xmlId>                 one window action (domain, context, target views, source)
  field <model> <field>          definition, views showing it, methods reading/writing it, and
                                 externalWriters (writers in other models that reach the field
                                 through a relation)   [--max-files n (60)] [--max-methods n (200)]
  pysearch <query> [--type method|function|model]
  pymodel <model>                fields + methods of a model
  pymethod <model> <name> [--step n]   override chain, super() targets, source
  callers <model> <method> [--limit n]
                                 who calls a method: Python callers, XML buttons and <function>
                                 calls, server actions   (one arg = method only, no model filter)
  dupes [--modules a,b] [--model m] [--threshold 0.75] [--min-lines 8] [--min-tokens 12] [--limit 40]
                                 near-duplicate method bodies across modules (glob modules, e.g.
                                 imt_*), clustered by body similarity
  similar <model.method> [--threshold 0.5] [--limit 10]
                                 the methods closest to one method (also accepts "<model> <method>")
  access [query] [--type group|model|artifact]
                                 search groups, models and gated views/menus/actions (ACL index)
  group <xmlId>                  group trace: includes / included by, per-model R/W/C/D with the
                                 granting group (models[].via), record rules, everything it gates
                                 (short ids resolve when unique)
  acl <model> [--group g] [--granted-to g] [--perm w]
                                 model trace: ACL per group, record rules, field-level groups, users
                                 of the model; the filters keep only matching rows
  gate <xmlId>                   view/menu/action trace: gating groups, menu chain, restricted nodes,
                                 each group's permissions on the model   [--scope root = this root only]
  get "<raw query string>"       any read action, e.g. 'action=module&module=sale'
  batch [--file cmds.json] [--schema]
                                 many read commands in one process: JSON array (or one object per
                                 line) of {"id","action",...}; one {"id","ok","result"|"brief"}
                                 line per item, exit 1 when any failed. Item keys: action + q
                                 (search-like), xmlId (view/compose/related/impact/action/group/
                                 gate), model (+field / +name), query (get). Per item: fields
                                 ("a,b"), meta:false, format:"brief". --schema prints the contract.

Root selection: no --root = first root for search/actions/py*, and view/compose/related/impact/action
fall back through every root until the id is found. --root <text> = the one root whose label/path/
kind contains <text>. --root all = every root.
Roots default to discovery under --base (default $ODOO_DC_BASE, else the current directory);
--addons <path> (repeatable, or $ODOO_DC_ADDONS colon list) sets them explicitly.
Install state: the index is built from source, so uninstalled modules otherwise look live. --db <name>
reads the installed module list (ir_module_module.state='installed') through psql; --installed <file>
reads one module name per line (offline, or without psql); --installed-only drops hits whose module is
known-uninstalled. Rows then carry installed: true|false|null, where null means unknown state and the
row is kept. $ODOO_DC_DB / $ODOO_DC_INSTALLED are the fallbacks, $ODOO_DC_PSQL picks the psql binary;
a failing psql is a warning, never a failed run, and doctor reports installed {source, db, file, count, error}.
--module <glob[,glob]> (pymodel, field, pysearch) keeps only rows whose defining module matches the glob
(imt_*); a field defined in several modules is kept when any definer matches.
--format brief prints one line per hit (search, actions, pysearch) or a short text report
(view, related, pymethod, pymodel, impact, field, group, acl, gate, builder). --fields a,b projects
the top-level JSON keys (also per batch item, not applied to brief text); --no-meta drops the global
stats/errors blocks. --full keeps wireframe trees (view, compose). --out file writes to a file.

Builder (writes only with --apply; default is a dry-run plan with diffs):
  module new <name> --into <addons dir> [--depends base,mail] [--summary s] [--category c] [--application]
  model new <module> <model.name> --field name:char:required [--field partner_id:many2one:res.partner]...
        [--field 'state:selection:draft=Draft|done=Done']   (quote tokens that contain |)
        [--preset name,partner,company,user,state,date,amount,active,sequence,note]   (common fields without tokens; combine with --field)
        [--views form,list,search] [--description d] [--menu "Label"] [--menu-parent module.menu_root]
        [--access base.group_user:rwcd]... [--no-access] [--no-action] [--create-module --into <dir> --depends ...]
  view new <module> <model> --type form|list|search [--type ...] [--fields a,b,c]
        (fields limited to the module's depends; required when more than 20 are reachable)
  access add <module> <model> <group|-> <rwcd>
  build --spec spec.json [--into <dir>]
    common: --apply  --odoo-version n  --into <addons dir> (default: where <module> is found)  --no-backup
    field token: name:type[:comodel[:inverse]|:a=A|b=B][:required][:readonly][:index][:default=value]
```

## Callers, duplicates and similarity

`callers <model> <method>` answers "who calls this" from three sources at once: Python call bodies,
XML `<button type="object">` / `<function>` calls, and `ir.actions.server` code. `--format brief` prints
the counts and one row per caller:

```text
imt.mro.report.service.get_kpi  1 python (1 uncertain)  0 views  0 server actions
  python?  imt_mro_life.report.imt.mro.part.life.xlsx._build_quality_sheet  imt_mro_life/report/part_life_xlsx.py:358
```

A python caller whose receiver is a local variable (`service.get_kpi(`) cannot be tied to the model
statically; it is still listed, marked with a trailing `?` in brief output and `certain: false` in JSON,
and the payload warns when such rows exist.

Dynamic dispatch (`getattr`, `eval`, `env[...]`) is not seen; the payload carries that caveat as a
warning.

`dupes` clusters method bodies whose token signatures are similar (Jaccard over a bottom-48 minhash of
5-gram token hashes, `--threshold 0.75` by default), so copied-and-pasted blocks across modules surface
without grep. `--modules imt_*` limits the scan, `--model` restricts the reported clusters to those
containing a method of that model, and `--min-lines` / `--min-tokens` ignore small bodies:

```text
dupes  1.00  3 methods  (imt.daily.blast, imt.daily.drill, imt.mro.part.usage)
  imt.mro.part.usage._next_name   imt_mro_life/models/part_usage.py:334        8 lines
  imt.daily.blast._next_name      imt_production/models/daily_blast.py:60      8 lines
  imt.daily.drill._next_name      imt_production/models/daily_drill.py:125    8 lines
```

`similar <model.method>` lists the nearest methods to one method instead of clustering the whole tree:
`<model>.<method>  matches (n):` followed by `score  model.name  file:line` lines.

## Library use

```js
import { createEngine, EngineError } from 'odoo-dc';

const engine = createEngine({ base: '/path/to/odoo-checkout' }); // or { roots: ['/path/to/addons'] }
const { items } = await engine.read('search', { q: 'res.partner form' });
try {
  await engine.read('pymodel', { model: 'no.such.model' });
} catch (error) {
  if (error instanceof EngineError) console.error(error.code, error.status, error.message);
}
```

`engine.read(action, params)` takes the actions listed under `get` above (`roots`, `index`,
`file`, `module`, `report`, `search`, `compose`, `related`, `actions`, `action`, `xpath`,
`xpathbase`, `pyindex`, `pymethod`, `pymodel`, `fields`, `secindex`, `sectrace`). It returns plain
objects and throws `EngineError` (`code`, `status`, `message`) on bad input or unknown ids.

## How it works

The parsers are tolerant and static. View XML, `ir.actions.*` records, `ir.model.access.csv`,
`ir.rule` records and Python class bodies are parsed without being executed. Inheritance order
follows the module `depends` graph and view priority, the way Odoo does. Results that cannot be
fully resolved carry `complete: false`, `warnings` or `truncated` instead of failing silently.
Python method order is approximate (`approxOrder: true`) because it is inferred from the
`depends` graph, not from a loaded registry.

## Tests

```sh
npm test
ODOO_DC_CORPUS=/path/to/odoo-checkout npm test   # also run the real-corpus smoke tests
```

## License

MIT

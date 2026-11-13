#!/usr/bin/env node
/**
 * odoo-dc: command-line access to the Odoo design console engine (`lib/engine.js`).
 *
 * Calls the same transport-free engine (`lib/engine.js`) as the HTTP route, so
 * the output matches the browser console. Lookup commands are read-only GET actions:
 * there is deliberately no `save` command. The only writing commands are the
 * builder ones (`cli/build.mjs`), dry-run unless `--apply` is given.
 *
 * Failure path: fail fast. Errors print one JSON object to stderr, exit code 1
 * (2 for usage errors). Nothing is swallowed: partial results carry explicit
 * `warnings` / `truncated` / `errors` fields instead.
 */
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CONSOLE_VERSION, EngineError, createEngine } from '../lib/engine.js';
import { BUILDER_BOOL_FLAGS, BUILDER_USAGE, builderBrief, isBuilderCommand, runBuilder } from './build.mjs';

const USAGE = `odoo-dc <command> [args] [--root <label|path|all>] [--addons <path>]... [--base <dir>] [--limit n] [--refresh] [--format brief|json|compact] [--fields a,b] [--include-data] [--no-cache]

Lookup commands (read-only, JSON on stdout unless --format brief):
  roots                          list detected addons roots
  doctor                         versions, roots, index and cache health, skipped files, warnings
  search <query> [--type t]      views by id/model/name/field/file ("res.partner form")
  view <xmlId>                   one view: source, line, fields, xpaths
  compose <xmlId> [--all]        composed arch as XML (base + chain; --all = every inheritor)
  related <xmlId> [--scope root] base view, direct inheritors (every indexed root), xpath patches, actions
  impact <xmlId>                 everything affected by editing a view: all inheritors (transitive,
                                 cross-root, primary/extensions tagged), actions opening it, fields it
                                 uses, compose skips
  actions [query] [--model m]    window actions
  action <xmlId>                 one window action (domain, context, target views, source)
  field <model> <field>          definition, views showing it, methods reading/writing it
                                 [--max-files n (60)] [--max-methods n (200)]
  pysearch <query> [--type method|function|model]
  pymodel <model>                fields + methods of a model
  pymethod <model> <name> [--step n]   override chain, super() targets, source
  access [query] [--type group|model|artifact]
                                 search groups, models and gated views/menus/actions (ACL index)
  group <xmlId>                  group trace: includes / included by, per-model R/W/C/D, record rules,
                                 everything it gates (short ids resolve when unique)
  acl <model>                    model trace: ACL per group, record rules, field-level groups, users of the model
  gate <xmlId>                   view/menu/action trace: gating groups, menu chain, restricted nodes,
                                 each group's permissions on the model   [--scope root = this root only]
  get "<raw query string>"       any read action, e.g. 'action=module&module=sale'
  batch [--file cmds.json] [--schema]
                                 run many read commands in one process: a JSON array (or one
                                 object per line) of {"id","action",...} read from stdin or the
                                 file; prints one {"id","ok","result"|"brief"} line per item,
                                 exit 1 when any item failed, and one {"failed":n,"total":m}
                                 line on stderr. Read-only (no builder commands). Item keys:
                                 action plus q/query (search, pysearch, actions, access),
                                 xmlId (view, compose, related, impact, action, group, gate,
                                 inheritors), model + field (field), model (pymodel, acl),
                                 model + name (pymethod), query (get). Per-item options: root,
                                 limit, type, scope, step, maxMethods, maxFiles, all, full,
                                 refresh, format ("brief"), fields ("a,b" projection), meta
                                 (false drops the global stats/errors from that line).
                                 --schema prints this contract as JSON and writes nothing.
  acl <model> [--group g] [--granted-to g] [--perm w]
                                 model trace; the filters keep only matching rows (group or a
                                 group it is granted to; --perm uses letters r/w/c/u, all must
                                 hold). omitted flags keep every row.

Root selection: no --root = first root for search/actions/py*, and view/compose/related/impact/action
fall back through every root until the id is found. --root <text> = the one root whose label/path/
kind contains <text>. --root all = every root.
Roots default to discovery under --base (default $ODOO_DC_BASE, else the current directory);
--addons <path> (repeatable, or $ODOO_DC_ADDONS colon list) sets them explicitly.
--format brief prints one line per hit (search, actions, pysearch) or a short text report
(view, related, pymethod, pymodel, impact, field, group, acl, gate, builder). --full keeps wireframe trees (view, compose).
--fields a,b projects the top-level JSON keys (also works per batch item); it is not applied to
--format brief text. --no-meta drops the global stats/errors blocks from JSON results (batch:
per-item meta:false), so output only carries the answer.
--out file writes to a file. compose/impact merge at most 400 views per query; the payload sets
capped=true and impact warns when the cap (or the 200-child related list) truncates.

${BUILDER_USAGE}`;

/** Read-only GET actions of the route. `save`, `folders` and POST-only actions are not listed. */
const READ_ACTIONS = new Set([
  'roots', 'index', 'file', 'module', 'report', 'pyindex', 'pymethod', 'pymodel', 'fields',
  'search', 'compose', 'related', 'inheritors', 'flows', 'modelflows', 'actions', 'action', 'xpath', 'xpathbase', 'secindex', 'sectrace',
]);

/** Contract of one `batch` item; printed by `batch --schema` and enforced before execution. */
const BATCH_SCHEMA = {
  usage: 'odoo-dc batch [--file cmds.json] [--format brief] [--fields a,b] [--no-meta] [--schema]',
  readOnly: true,
  itemKeys: {
    action: 'required: one read command (search, view, compose, related, impact, action, actions, field, pymodel, pymethod, pysearch, access, group, acl, gate, get, roots, doctor)',
    id: 'optional line id (defaults to the item index)',
    q: 'search, pysearch, actions, access: query string (query is an alias)',
    query: 'get: raw query string; alias of q for search-like commands',
    xmlId: 'view, compose, related, impact, action, group, gate, inheritors',
    model: 'field: model name; pymodel, acl: model name; pymethod: model name',
    field: 'field: field name',
    name: 'pymethod: method name',
    root: 'per-item root filter (label, path or id)',
    limit: 'per-item row limit',
    type: 'per-item type filter (search, pysearch, access)',
    scope: 'per-item scope (root | workspace)',
    step: 'pymethod: override-chain step',
    maxMethods: 'field: max analysed methods (max-methods is an alias)',
    maxFiles: 'field: max view files (max-files is an alias)',
    all: 'boolean: compose every inheritor',
    full: 'boolean: keep wireframe data',
    refresh: 'boolean: force a reindex',
    format: 'brief: render the short text form instead of JSON',
    fields: 'a,b: top-level projection for this line (a JSON array is accepted too)',
    meta: 'false: drop the global stats/errors blocks from this line',
  },
  unknownKeyPolicy: 'fail the item with a hint (exit 1), never silently ignore it',
};

/** Parse a `--fields` value (comma string or array) into projection keys. */
function projectionKeys(value) {
  if (Array.isArray(value)) return value.map((key) => String(key).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map((key) => key.trim()).filter(Boolean);
}

/** Drop the global index metadata that every command repeats (stats + ACL parse errors). */
function stripMeta(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const { stats, errors, ...rest } = result;
  return rest;
}

/** Route error codes that mean "not in this root", so the next root may have it. */
const NOT_FOUND = new Set(['unknown-view', 'unknown-action-record', 'unknown-file', 'unknown-model']);

/** Perm letters for brief output: R W C D, `-` when absent. */
const permText = (p) => (p ? `${p.read ? 'R' : '-'}${p.write ? 'W' : '-'}${p.create ? 'C' : '-'}${p.unlink ? 'D' : '-'}` : '----');

/** @param {string[]} argv @returns {{ pos: string[], flags: Map<string, string[]> }} parsed args. */
function parseArgs(argv) {
  const pos = [];
  const flags = new Map();
  const bool = new Set(['refresh', 'all', 'full', 'help', 'no-cache', 'include-data', 'prune', 'schema', 'no-meta', ...BUILDER_BOOL_FLAGS]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = bool.has(key) ? '1' : argv[i += 1];
      if (value === undefined) throw usage(`--${key} needs a value`);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else pos.push(arg);
  }
  return { pos, flags };
}

/** @param {string} message @returns {Error} usage error (exit 2). */
function usage(message) {
  return Object.assign(new Error(message), { exitCode: 2, code: 'usage' });
}

/** Run one read-only action against the engine; `query` is a URL query string. */
async function get(engine, query) {
  const params = new URLSearchParams(query);
  const action = params.get('action') ?? 'roots';
  if (!READ_ACTIONS.has(action)) throw usage(`action=${action} is not a read-only action`);
  try {
    // A JSON round trip keeps the old contract: formatters get plain copies, never live cache objects.
    return JSON.parse(JSON.stringify(await engine.read(action, params)));
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    throw Object.assign(new Error(error.message), { exitCode: 1, code: error.code, status: error.status });
  }
}

const enc = encodeURIComponent;
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Serialise a preview tree ({tag, attrs, children, text, highlight}) to indented XML. */
function treeToXml(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(node.attrs ?? {}).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  const mark = node.highlight ? `${pad}<!-- contributed by the selected view -->\n` : '';
  const text = (node.text ?? '').trim();
  if ((node.children ?? []).length === 0 && text === '') return `${mark}${pad}<${node.tag}${attrs}/>\n`;
  const inner = (text === '' ? '' : `${pad}  ${text}\n`) + node.children.map((c) => treeToXml(c, depth + 1)).join('');
  return `${mark}${pad}<${node.tag}${attrs}>\n${inner}${pad}</${node.tag}>\n`;
}

/** Drop bulky wireframe data unless --full; the XML form of `composed` replaces it. */
function slimCompose(payload, full) {
  if (full) return payload;
  const { composed, ...rest } = payload;
  return { ...rest, composedXml: composed ? treeToXml(composed) : null };
}

/** One view out of a file payload: `source` (the full record) stays; wireframe, raw copy and arch duplicate go. */
function slimView(view, full) {
  if (full) return view;
  const { preview, sourceRaw, arch, fieldText, ...rest } = view;
  return rest;
}

/** One view by exact id inside one root. Throws `unknown-view` when this root lacks it. */
async function viewInRoot(engine, root, xmlId) {
  const found = await get(engine, `action=search&root=${enc(root.id)}&q=${enc(xmlId)}`);
  const hit = (found.items ?? []).find((v) => v.xmlId === xmlId || v.id === xmlId);
  if (hit === undefined) throw Object.assign(new Error(`view ${xmlId} not found in root ${root.label}`), { exitCode: 1, code: 'unknown-view' });
  const detail = await get(engine, `action=file&root=${enc(root.id)}&file=${enc(hit.file)}`);
  const view = (detail.views ?? []).find((v) => v.xmlId === hit.xmlId);
  if (view === undefined) throw Object.assign(new Error(`view ${hit.xmlId} missing from ${hit.file}`), { exitCode: 1, code: 'unknown-view' });
  return { detail, view, hit };
}

/**
 * Try `run(root)` on each root until one has the id. Only "not found" errors move on;
 * every other error is rethrown. When all roots miss, the error names the roots tried.
 */
async function firstRootWith(roots, what, run) {
  let lastError;
  for (const root of roots) {
    try {
      const value = await run(root);
      return { root, value };
    } catch (error) {
      if (!NOT_FOUND.has(error.code)) throw error;
      lastError = error;
    }
  }
  const tried = roots.map((r) => r.label).join(', ');
  throw Object.assign(new Error(`${what} not found (roots tried: ${tried})${lastError ? ` — ${lastError.message}` : ''}`), { exitCode: 1, code: lastError?.code ?? 'not-found' });
}

/** Index every root other than `keep`, so cross-root type resolution is populated (idempotent, cached). */
async function indexOtherRoots(engine, roots, keep) {
  for (const root of roots) {
    if (root.id !== keep.id) await get(engine, `action=index&root=${enc(root.id)}`);
  }
}

/** Search one root; when custom extension views have unresolved types, index the other roots and retry once. */
async function searchRoot(engine, roots, root, q, type, refresh) {
  const query = `action=search&root=${enc(root.id)}&q=${enc(q)}${type ? `&type=${enc(type)}` : ''}${refresh}`;
  let result = await get(engine, query);
  if ((result.items ?? []).some((v) => v.typeResolved === false && v.inheritId)) {
    await indexOtherRoots(engine, roots, root);
    result = await get(engine, query.replace(refresh, ''));
  }
  return result;
}

/** Roots whose data/demo skip count was already reported in this process. */
const warnedDataSkips = new Set();

/** `impact`: all that a change to one view can affect. */
async function impact(engine, roots, xmlId) {
  const { root, value } = await firstRootWith(roots, `view ${xmlId}`, async (r) => {
    const rel = await get(engine, `action=related&root=${enc(r.id)}&xmlId=${enc(xmlId)}`);
    if (rel.target === null || rel.target === undefined) throw Object.assign(new Error(`view ${xmlId} not found in root ${r.label}`), { exitCode: 1, code: 'unknown-view' });
    return rel;
  });
  const owner = roots.find((candidate) => candidate.id === value.targetRootId) ?? root;
  const [composed, own, inherited] = await Promise.all([
    get(engine, `action=compose&root=${enc(owner.id)}&xmlId=${enc(xmlId)}&mode=all`),
    viewInRoot(engine, owner, xmlId),
    get(engine, `action=inheritors&root=${enc(owner.id)}&xmlId=${enc(xmlId)}`),
  ]);
  const skipped = composed.skipped ?? [];
  const warnings = [];
  if (skipped.length > 0 || composed.skippedTotal > 0) warnings.push(`compose skipped ${composed.skippedTotal ?? skipped.length} operation(s); inheritor content may be missing from the merged arch`);
  if (composed.complete !== true) warnings.push('compose reported complete=false');
  if (composed.truncated) warnings.push('compose was truncated');
  if (composed.capped) warnings.push('compose stopped at its 400-view cap; the merged arch is incomplete (the inheritor list is complete)');
  if (inherited.capped) warnings.push('inheritor list capped at 1000; raise MAX_INHERITORS to see the rest');
  if ((value.duplicateChildren ?? 0) > 0) warnings.push(`${value.duplicateChildren} duplicate module copy(ies) collapsed to one xml id; the child paths list every copy`);
  if ((value.childrenTotal ?? 0) > (value.children ?? []).length) warnings.push(`direct inheritor list capped at ${(value.children ?? []).length} of ${value.childrenTotal}; childrenTotal has the real count`);
  if ((inherited.skippedDataFiles ?? 0) > 0 && !warnedDataSkips.has(owner.id)) {
    // Correctness signal, but it is identical for every impact in one process:
    // print it once per root per invocation instead of on every batch line.
    warnedDataSkips.add(owner.id);
    warnings.push(`${inherited.skippedDataFiles} data/demo XML file(s) are outside the view index; views declared there are not listed`);
  }
  if (composed.indexHealth?.truncated) warnings.push('the view index for this root hit maxFiles; results can be incomplete');
  if ((composed.indexHealth?.failed ?? 0) > 0) warnings.push(`${composed.indexHealth.failed} view file(s) in this root failed to parse`);
  return {
    xmlId,
    root: owner.label,
    model: value.target.model,
    type: value.target.type,
    file: `${value.target.file}:${value.target.line}`,
    rootId: value.targetRootId ?? root.id,
    parent: value.parent?.xmlId ?? null,
    directInheritors: (value.children ?? []).map((c) => c.xmlId),
    directInheritorsTotal: value.childrenTotal ?? (value.children ?? []).length,
    allInheritors: (inherited.inheritors ?? []).map((v) => ({ xmlId: v.xmlId, module: v.module, priority: v.priority, mode: v.mode, file: v.file })),
    transitive: (inherited.inheritors ?? []).some((v) => !(value.children ?? []).some((c) => c.xmlId === v.xmlId)),
    actions: (value.actions ?? []).map((a) => ({ xmlId: a.xmlId, name: a.name })),
    actionsTotal: value.actionsTotal ?? (value.actions ?? []).length,
    fields: own.view.fields ?? [],
    skipped,
    warnings,
  };
}

/** True when a flow field name is the field itself or a path through it (`order_line.price_total`). */
/** `field`: where a model field is defined, shown and used. */
async function fieldReport(engine, roots, model, field, flags) {
  const num = (k, d) => { const v = Number.parseInt(flags.get(k)?.at(-1) ?? '', 10); return Number.isFinite(v) && v > 0 ? v : d; };
  const maxFiles = num('max-files', 60);
  const requestedMethods = Number.parseInt(flags.get('max-methods')?.at(-1) ?? '', 10);
  const first = roots[0];
  const methodLimit = Number.isFinite(requestedMethods) && requestedMethods > 0 ? `&maxMethods=${enc(String(requestedMethods))}` : '';
  // One scoped pass: field definition plus the flow of every method of the model.
  const flowReport = await get(engine, `action=modelflows&root=${enc(first.id)}&model=${enc(model)}&field=${enc(field)}${methodLimit}&scanWriters=1`);

  // Views: search each root by "<model> <field>", then confirm the field is in the view arch.
  const views = [];
  const viewErrors = [];
  let filesChecked = 0;
  let viewsTruncated = false;
  const seenFiles = new Set();
  for (const root of roots) {
    const found = await searchRoot(engine, roots, root, `${model} ${field}`, '', '');
    if (found.truncated) viewsTruncated = true;
    for (const item of (found.items ?? []).filter((i) => i.model === model)) {
      const key = `${root.id}\u0000${item.file}`;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      if (filesChecked >= maxFiles) { viewsTruncated = true; break; }
      filesChecked += 1;
      try {
        const detail = await get(engine, `action=file&root=${enc(root.id)}&file=${enc(item.file)}`);
        for (const v of detail.views ?? []) {
          if (v.model === model && (v.fields ?? []).includes(field)) {
            views.push({ xmlId: v.xmlId, type: v.type, mode: v.mode, file: `${item.file}:${v.line}`, root: root.label });
          }
        }
      } catch (error) {
        viewErrors.push({ file: item.file, error: error.message });
      }
    }
  }

  const methods = (flowReport.methods ?? []).map((row) => ({ name: row.name, roles: row.roles, module: row.module, file: `${row.file}:${row.line}` }));
  const externalWriters = (flowReport.externalWriters ?? []).map((row) => ({
    model: row.model, method: row.name, roles: row.roles, module: row.module, file: `${row.file}:${row.line}`,
  }));

  const warnings = [];
  if (externalWriters.length > 0) {
    warnings.push(`writes also come from ${[...new Set(externalWriters.map((row) => row.model))].join(', ')} (relation fields pointing at ${model}); see externalWriters`);
  }
  if (methods.every((row) => !(row.roles ?? []).includes('write')) && externalWriters.length === 0) {
    warnings.push('no writer found among the model methods or through a relation field; env()/search() writes are not scanned');
  }
  if (viewsTruncated) warnings.push(`view search truncated (max ${maxFiles} files); raise --max-files`);
  if (flowReport.truncated) warnings.push(`only ${flowReport.analysed} of ${flowReport.total} methods analysed; raise --max-methods`);
  for (const warning of flowReport.warnings ?? []) warnings.push(warning);
  return {
    model,
    field,
    definition: {
      fieldType: flowReport.definition.fieldType,
      comodel: flowReport.definition.comodel,
      string: flowReport.definition.string,
      attrs: flowReport.definition.attrs,
      module: flowReport.definition.module,
      file: `${flowReport.definition.file}:${flowReport.definition.line}`,
      definitions: flowReport.definition.definitions,
    },
    computeMethod: flowReport.computeMethod ?? null,
    views,
    methods,
    externalWriters,
    errors: viewErrors,
    warnings,
  };
}

/** Compact text for `--format brief`; `null` means the command has no brief form. */
function toBrief(cmd, r) {
  const lines = [];
  if (cmd === 'search') {
    for (const v of r.items ?? []) lines.push([v.xmlId, v.model, `${v.type}${v.mode === 'extension' ? ' (ext)' : ''}`, `${v.file}:${v.line}`].join('\t'));
    if (r.truncated) lines.push('… truncated');
  } else if (cmd === 'actions') {
    for (const a of r.items ?? []) lines.push([a.xmlId, a.resModel, a.viewMode, a.target, a.file].join('\t'));
    if (r.truncated) lines.push(`… ${r.total} total`);
  } else if (cmd === 'pysearch') {
    for (const m of r.items ?? []) lines.push([m.kind, m.model ? `${m.model}.${m.name}` : m.name, m.module, `${m.file ?? ''}${m.line ? `:${m.line}` : ''}`].join('\t'));
  } else if (cmd === 'impact') {
    lines.push(`${r.xmlId}  [${r.type}] ${r.model}  ${r.file}  (root: ${r.root})`);
    lines.push(`parent: ${r.parent ?? '-'}`);
    lines.push(`inheritors (${r.allInheritors.length}, direct ${r.directInheritors.length}${r.transitive === false ? ', no transitive' : ''}): ${r.allInheritors.map((v) => v.xmlId).join(', ') || '-'}`);
    lines.push(`actions (${r.actionsTotal}): ${r.actions.map((a) => a.xmlId).join(', ') || '-'}`);
    lines.push(`fields (${r.fields.length}): ${r.fields.join(', ')}`);
    for (const s of r.skipped) lines.push(`SKIPPED ${s.xmlId} ${s.reason} ${s.expr}`);
    for (const w of r.warnings) lines.push(`WARNING ${w}`);
  } else if (cmd === 'field') {
    lines.push(`${r.model}.${r.field}  ${r.definition.fieldType}${r.definition.comodel ? `(${r.definition.comodel})` : ''}  ${r.definition.file}${r.computeMethod ? `  compute=${r.computeMethod}` : ''}`);
    lines.push(`views (${r.views.length}):`);
    for (const v of r.views) lines.push(`  ${v.xmlId}\t${v.type}${v.mode === 'extension' ? ' (ext)' : ''}\t${v.file}`);
    lines.push(`methods (${r.methods.length}):`);
    for (const m of r.methods) lines.push(`  ${m.name}\t${m.roles.join('+')}\t${m.file ?? ''}`);
    if ((r.externalWriters ?? []).length > 0) {
      lines.push(`external writers (${r.externalWriters.length}):`);
      for (const m of r.externalWriters) lines.push(`  ${m.model}.${m.method}\t${m.roles.join('+')}\t${m.file ?? ''}`);
    }
    for (const e of r.errors) lines.push(`ERROR ${e.file ?? e.method}: ${e.error}`);
    for (const w of r.warnings) lines.push(`WARNING ${w}`);
  } else if (cmd === 'view') {
    const v = r.view ?? {};
    lines.push(`${v.xmlId}  [${v.type ?? '?'}${v.mode === 'extension' ? ' ext' : ''}] ${v.model || '(no model)'}  ${r.file?.file ?? ''}:${v.line ?? ''}  (${r.root ?? ''})`);
    lines.push(`inherit: ${v.inheritId || '-'}  priority: ${v.priority || '-'}  fields: ${(v.fields ?? []).length}  xpaths: ${(v.xpaths ?? []).length}`);
    if ((v.fields ?? []).length > 0) lines.push(`fields: ${(v.fields ?? []).slice(0, 80).join(', ')}`);
    const acts = r.actions ?? [];
    lines.push(`actions (${acts.length}): ${acts.slice(0, 10).map((a) => a.xmlId).join(', ') || '-'}${acts.length > 10 ? ', …' : ''}`);
  } else if (cmd === 'pymodel') {
    const fields = (r.fields ?? []).map((f) => f.name ?? f);
    const methods = (r.methods ?? []).map((m) => m.name ?? m);
    lines.push(`${r.model}  ${r.fieldCount ?? fields.length} fields  ${methods.length} methods${r.description ? `  ${r.description}` : ''}`);
    if (fields.length > 0) lines.push(`fields: ${fields.slice(0, 80).join(', ')}${fields.length > 80 ? ', …' : ''}`);
    if (methods.length > 0) lines.push(`methods: ${methods.slice(0, 80).join(', ')}${methods.length > 80 ? ', …' : ''}`);
  } else if (cmd === 'doctor') {
    lines.push(`odoo-dc ${r.odooDc}  console ${r.consoleVersion}  ${r.node}  base ${r.base}`);
    for (const workspace of r.workspaces ?? []) lines.push(`workspace ${workspace.path}  odoo ${workspace.version ?? 'unknown'}`);
    lines.push(`roots (${r.roots.length}):`);
    for (const row of r.roots) {
      lines.push(`  ${row.label}\t${row.path}\tfiles ${row.stats.files}\tviews ${row.stats.views}\tactions ${row.stats.actions}\tmodules ${row.stats.modules}\tskippedData ${row.stats.skippedData}`);
    }
    lines.push(`totals: files ${r.totals.files}  views ${r.totals.views}  actions ${r.totals.actions}  modules ${r.totals.modules}`);
    lines.push(`cache: ${r.cache.dir}  ${r.cache.enabled ? 'on' : 'off'}  ${r.cache.files} file(s)  ${(r.cache.bytes / 1048576).toFixed(1)} MB  (view ${r.cache.viewFiles}, python ${r.cache.pyFiles})`);
    if (r.cache.pruned.files > 0) lines.push(`pruned: ${r.cache.pruned.files} file(s)  ${(r.cache.pruned.bytes / 1048576).toFixed(1)} MB`);
    for (const warning of r.warnings) lines.push(`WARNING ${warning}`);
  } else if (cmd === 'related') {
    const tgt = r.target ?? {};
    lines.push(`${tgt.xmlId}  [${tgt.type ?? '?'}] ${tgt.model || '(no model)'}  ${tgt.file}:${tgt.line}`);
    lines.push(`parent: ${r.parent?.xmlId ?? '-'}`);
    lines.push(`children (${r.childrenTotal}${(r.children ?? []).length < r.childrenTotal ? `, showing ${(r.children ?? []).length}` : ''}): ${(r.children ?? []).map((c) => c.xmlId).join(', ') || '-'}`);
    lines.push(`actions (${r.actionsTotal}): ${(r.actions ?? []).map((a) => a.xmlId).join(', ') || '-'}`);
  } else if (cmd === 'pymethod') {
    lines.push(`${r.model}.${r.name}  chain=${(r.chain ?? []).length}  selected=${r.selectedStep}`);
    for (const step of r.chain ?? []) {
      lines.push(`  ${step.step}\t${step.module}\t${step.file}:${step.line}\tsuper=${step.hasSuper ? 'y' : 'n'}${step.isBase ? ' base' : ''}${step.brokenChain && step.isBase !== true ? ' BROKEN' : ''}`);
    }
    for (const w of r.warnings ?? []) lines.push(`WARNING ${w}`);
  } else if (cmd === 'access') {
    for (const i of r.items ?? []) lines.push([i.kind === 'artifact' ? i.artifact : i.kind, i.id, i.name !== i.id ? i.name : '', i.detail].join('\t'));
    if (r.truncated) lines.push(`… ${r.total} total`);
    for (const e of r.errors ?? []) lines.push(`ISSUE ${e.file}:${e.line} ${e.message}`);
  } else if (cmd === 'group') {
    lines.push(`${r.group.xmlId}  ${r.group.name}  ${r.group.file}:${r.group.line}`);
    lines.push(`includes (${r.includes.length}): ${r.includes.map((g) => g.xmlId).join(', ') || '-'}`);
    lines.push(`included by (${r.includedBy.length}): ${r.includedBy.map((g) => g.xmlId).join(', ') || '-'}`);
    lines.push(`models (${r.models.length}):`);
    for (const m of r.models) {
      const inheritedFrom = (m.via ?? []).filter((entry) => entry.direct !== true).map((entry) => entry.group);
      lines.push(`  ${m.model}\t${permText(m)}${inheritedFrom.length > 0 ? `\tvia ${inheritedFrom.join(',')}` : ''}`);
    }
    lines.push(`rules (${r.rules.direct.length} direct, ${r.rules.inherited.length} inherited):`);
    for (const x of [...r.rules.direct, ...r.rules.inherited]) lines.push(`  ${x.xmlId}\t${x.modelKey}\t${permText(x.perms)}\t${x.domain}`);
    lines.push(`gates (${r.gates.length}):`);
    for (const g of r.gates) lines.push(`  ${g.kind}\t${g.owner}${g.tag ? ` <${g.tag}>` : ''}${g.negated ? ' (excluded)' : ''}\t${g.file}:${g.line}`);
    for (const w of r.warnings) lines.push(`WARNING ${w.message}`);
  } else if (cmd === 'acl') {
    lines.push(`${r.model}  (${r.key})`);
    lines.push(`acl (${r.groups.length}):`);
    for (const g of r.groups) lines.push(`  ${g.global ? '(everyone)' : g.group}\t${permText(g.perms)}${g.grantedAlsoTo.length ? `\talso (${g.grantedAlsoTo.length}): ${g.grantedAlsoTo.join(', ')}` : ''}`);
    lines.push(`rules (${r.rules.length}):`);
    for (const x of r.rules) lines.push(`  ${x.xmlId}\t${x.global ? 'GLOBAL' : x.groups.join(',')}\t${permText(x.perms)}\t${x.domain}`);
    lines.push(`field groups (${(r.fieldGroups ?? []).length}):`);
    for (const f of r.fieldGroups ?? []) lines.push(`  ${f.name}\t${f.groups}\t${f.file}:${f.line}`);
    lines.push(`used by (${r.used.length}): ${r.used.slice(0, 30).map((u) => `${u.kind}:${u.xmlId}${u.gated ? '*' : ''}`).join(', ')}${r.used.length > 30 ? ', …' : ''}`);
    for (const w of r.warnings) lines.push(`WARNING ${w.message}`);
  } else if (cmd === 'gate') {
    const a = r.artifact;
    lines.push(`${a.xmlId}  [${a.kind}] ${a.model || '-'}  ${a.file}:${a.line}${a.action ? `  action=${a.action}` : ''}`);
    for (const m of r.menuChain) lines.push(`menu ${m.xmlId}\t${m.groups.map((g) => g.xmlId).join(', ') || 'open to all'}`);
    lines.push(`reach (${r.reach.length}):`);
    for (const g of r.reach) lines.push(`  ${g.group}\t${permText(g.perms)}`);
    lines.push(`nodes (${r.nodes.length}):`);
    for (const n of r.nodes) lines.push(`  <${n.tag}>:${n.line}\t${n.groups.map((g) => `${g.negated ? '!' : ''}${g.xmlId}`).join(', ')}`);
    for (const w of r.warnings) lines.push(`WARNING ${w.message}`);
  } else return null;
  return `${lines.join('\n')}\n`;
}

/** Detect the Odoo version of one workspace (`<ws>/odoo/odoo/release.py` first). */
function detectWorkspaceVersion(workspace) {
  for (const rel of ['odoo/odoo/release.py', 'odoo/release.py', 'release.py']) {
    try {
      const text = readFileSync(join(workspace, rel), 'utf8');
      const match = /version_info\s*=\s*\((\d+),\s*(\d+)/.exec(text);
      if (match !== null) return Number(`${match[1]}.${match[2]}`);
    } catch {
      // try the next layout
    }
  }
  return null;
}

/** The `--format` choice: `json` (pretty, default), `compact` or `brief`. */
function formatChoice() {
  const i = process.argv.indexOf('--format');
  if (i < 0) return 'json';
  const value = process.argv[i + 1];
  if (value !== 'brief' && value !== 'json' && value !== 'compact') throw usage('--format must be brief, json or compact');
  return value;
}

/**
 * Health report: versions, roots, index stats, cache state and blind spots.
 * @param {object} engine - engine facade.
 * @param {Array<object>} roots - discovered roots.
 * @param {string} base - resolved base directory.
 * @returns {Promise<object>} doctor payload.
 */
async function doctorReport(engine, roots, base, flags = new Map()) {
  const workspaceVersions = new Map();
  for (const root of roots) {
    if (typeof root.workspace === 'string' && root.workspace.length > 0 && !workspaceVersions.has(root.workspace)) {
      workspaceVersions.set(root.workspace, detectWorkspaceVersion(root.workspace));
    }
  }
  const rows = [];
  const totals = { files: 0, views: 0, actions: 0, modules: 0, skippedData: 0, failed: 0, truncatedRoots: 0 };
  for (const root of roots) {
    const payload = await get(engine, `action=index&root=${enc(root.id)}`);
    const stats = payload.stats ?? {};
    rows.push({
      id: root.id,
      label: root.label,
      path: root.path,
      kind: root.kind,
      workspace: root.workspace ?? '',
      stats: {
        files: stats.files ?? 0,
        views: stats.views ?? 0,
        actions: stats.actions ?? 0,
        modules: stats.modules ?? 0,
        candidates: stats.candidateFiles ?? 0,
        skippedData: stats.skippedData ?? 0,
        failed: stats.failed ?? 0,
        truncated: stats.truncated === true,
        builtAt: stats.builtAt ?? '',
      },
    });
    for (const key of ['files', 'views', 'actions', 'modules', 'skippedData', 'failed']) totals[key] += rows[rows.length - 1].stats[key];
    if (rows[rows.length - 1].stats.truncated) totals.truncatedRoots += 1;
  }
  const options = engine.state.options;
  const cache = { dir: options.cacheDir, enabled: options.diskCache === true, files: 0, bytes: 0, viewFiles: 0, viewBytes: 0, pyFiles: 0, pyBytes: 0 };
  const pruneDays = Number.parseInt(flags.get('prune-days')?.at(-1) ?? '30', 10);
  const pruneBefore = Date.now() - (Number.isFinite(pruneDays) && pruneDays >= 0 ? pruneDays : 30) * 86_400_000;
  const pruned = { files: 0, bytes: 0 };
  try {
    for (const name of readdirSync(cache.dir)) {
      let info;
      try {
        info = statSync(join(cache.dir, name));
      } catch {
        continue;
      }
      if (flags.has('prune') && info.mtimeMs < pruneBefore) {
        try {
          unlinkSync(join(cache.dir, name));
          pruned.files += 1;
          pruned.bytes += info.size;
          continue;
        } catch {
          // a file that cannot be removed is simply kept
        }
      }
      cache.files += 1;
      cache.bytes += info.size;
      if (name.startsWith('py-')) {
        if (name.endsWith('.bin')) cache.pyFiles += 1;
        cache.pyBytes += info.size;
      } else if (name.endsWith('.json')) {
        cache.viewFiles += 1;
        cache.viewBytes += info.size;
      }
    }
  } catch {
    // No cache directory yet: report the configured path with zero files.
  }
  const warnings = [];
  if (totals.truncatedRoots > 0) warnings.push(`${totals.truncatedRoots} root(s) hit maxFiles; the index is incomplete`);
  if (totals.failed > 0) warnings.push(`${totals.failed} view file(s) failed to parse`);
  if (totals.skippedData > 0) warnings.push(`${totals.skippedData} data/demo XML file(s) are outside the view index; views declared there read as unknown-view`);
  if (!cache.enabled) warnings.push('the disk cache is off; every run rebuilds the index');
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    // a package without a version still reports the console version
  }
  return {
    odooDc: version,
    consoleVersion: CONSOLE_VERSION,
    node: process.version,
    base,
    workspaces: [...workspaceVersions.entries()].map(([path, odooVersion]) => ({ path, version: odooVersion })),
    roots: rows,
    totals,
    cache: { ...cache, pruned },
    warnings,
  };
}

/** Not-found error codes: these exit 3 so scripts can tell "absent" from "failed". */
const NOT_FOUND_CODES = new Set(['unknown-view', 'unknown-model', 'unknown-action', 'unknown-file', 'unknown-field', 'unknown-method', 'unknown-group', 'unknown-root']);

/**
 * Merge index-health flags of several root searches.
 * @param {Array<object>} parts - per-root search payloads.
 * @returns {{ indexHealth: { truncated: boolean, failed: number } }} merged health.
 */
function searchHealth(parts) {
  const failed = parts.reduce((total, part) => total + (part.indexHealth?.failed ?? 0), 0);
  return {
    indexHealth: {
      truncated: parts.some((part) => part.indexHealth?.truncated === true || part.truncated === true),
      failed,
    },
  };
}

/**
 * Add the schema version and apply `--fields` to one JSON result.
 * @param {object} result - command result.
 * @returns {object} projected result.
 */
function projectResult(result, keys = []) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const withSchema = { schemaVersion: 1, ...result };
  if (keys.length === 0) return withSchema;
  const picked = { schemaVersion: 1 };
  for (const key of keys) if (key in withSchema) picked[key] = withSchema[key];
  return picked;
}

/** Apply `--no-meta` to a single-command result. */
function stripMetaForFlags(result) {
  return process.argv.includes('--no-meta') ? stripMeta(result) : result;
}

/** `--fields` of the current invocation (batch items have their own). */
function cliProjection() {
  const i = process.argv.indexOf('--fields');
  return i < 0 ? [] : projectionKeys(process.argv[i + 1]);
}

/** Read all of stdin as UTF-8 text. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse a batch payload: a JSON array of items, or one JSON object per line.
 * @param {string} text - raw stdin or file contents.
 * @returns {Array<object>} items.
 */
function parseBatchItems(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw usage('batch: the JSON payload must be an array');
    return parsed;
  }
  return trimmed.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw usage(`batch: line ${index + 1} is not JSON`);
      }
    });
}

/**
 * Map one batch item to CLI positionals.
 * @param {object} item - `{ action, ... }`.
 * @returns {string[]} command plus positional arguments.
 */
function batchArgv(item) {
  const action = typeof item.action === 'string' ? item.action.trim() : '';
  if (action.length === 0) throw usage('batch: every item needs an action');
  if (action === 'build' || item.new === true || item.add === true || isBuilderCommand(action, ['new'])) {
    throw usage(`batch is read-only; "${action}" is a builder command`);
  }
  const argv = [action];
  const push = (value) => {
    if (value !== undefined && value !== null && value !== '') argv.push(String(value));
  };
  switch (action) {
    case 'roots':
      break;
    case 'search':
    case 'pysearch':
    case 'actions':
    case 'access':
      push(item.q ?? item.query);
      break;
    case 'view':
    case 'compose':
    case 'related':
    case 'impact':
    case 'action':
    case 'group':
    case 'gate':
    case 'inheritors':
      push(item.xmlId);
      break;
    case 'field':
      push(item.model);
      push(item.field);
      break;
    case 'pymodel':
    case 'acl':
      push(item.model);
      break;
    case 'pymethod':
      push(item.model);
      push(item.name);
      break;
    case 'get':
      push(item.query ?? item.q);
      break;
    default:
      throw usage(`batch: unknown action "${action}"`);
  }
  return argv;
}

/**
 * Flags for one batch item; a global `--root` is the default.
 * @param {object} item - batch item.
 * @param {Map<string, string[]>} globals - flags of the batch invocation.
 * @returns {Map<string, string[]>} per-item flags.
 */
function batchFlags(item, globals) {
  const flags = new Map();
  const add = (key, value) => {
    if (value !== undefined && value !== null && value !== '') flags.set(key, [...(flags.get(key) ?? []), String(value)]);
  };
  add('root', item.root ?? globals.get('root')?.at(-1));
  add('limit', item.limit);
  add('type', item.type);
  add('scope', item.scope);
  add('model', item.model);
  add('step', item.step);
  add('max-methods', item.maxMethods ?? item['max-methods']);
  add('max-files', item.maxFiles ?? item['max-files']);
  if (item.all === true) flags.set('all', ['1']);
  if (item.full === true) flags.set('full', ['1']);
  if (item.refresh === true) flags.set('refresh', ['1']);
  return flags;
}

/**
 * Run many read commands in one process, one NDJSON line per item.
 * @param {object} engine - engine facade.
 * @param {string} base - resolved base directory.
 * @param {Map<string, string[]>} flags - flags of the batch invocation.
 * @returns {Promise<void>} resolves when every line is written.
 */
async function runBatch(engine, base, flags) {
  const file = flags.get('file')?.at(-1);
  let text;
  if (file !== undefined) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw usage(`batch: cannot read ${file}: ${error.message}`);
    }
  } else {
    text = await readStdin();
  }
  const items = parseBatchItems(text);
  const globalBrief = wantsBrief();
  const globalFields = flags.get('fields')?.at(-1);
  const globalNoMeta = flags.has('no-meta');
  const allowedKeys = new Set(Object.keys(BATCH_SCHEMA.itemKeys));
  let failures = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const id = item !== null && typeof item === 'object' && (typeof item.id === 'string' || typeof item.id === 'number') ? item.id : index + 1;
    const started = Date.now();
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      failures += 1;
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: 'bad-item', message: 'batch item must be an object' } })}\n`);
      continue;
    }
    const unknown = Object.keys(item).filter((key) => !allowedKeys.has(key));
    if (unknown.length > 0) {
      failures += 1;
      const hint = unknown.map((key) => {
        if (key === 'view' || key === 'xmlid') return `${key} → xmlId`;
        if (key === 'q' || key === 'query') return `${key} is only valid for search-like actions`;
        return key;
      }).join(', ');
      process.stdout.write(`${JSON.stringify({ id, ok: false, ms: Date.now() - started, error: { code: 'unknown-item-key', message: `unknown batch item key(s): ${hint}; run "batch --schema" for the contract` } })}\n`);
      continue;
    }
    try {
      const argv = batchArgv(item);
      const out = await runCommand(engine, base, argv[0], argv.slice(1), batchFlags(item, flags));
      const brief = item.format === 'brief' || (item.format === undefined && globalBrief);
      const textOut = brief ? (out.builder ? builderBrief(out.result) : toBrief(out.cmd, out.result)) : null;
      const keepMeta = item.meta !== undefined ? item.meta !== false : !globalNoMeta;
      let result = out.result;
      if (textOut === null && !keepMeta) result = stripMeta(result);
      if (textOut === null) result = projectResult(result, projectionKeys(item.fields !== undefined ? item.fields : globalFields));
      const line = textOut === null
        ? { id, ok: true, ms: Date.now() - started, result }
        : { id, ok: true, ms: Date.now() - started, brief: textOut };
      process.stdout.write(`${JSON.stringify(line)}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`${JSON.stringify({ id, ok: false, ms: Date.now() - started, error: { code: error.code ?? 'failed', message: error.message } })}\n`);
    }
  }
  if (failures > 0) {
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({ failed: failures, total: items.length })}\n`);
  }
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('help') || pos.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return flags.has('help') ? undefined : Promise.reject(usage('no command'));
  }
  const one = (k) => flags.get(k)?.at(-1);
  const base = resolve(one('base') ?? process.env.ODOO_DC_BASE ?? process.cwd());
  const addons = [...(flags.get('addons') ?? []), ...(process.env.ODOO_DC_ADDONS ?? '').split(':').filter(Boolean)].map((p) => resolve(p));
  const engine = createEngine({ base, roots: addons, diskCache: !flags.has('no-cache'), includeData: flags.has('include-data') });
  const [cmd, ...args] = pos;
  if (cmd === 'batch') {
    if (flags.has('schema')) {
      process.stdout.write(`${JSON.stringify(BATCH_SCHEMA, null, 2)}\n`);
      return undefined;
    }
    await runBatch(engine, base, flags);
    return undefined;
  }
  return runCommand(engine, base, cmd, args, flags);
}

/** Short/qualified group id match for the acl filters. */
function groupMatches(xmlId, needle) {
  if (!needle) return true;
  const value = String(xmlId ?? '').toLowerCase();
  const wanted = String(needle).toLowerCase();
  return value === wanted || value.endsWith(`.${wanted}`) || value.includes(wanted);
}

/** Keep only ACL rows that match --group / --granted-to / --perm (omitted filters keep everything). */
function filterModelTrace(trace, one) {
  if (trace === null || typeof trace !== 'object' || !Array.isArray(trace.groups)) return trace;
  const group = one('group');
  const grantedTo = one('granted-to');
  const perm = String(one('perm') ?? '').toLowerCase().replace(/[^rwcu]/g, '');
  if (group === undefined && grantedTo === undefined && perm.length === 0) return trace;
  const ops = { r: 'read', w: 'write', c: 'create', u: 'unlink' };
  const groups = trace.groups.filter((row) => {
    const selfMatch = group === undefined || groupMatches(row.group, group);
    const grantMatch = grantedTo === undefined
      || groupMatches(row.group, grantedTo)
      || (row.grantedAlsoTo ?? []).some((granted) => groupMatches(granted, grantedTo));
    const permMatch = perm.length === 0 || [...perm].every((letter) => row.perms?.[ops[letter]] === true);
    return selfMatch && grantMatch && permMatch;
  });
  return { ...trace, groups, filters: { group: group ?? null, grantedTo: grantedTo ?? null, perm: perm || null } };
}

/**
 * Execute one read command against an existing engine.
 * @param {object} engine - engine facade.
 * @param {string} base - resolved base directory (builder version detection).
 * @param {string} cmd - command name.
 * @param {string[]} args - positional arguments.
 * @param {Map<string, string[]>} flags - parsed flags.
 * @returns {Promise<object>} `{ cmd, result }` (plus `builder` for builder commands).
 */
async function runCommand(engine, base, cmd, args, flags) {
  const one = (k) => flags.get(k)?.at(-1);

  const rootsPayload = await get(engine, 'action=roots');
  if (cmd === 'roots') return { cmd, result: rootsPayload };
  const allRoots = rootsPayload.roots ?? [];
  const want = one('root');
  let roots;
  if (want === undefined || want === 'all') roots = allRoots;
  else {
    const needle = want.toLowerCase();
    roots = allRoots.filter((r) => [r.id, r.label, r.path, r.kind].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)));
    if (roots.length > 1) roots = roots.slice(0, 1);
  }
  if (roots.length === 0) {
    const names = allRoots.map((r) => r.label).join(' | ');
    throw Object.assign(new Error(want === undefined ? `no addons root detected under ${base}; run it from an Odoo workspace or pass --base <dir> / set ODOO_DC_BASE` : `no root matches "${want}" (a module folder is not a root). Roots: ${names}`), { exitCode: 1, code: 'no-root' });
  }
  const picked = roots[0];
  const r = `root=${enc(picked.id)}`;
  const refresh = flags.has('refresh') ? '&refresh=1' : '';
  const need = (n, what) => { if (args.length < n) throw usage(`${cmd} needs ${what}`); };
  const limit = one('limit') === undefined ? '' : `&limit=${enc(one('limit'))}`;
  // Lookup commands try roots in order; an explicit --root (not "all") pins a single root.
  const lookup = want !== undefined && want !== 'all' ? [picked] : roots;
  const scopeParam = one('scope') === 'root' ? '&scope=root' : '';
  const wrap = (result) => ({ cmd, result });

  if (isBuilderCommand(cmd, args)) {
    const result = await runBuilder({
      cmd, args, one, all: (k) => flags.get(k) ?? [], has: (k) => flags.has(k), allRoots, base, get: (query) => get(engine, query),
    });
    return { cmd, result, builder: true };
  }

  switch (cmd) {
    case 'doctor': return wrap(await doctorReport(engine, allRoots, base, flags));
    case 'search': {
      need(1, '<query>');
      const query = args.join(' ');
      if (want === 'all') {
        const parts = [];
        for (const root of roots) parts.push(await searchRoot(engine, roots, root, query, one('type'), refresh));
        return wrap({ ...searchHealth(parts), items: parts.flatMap((p) => p.items ?? []), truncated: parts.some((p) => p.truncated), roots: roots.map((x) => x.label) });
      }
      const first = await searchRoot(engine, roots, picked, query, one('type'), refresh);
      if ((first.items ?? []).length === 0 && want === undefined && roots.length > 1) {
        const parts = [];
        for (const root of roots) parts.push(await searchRoot(engine, roots, root, query, one('type'), refresh));
        return wrap({ ...searchHealth(parts), items: parts.flatMap((p) => p.items ?? []), truncated: parts.some((p) => p.truncated), roots: roots.map((x) => x.label), fallback: true });
      }
      return wrap(first);
    }
    case 'view': {
      need(1, '<xmlId>');
      const { root, value } = await firstRootWith(lookup, `view ${args[0]}`, (x) => viewInRoot(engine, x, args[0]));
      const { views, reports, paperformats, ...file } = value.detail;
      return wrap({ root: root.label, file, view: slimView(value.view, flags.has('full')), actions: value.detail.actions });
    }
    case 'compose': {
      need(1, '<xmlId>');
      const { root, value } = await firstRootWith(lookup, `view ${args[0]}`, (x) => get(engine, `action=compose&root=${enc(x.id)}&xmlId=${enc(args[0])}&mode=${flags.has('all') ? 'all' : 'chain'}`));
      return wrap({ rootUsed: root.label, ...slimCompose(value, flags.has('full')) });
    }
    case 'related': {
      need(1, '<xmlId>');
      const { root, value } = await firstRootWith(lookup, `view ${args[0]}`, async (x) => {
        const rel = await get(engine, `action=related&root=${enc(x.id)}&xmlId=${enc(args[0])}${scopeParam}`);
        if (rel.target === null || rel.target === undefined) throw Object.assign(new Error(`view ${args[0]} not found in root ${x.label}`), { exitCode: 1, code: 'unknown-view' });
        return rel;
      });
      const owner = roots.find((candidate) => candidate.id === value.targetRootId) ?? root;
      return wrap({ rootUsed: owner.label, ...value });
    }
    case 'impact': need(1, '<xmlId>'); return wrap(await impact(engine, lookup, args[0]));
    case 'actions': {
      const query = args.join(' ');
      const fetchActions = (target) => get(engine, `action=actions&root=${enc(target.id)}&q=${enc(query)}${one('model') ? `&model=${enc(one('model'))}` : ''}${limit}`);
      const first = await fetchActions(picked);
      if ((first.items ?? []).length === 0 && want === undefined && roots.length > 1) {
        const items = [];
        let truncated = false;
        for (const target of roots) {
          const part = await fetchActions(target);
          items.push(...(part.items ?? []));
          if (part.truncated) truncated = true;
        }
        return wrap({ ...first, items, total: items.length, truncated, roots: roots.map((x) => x.label), fallback: true });
      }
      return wrap(first);
    }
    case 'action': {
      need(1, '<xmlId>');
      const { root, value } = await firstRootWith(lookup, `action ${args[0]}`, (x) => get(engine, `action=action&root=${enc(x.id)}&xmlId=${enc(args[0])}`));
      return wrap({ rootUsed: root.label, ...value });
    }
    case 'field': need(2, '<model> <field>'); return wrap(await fieldReport(engine, roots, args[0], args[1], flags));
    case 'pysearch': {
      need(1, '<query>');
      const query = args.join(' ');
      const fetchPy = (target) => get(engine, `action=pyindex&root=${enc(target.id)}&q=${enc(query)}${one('type') ? `&type=${enc(one('type'))}` : ''}${limit}${refresh}`);
      const first = await fetchPy(picked);
      if ((first.items ?? []).length === 0 && want === undefined && roots.length > 1) {
        const items = [];
        for (const target of roots) items.push(...((await fetchPy(target)).items ?? []));
        return wrap({ ...first, items, total: items.length, roots: roots.map((x) => x.label), fallback: true });
      }
      return wrap(first);
    }
    case 'pymodel': need(1, '<model>'); return wrap(await get(engine, `action=pymodel&${r}&model=${enc(args[0])}`));
    case 'pymethod': need(2, '<model> <name>'); return wrap(await get(engine, `action=pymethod&${r}&model=${enc(args[0])}&name=${enc(args[1])}${one('step') ? `&step=${enc(one('step'))}` : ''}`));
    case 'access': return wrap(await get(engine, `action=secindex&${r}&q=${enc(args.join(' '))}${one('type') ? `&type=${enc(one('type'))}` : ''}${limit}${scopeParam}${refresh}`));
    case 'group': need(1, '<xmlId>'); return wrap(await get(engine, `action=sectrace&${r}&kind=group&id=${enc(args[0])}${scopeParam}${refresh}`));
    case 'acl': {
      need(1, '<model>');
      const trace = await get(engine, `action=sectrace&${r}&kind=model&id=${enc(args[0])}${scopeParam}${refresh}`);
      return wrap(filterModelTrace(trace, one));
    }
    case 'gate': need(1, '<xmlId>'); return wrap(await get(engine, `action=sectrace&${r}&kind=artifact&id=${enc(args[0])}${scopeParam}${refresh}`));
    case 'get': need(1, '"<query string>"'); return wrap(await get(engine, `${args[0].includes('root=') ? '' : `${r}&`}${args[0]}`));
    default: throw usage(`unknown command ${cmd}`);
  }
}

/** @returns {string|undefined} value of --out, if given. */
function outPath() {
  const i = process.argv.indexOf('--out');
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** @returns {boolean} true when `--format brief` was given. */
function wantsBrief() {
  return formatChoice() === 'brief';
}

// A closed pipe (`| head`) is the reader's choice, not a failure.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

main().then((out) => {
  if (out === undefined) return;
  const format = formatChoice();
  const brief = format === 'brief' ? (out.builder ? builderBrief(out.result) : toBrief(out.cmd, out.result)) : null;
  const projected = projectResult(out.builder ? out.result : stripMetaForFlags(out.result), out.builder ? [] : cliProjection());
  const text = brief ?? (format === 'compact' ? `${JSON.stringify(projected)}\n` : `${JSON.stringify(projected, null, 2)}\n`);
  const target = outPath();
  if (target !== undefined) {
    writeFileSync(target, text);
    process.stdout.write(`${JSON.stringify({ wrote: target, bytes: text.length })}\n`);
  } else process.stdout.write(text);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.code ?? 'failed', message: error.message, status: error.status, ...(error.details ?? {}) })}\n`);
  process.exitCode = NOT_FOUND_CODES.has(error.code) ? 3 : error.exitCode ?? 1;
});

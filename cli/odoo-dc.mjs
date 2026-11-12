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
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EngineError, createEngine } from '../lib/engine.js';
import { BUILDER_BOOL_FLAGS, BUILDER_USAGE, builderBrief, isBuilderCommand, runBuilder } from './build.mjs';

const USAGE = `odoo-dc <command> [args] [--root <label|path|all>] [--addons <path>]... [--base <dir>] [--limit n] [--refresh] [--format brief]

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

Root selection: no --root = first root for search/actions/py*, and view/compose/related/impact/action
fall back through every root until the id is found. --root <text> = the one root whose label/path/
kind contains <text>. --root all = every root.
Roots default to discovery under --base (default $ODOO_DC_BASE, else the current directory);
--addons <path> (repeatable, or $ODOO_DC_ADDONS colon list) sets them explicitly.
--format brief prints one line per hit (search, actions, pysearch) or a short text report
(impact, field, builder). --full keeps wireframe trees (view, compose). --out file writes to a file.

${BUILDER_USAGE}`;

/** Read-only GET actions of the route. `save`, `folders` and POST-only actions are not listed. */
const READ_ACTIONS = new Set([
  'roots', 'index', 'file', 'module', 'report', 'pyindex', 'pymethod', 'pymodel', 'fields',
  'search', 'compose', 'related', 'actions', 'action', 'xpath', 'xpathbase', 'secindex', 'sectrace',
]);

/** Route error codes that mean "not in this root", so the next root may have it. */
const NOT_FOUND = new Set(['unknown-view', 'unknown-action-record', 'unknown-file', 'unknown-model']);

/** Perm letters for brief output: R W C D, `-` when absent. */
const permText = (p) => (p ? `${p.read ? 'R' : '-'}${p.write ? 'W' : '-'}${p.create ? 'C' : '-'}${p.unlink ? 'D' : '-'}` : '----');

/** @param {string[]} argv @returns {{ pos: string[], flags: Map<string, string[]> }} parsed args. */
function parseArgs(argv) {
  const pos = [];
  const flags = new Map();
  const bool = new Set(['refresh', 'all', 'full', 'help', ...BUILDER_BOOL_FLAGS]);
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

/** `impact`: all that a change to one view can affect. */
async function impact(engine, roots, xmlId) {
  const { root, value } = await firstRootWith(roots, `view ${xmlId}`, async (r) => {
    const rel = await get(engine, `action=related&root=${enc(r.id)}&xmlId=${enc(xmlId)}`);
    if (rel.target === null || rel.target === undefined) throw Object.assign(new Error(`view ${xmlId} not found in root ${r.label}`), { exitCode: 1, code: 'unknown-view' });
    return rel;
  });
  const [composed, own] = await Promise.all([
    get(engine, `action=compose&root=${enc(root.id)}&xmlId=${enc(xmlId)}&mode=all`),
    viewInRoot(engine, root, xmlId),
  ]);
  const skipped = composed.skipped ?? [];
  const warnings = [];
  if (skipped.length > 0 || composed.skippedTotal > 0) warnings.push(`compose skipped ${composed.skippedTotal ?? skipped.length} operation(s); inheritor content may be missing from the merged arch`);
  if (composed.complete !== true) warnings.push('compose reported complete=false');
  if (composed.truncated) warnings.push('compose was truncated');
  return {
    xmlId,
    root: root.label,
    model: value.target.model,
    type: value.target.type,
    file: `${value.target.file}:${value.target.line}`,
    parent: value.parent?.xmlId ?? null,
    directInheritors: (value.children ?? []).map((c) => c.xmlId),
    allInheritors: (composed.views ?? []).filter((v) => v.xmlId !== xmlId).map((v) => ({ xmlId: v.xmlId, module: v.module, priority: v.priority, file: v.file })),
    actions: (value.actions ?? []).map((a) => ({ xmlId: a.xmlId, name: a.name })),
    actionsTotal: value.actionsTotal ?? (value.actions ?? []).length,
    fields: own.view.fields ?? [],
    skipped,
    warnings,
  };
}

/** True when a flow field name is the field itself or a path through it (`order_line.price_total`). */
const touches = (name, field) => name === field || name.startsWith(`${field}.`);

/** `field`: where a model field is defined, shown and used. */
async function fieldReport(engine, roots, model, field, flags) {
  const num = (k, d) => { const v = Number.parseInt(flags.get(k)?.at(-1) ?? '', 10); return Number.isFinite(v) && v > 0 ? v : d; };
  const maxFiles = num('max-files', 60);
  const maxMethods = num('max-methods', 200);
  const first = roots[0];
  const pm = await get(engine, `action=pymodel&root=${enc(first.id)}&model=${enc(model)}`);
  const def = (pm.fields ?? []).find((f) => f.name === field);
  if (def === undefined) {
    const near = (pm.fields ?? []).map((f) => f.name).filter((n) => n.includes(field) || field.includes(n)).slice(0, 8);
    throw Object.assign(new Error(`field ${field} is not defined on ${model}${near.length > 0 ? ` (similar: ${near.join(', ')})` : ''}`), { exitCode: 1, code: 'unknown-field' });
  }

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

  // Methods: read the flow of each method of the model and keep those touching the field.
  const methods = [];
  const methodErrors = [];
  const names = [...new Set((pm.methods ?? []).map((m) => m.name))];
  const methodsTruncated = names.length > maxMethods;
  for (const name of names.slice(0, maxMethods)) {
    try {
      const m = await get(engine, `action=pymethod&root=${enc(first.id)}&model=${enc(model)}&name=${enc(name)}`);
      const roles = new Set();
      for (const f of m.flow?.fields ?? []) if (touches(f.name, field)) roles.add(f.source === 'depends' ? 'depends' : 'read');
      for (const w of m.flow?.outputs?.writes ?? []) if (touches(w.name, field)) roles.add('write');
      if (roles.size > 0) {
        const step = m.chain?.[(m.selectedStep ?? 1) - 1] ?? m.chain?.[0];
        methods.push({ name, roles: [...roles], module: step?.module, file: step ? `${step.file}:${step.line}` : undefined });
      }
    } catch (error) {
      methodErrors.push({ method: name, error: error.message });
    }
  }

  const warnings = [];
  if (viewsTruncated) warnings.push(`view search truncated (max ${maxFiles} files); raise --max-files`);
  if (methodsTruncated) warnings.push(`only ${maxMethods} of ${names.length} methods analysed; raise --max-methods`);
  warnings.push('method roles come from static flow analysis (no dynamic access, no helper following)');
  return {
    model,
    field,
    definition: { fieldType: def.fieldType, comodel: def.comodel, string: def.string, attrs: def.attrs, module: def.module, file: `${def.file}:${def.line}`, definitions: def.definitions },
    computeMethod: def.attrs?.compute ?? null,
    views,
    methods,
    errors: [...viewErrors, ...methodErrors],
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
    lines.push(`inheritors (${r.allInheritors.length}, direct ${r.directInheritors.length}): ${r.allInheritors.map((v) => v.xmlId).join(', ') || '-'}`);
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
    for (const e of r.errors) lines.push(`ERROR ${e.file ?? e.method}: ${e.error}`);
    for (const w of r.warnings) lines.push(`WARNING ${w}`);
  } else if (cmd === 'access') {
    for (const i of r.items ?? []) lines.push([i.kind === 'artifact' ? i.artifact : i.kind, i.id, i.name !== i.id ? i.name : '', i.detail].join('\t'));
    if (r.truncated) lines.push(`… ${r.total} total`);
    for (const e of r.errors ?? []) lines.push(`ISSUE ${e.file}:${e.line} ${e.message}`);
  } else if (cmd === 'group') {
    lines.push(`${r.group.xmlId}  ${r.group.name}  ${r.group.file}:${r.group.line}`);
    lines.push(`includes (${r.includes.length}): ${r.includes.map((g) => g.xmlId).join(', ') || '-'}`);
    lines.push(`included by (${r.includedBy.length}): ${r.includedBy.map((g) => g.xmlId).join(', ') || '-'}`);
    lines.push(`models (${r.models.length}):`);
    for (const m of r.models) lines.push(`  ${m.model}\t${permText(m)}`);
    lines.push(`rules (${r.rules.direct.length} direct, ${r.rules.inherited.length} inherited):`);
    for (const x of [...r.rules.direct, ...r.rules.inherited]) lines.push(`  ${x.xmlId}\t${x.modelKey}\t${permText(x.perms)}\t${x.domain}`);
    lines.push(`gates (${r.gates.length}):`);
    for (const g of r.gates) lines.push(`  ${g.kind}\t${g.owner}${g.tag ? ` <${g.tag}>` : ''}${g.negated ? ' (excluded)' : ''}\t${g.file}:${g.line}`);
    for (const w of r.warnings) lines.push(`WARNING ${w.message}`);
  } else if (cmd === 'acl') {
    lines.push(`${r.model}  (${r.key})`);
    lines.push(`acl (${r.groups.length}):`);
    for (const g of r.groups) lines.push(`  ${g.global ? '(everyone)' : g.group}\t${permText(g.perms)}${g.grantedAlsoTo.length ? `\talso (${g.grantedAlsoTo.length}): ${g.grantedAlsoTo.slice(0, 5).join(', ')}${g.grantedAlsoTo.length > 5 ? ', …' : ''}` : ''}`);
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

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('help') || pos.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return flags.has('help') ? undefined : Promise.reject(usage('no command'));
  }
  const one = (k) => flags.get(k)?.at(-1);
  const base = resolve(one('base') ?? process.env.ODOO_DC_BASE ?? process.cwd());
  const addons = [...(flags.get('addons') ?? []), ...(process.env.ODOO_DC_ADDONS ?? '').split(':').filter(Boolean)].map((p) => resolve(p));
  const engine = createEngine({ base, roots: addons });
  const [cmd, ...args] = pos;

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
    case 'search': {
      need(1, '<query>');
      if (want === 'all') {
        const parts = [];
        for (const root of roots) parts.push(await searchRoot(engine, roots, root, args.join(' '), one('type'), refresh));
        return wrap({ items: parts.flatMap((p) => p.items ?? []), truncated: parts.some((p) => p.truncated), roots: roots.map((x) => x.label) });
      }
      return wrap(await searchRoot(engine, roots, picked, args.join(' '), one('type'), refresh));
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
        const rel = await get(engine, `action=related&root=${enc(x.id)}&xmlId=${enc(args[0])}`);
        if (rel.target === null || rel.target === undefined) throw Object.assign(new Error(`view ${args[0]} not found in root ${x.label}`), { exitCode: 1, code: 'unknown-view' });
        return rel;
      });
      return wrap({ rootUsed: root.label, ...value });
    }
    case 'impact': need(1, '<xmlId>'); return wrap(await impact(engine, lookup, args[0]));
    case 'actions': return wrap(await get(engine, `action=actions&${r}&q=${enc(args.join(' '))}${one('model') ? `&model=${enc(one('model'))}` : ''}${limit}`));
    case 'action': {
      need(1, '<xmlId>');
      const { root, value } = await firstRootWith(lookup, `action ${args[0]}`, (x) => get(engine, `action=action&root=${enc(x.id)}&xmlId=${enc(args[0])}`));
      return wrap({ rootUsed: root.label, ...value });
    }
    case 'field': need(2, '<model> <field>'); return wrap(await fieldReport(engine, roots, args[0], args[1], flags));
    case 'pysearch': need(1, '<query>'); return wrap(await get(engine, `action=pyindex&${r}&q=${enc(args.join(' '))}${one('type') ? `&type=${enc(one('type'))}` : ''}${limit}${refresh}`));
    case 'pymodel': need(1, '<model>'); return wrap(await get(engine, `action=pymodel&${r}&model=${enc(args[0])}`));
    case 'pymethod': need(2, '<model> <name>'); return wrap(await get(engine, `action=pymethod&${r}&model=${enc(args[0])}&name=${enc(args[1])}${one('step') ? `&step=${enc(one('step'))}` : ''}`));
    case 'access': return wrap(await get(engine, `action=secindex&${r}&q=${enc(args.join(' '))}${one('type') ? `&type=${enc(one('type'))}` : ''}${limit}${scopeParam}${refresh}`));
    case 'group': need(1, '<xmlId>'); return wrap(await get(engine, `action=sectrace&${r}&kind=group&id=${enc(args[0])}${scopeParam}${refresh}`));
    case 'acl': need(1, '<model>'); return wrap(await get(engine, `action=sectrace&${r}&kind=model&id=${enc(args[0])}${scopeParam}${refresh}`));
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
  const i = process.argv.indexOf('--format');
  if (i < 0) return false;
  const value = process.argv[i + 1];
  if (value !== 'brief' && value !== 'json') throw usage('--format must be brief or json');
  return value === 'brief';
}

// A closed pipe (`| head`) is the reader's choice, not a failure.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

main().then((out) => {
  if (out === undefined) return;
  const brief = wantsBrief() ? (out.builder ? builderBrief(out.result) : toBrief(out.cmd, out.result)) : null;
  const text = brief ?? `${JSON.stringify(out.result, null, 2)}\n`;
  const target = outPath();
  if (target !== undefined) {
    writeFileSync(target, text);
    process.stdout.write(`${JSON.stringify({ wrote: target, bytes: text.length })}\n`);
  } else process.stdout.write(text);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.code ?? 'failed', message: error.message, status: error.status, ...(error.details ?? {}) })}\n`);
  process.exitCode = error.exitCode ?? 1;
});

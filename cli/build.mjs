/**
 * Builder subcommands of odoo-dc: `module new`, `model new`, `view new`, `access add`, `build`.
 *
 * The only CLI commands that write. Dry-run by default (plan + diff, exit 0); `--apply` writes
 * through `lib/builder_apply.js` (custom roots only, no overwrite, `.bak` + atomic rename,
 * rollback on a midway failure). Plan errors exit 1 with every error listed; nothing is written.
 */
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import {
  BuilderError, FIELD_PRESETS, buildPlan, detectOdooVersion, expandPresets, parseAccessToken, parseFieldToken,
} from '../lib/builder.js';
import {
  ApplyError, applyPlan, assertWritableTarget, dependsClosure, lineDiff, locateModule, moduleXmlIds, readPlanContext,
} from '../lib/builder_apply.js';

export const BUILDER_USAGE = `Builder (writes only with --apply; default is a dry-run plan with diffs):
  module new <name> --into <addons dir> [--depends base,mail] [--summary s] [--category c] [--application]
  model new <module> <model.name> --field name:char:required [--field partner_id:many2one:res.partner]...
        [--field 'state:selection:draft=Draft|done=Done']   (quote tokens that contain |)
        [--preset ${Object.keys(FIELD_PRESETS).join(',')}]   (common fields without tokens; combine with --field)
        [--views form,list,search] [--description d] [--menu "Label"] [--menu-parent module.menu_root]
        [--access base.group_user:rwcd]... [--no-access] [--no-action] [--create-module --into <dir> --depends ...]
  view new <module> <model> --type form|list|search [--type ...] [--fields a,b,c]
        (fields limited to the module's depends; required when more than 20 are reachable)
  view new <module> --inherit <xmlId> [--expr <xpath>] [--position inside|after|before|replace]
        [--id <record id>] [--fields a,b]   (extension view; model and type come from the index)
  access add <module> <model> <group|-> <rwcd>
  build --spec spec.json [--into <dir>]
    common: --apply  --odoo-version n  --into <addons dir> (default: where <module> is found)  --no-backup
    field token: name:type[:comodel[:inverse]|:a=A|b=B][:required][:readonly][:index][:default=value]`;

/** Boolean flags the builder adds to the CLI parser. */
export const BUILDER_BOOL_FLAGS = ['apply', 'application', 'no-action', 'no-access', 'create-module', 'no-backup'];

/**
 * Is this invocation a builder command?
 * @param {string} cmd - first positional.
 * @param {string[]} args - remaining positionals.
 * @returns {boolean} true for builder commands.
 */
export function isBuilderCommand(cmd, args) {
  if (cmd === 'build') return true;
  if ((cmd === 'module' || cmd === 'model') && args[0] === 'new') return true;
  if (cmd === 'view' && args[0] === 'new' && args.length >= 2) return true;
  return cmd === 'access' && args[0] === 'add';
}

const usageError = (message) => Object.assign(new Error(message), { exitCode: 2, code: 'usage' });

/** Wrap token parse errors as usage errors. */
function tokens(list, parse) {
  try {
    return list.map(parse);
  } catch (error) {
    if (error instanceof BuilderError) throw usageError(error.message);
    throw error;
  }
}

/**
 * Turn CLI arguments into a builder spec.
 * @param {string} cmd - command.
 * @param {string[]} args - positionals after the command.
 * @param {(key: string) => string | undefined} one - last value of a flag.
 * @param {(key: string) => string[]} all - every value of a flag.
 * @param {(key: string) => boolean} has - boolean flag present.
 * @returns {Promise<object>} spec.
 */
async function specFrom(cmd, args, one, all, has) {
  const list = (key) => all(key).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const moduleOpts = () => ({
    depends: list('depends').length > 0 ? list('depends') : ['base'],
    summary: one('summary'), category: one('category'), name: one('name'), application: has('application'),
  });
  if (cmd === 'build') {
    const path = one('spec');
    if (path === undefined) throw usageError('build needs --spec <file.json>');
    try {
      return JSON.parse(await readFile(resolve(path), 'utf8'));
    } catch (error) {
      throw Object.assign(new Error(`--spec ${path}: ${error.message}`), { exitCode: 2, code: 'bad-spec' });
    }
  }
  if (cmd === 'module') {
    if (args.length < 2) throw usageError('module new needs <name>');
    return { module: args[1], createModule: moduleOpts() };
  }
  if (cmd === 'model') {
    if (args.length < 3) throw usageError('model new needs <module> <model.name>');
    const fields = [...tokens([list('preset')], (names) => expandPresets(names)).flat(), ...tokens(all('field'), parseFieldToken)];
    const menuName = one('menu');
    const menuParent = one('menu-parent');
    const model = {
      name: args[2],
      fields,
      views: list('views').length > 0 ? list('views') : undefined,
      description: one('description'),
      action: !has('no-action'),
      menu: menuName === undefined && menuParent === undefined ? false : { name: menuName, parent: menuParent },
      access: has('no-access') ? [] : (all('access').length > 0 ? tokens(all('access'), parseAccessToken) : undefined),
    };
    return { module: args[1], ...(has('create-module') ? { createModule: moduleOpts() } : {}), models: [model] };
  }
  if (cmd === 'view') {
    const inherit = one('inherit');
    if (inherit !== undefined) {
      if (inherit.length === 0) throw usageError('--inherit needs a view xml id');
      return {
        module: args[1],
        views: [{
          inherit,
          model: '',
          expr: one('expr'),
          position: one('position'),
          id: one('id'),
          fields: list('fields'),
        }],
      };
    }
    const types = list('type');
    if (types.length === 0) throw usageError('view new needs --type form|list|search, or --inherit <xmlId>');
    const fields = list('fields');
    return { module: args[1], views: types.map((type) => ({ model: args[2], type, ...(fields.length > 0 ? { fields } : {}) })) };
  }
  if (args.length < 5) throw usageError('access add needs <module> <model> <group|-> <rwcd>');
  return { module: args[1], access: [{ model: args[2], group: args[3] === '-' ? '' : args[3], perms: args[4] }] };
}

/** A root the builder may write to (predicate form of `assertWritableTarget`). */
function isWritableRoot(root, allRoots) {
  try {
    assertWritableTarget(root.path, allRoots);
    return true;
  } catch (error) {
    if (error instanceof ApplyError) return false; // dt:escape the guard's refusal is the answer here
    throw error;
  }
}

/** Every model name the spec touches (to look up in the Python index). */
function modelsOf(spec) {
  const names = new Set();
  for (const model of spec.models ?? []) {
    if (typeof model?.name === 'string') names.add(model.name);
    for (const field of model?.fields ?? []) {
      const comodel = typeof field === 'string' ? field.split(':')[2] : field?.comodel;
      if (typeof comodel === 'string' && comodel.includes('.')) names.add(comodel);
    }
  }
  for (const entry of [...(spec.views ?? []), ...(spec.access ?? [])]) if (typeof entry?.model === 'string') names.add(entry.model);
  return [...names];
}

/** Odoo major version: --odoo-version, else release.py under the workspace or base. */
async function odooVersion(one, dirs) {
  const flag = one('odoo-version');
  if (flag !== undefined) {
    const value = Number(flag);
    if (!Number.isInteger(value)) throw usageError('--odoo-version must be an integer');
    return { version: value, source: '--odoo-version' };
  }
  for (const dir of dirs.filter(Boolean)) {
    for (const rel of ['odoo/odoo/release.py', 'odoo/release.py']) {
      try {
        const version = detectOdooVersion(await readFile(join(dir, rel), 'utf8'));
        if (version !== undefined) return { version, source: join(dir, rel) };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  throw Object.assign(new Error(`Cannot find odoo/odoo/release.py under ${dirs.filter(Boolean).join(' or ')}; pass --odoo-version`), { exitCode: 1, code: 'unknown-version' });
}

/**
 * Run a builder command.
 * @param {object} env - `{ cmd, args, one, all, has, allRoots, base, get }` from the CLI main.
 * @returns {Promise<object>} result for JSON / brief output.
 */
export async function runBuilder(env) {
  const { cmd, args, one, all, has, allRoots, base, get } = env;
  const spec = await specFrom(cmd, args, one, all, has);
  const module = spec?.module;
  if (typeof module !== 'string' || module.length === 0) throw usageError('the spec needs a module name');

  let addonsDir;
  if (one('into') !== undefined) addonsDir = resolve(one('into'));
  else if (spec.createModule) throw usageError('a new module needs --into <addons dir> (e.g. a custom-addons collection folder)');
  else {
    const writable = allRoots.filter((root) => isWritableRoot(root, allRoots));
    const found = await locateModule(writable, module);
    if (found.length === 0) throw Object.assign(new Error(`module ${module} not found in a custom root; pass --into <dir> or create it (module new / --create-module)`), { exitCode: 1, code: 'unknown-module' });
    if (found.length > 1) throw Object.assign(new Error(`module ${module} exists in several places, pick one with --into: ${found.join(', ')}`), { exitCode: 1, code: 'ambiguous-module' });
    addonsDir = found[0];
  }
  const root = assertWritableTarget(addonsDir, allRoots);
  for (const view of spec.views ?? []) {
    if (typeof view?.inherit !== 'string' || view.inherit.length === 0) continue;
    let payload;
    try {
      payload = await get(`action=related&xmlId=${encodeURIComponent(view.inherit)}&root=${encodeURIComponent(root.id)}`);
    } catch (error) {
      if (error.code === 'unknown-view') {
        throw Object.assign(new Error(`inherit target ${view.inherit} is not in the view index`), { exitCode: 3, code: 'unknown-view' });
      }
      throw error;
    }
    if (payload.target === null || payload.target === undefined) {
      throw Object.assign(new Error(`inherit target ${view.inherit} is not in the view index`), { exitCode: 3, code: 'unknown-view' });
    }
    view.model = payload.target.model;
    view.targetType = payload.target.type;
  }
  const warnings = [];
  const collection = relative(root.path, addonsDir).split(/[/\\]/)[0];
  const folder = (root.subfolders ?? []).find((entry) => entry.name === collection);
  if (root.hasConf && folder !== undefined && folder.inConf === false) warnings.push(`${addonsDir} is not in the addons_path of the workspace .conf; Odoo will not see this module`);

  const { version, source: versionSource } = await odooVersion(one, [root.workspace, base]);
  const existing = await readPlanContext(addonsDir, spec);
  const xmlIds = await moduleXmlIds(join(addonsDir, module), module);
  const models = new Map();
  for (const name of modelsOf(spec)) {
    try {
      const payload = await get(`action=pymodel&root=${encodeURIComponent(root.id)}&model=${encodeURIComponent(name)}`);
      models.set(name, {
        module: payload.modules?.[0],
        mixins: payload.mixins ?? [],
        fields: (payload.fields ?? []).map((field) => ({ name: field.name, type: String(field.fieldType ?? '').toLowerCase(), string: field.string, module: field.module, modules: field.modules, definitions: field.definitions })),
      });
    } catch (error) {
      if (error.code !== 'unknown-model') throw error;
    }
  }

  const closure = await dependsClosure(allRoots, spec, existing);
  const plan = buildPlan(spec, { version, existing, xmlIds, models, dependsClosure: closure });
  if (!plan.ok) {
    throw Object.assign(new Error(plan.errors.map((error) => `${error.code}: ${error.message}`).join(' | ')), {
      exitCode: 1, code: 'plan-failed', details: { errors: plan.errors, warnings: [...warnings, ...plan.warnings] },
    });
  }
  const files = plan.files.map((file) => (file.op === 'create'
    ? { op: 'create', path: file.path, lines: file.after.split('\n').length - 1, after: file.after }
    : { op: 'patch', path: file.path, diff: lineDiff(file.before, file.after).filter((line) => !line.startsWith(' ')) }));
  const result = { mode: has('apply') ? 'applied' : 'dry-run', module, addonsDir, root: root.label, odooVersion: version, versionSource, warnings: [...warnings, ...plan.warnings], files };
  if (has('apply')) {
    try {
      result.written = await applyPlan(addonsDir, plan, { backup: !has('no-backup') });
    } catch (error) {
      if (error instanceof ApplyError) throw Object.assign(error, { details: { written: error.written, rollbackErrors: error.rollbackErrors } });
      throw error;
    }
  } else {
    result.next = 'dry-run only: re-run with --apply to write these files';
  }
  return result;
}

/**
 * Text report of a builder result.
 * @param {object} r - result of `runBuilder`.
 * @returns {string} brief text.
 */
export function builderBrief(r) {
  const out = [`${r.mode}  ${r.module}  Odoo ${r.odooVersion} (${r.versionSource})  ${r.addonsDir}`];
  for (const warning of r.warnings) out.push(`WARNING ${warning}`);
  for (const file of r.files) {
    if (file.op === 'create') out.push(`create  ${file.path}  (${file.lines} lines)`);
    else out.push(`patch   ${file.path}`, ...file.diff.map((line) => `        ${line}`));
  }
  if (r.written !== undefined) out.push(`wrote ${r.written.created.length} new, ${r.written.patched.length} patched, ${r.written.backups.length} .bak`);
  if (r.next !== undefined) out.push(r.next);
  return `${out.join('\n')}\n`;
}

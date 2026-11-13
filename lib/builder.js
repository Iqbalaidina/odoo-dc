/**
 * Module builder: turn a spec (module, models, fields, views, access rows) into a
 * file plan for an Odoo addon.
 *
 * Pure functions, no I/O. The caller (Host route or CLI) asks `plannedPaths(spec)`
 * which files to read, passes their current text in `ctx.existing`, and gets back
 * `{ ok, files, warnings, errors }`. Each file is `create` (must not exist) or
 * `patch` (with `before` text so the writer can refuse a concurrent change).
 *
 * Failure path: fail fast. Any error empties `files`; nothing is half-planned.
 * Warnings never block (missing `name` field, unknown comodel, naming conventions).
 *
 * // divergent-strategy: `__manifest__.py` and `__init__.py` are patched textually
 * // (no Python AST in Node). A manifest whose `data` list cannot be located safely
 * // is an error (`manifest-unparsable`) with the lines to add by hand.
 */

const MODULE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MODEL_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,62}$/;
const XMLID_RE = /^[a-z0-9_]+\.[A-Za-z0-9_.]+$/;
const RESERVED_FIELDS = new Set(['id', 'create_uid', 'create_date', 'write_uid', 'write_date', 'display_name', '__last_update']);
const RELATIONAL = new Set(['many2one', 'one2many', 'many2many']);
const FIELD_CLASS = {
  char: 'Char', text: 'Text', html: 'Html', integer: 'Integer', float: 'Float', monetary: 'Monetary',
  boolean: 'Boolean', date: 'Date', datetime: 'Datetime', selection: 'Selection', binary: 'Binary',
  many2one: 'Many2one', one2many: 'One2many', many2many: 'Many2many',
};
const FIELD_FLAGS = new Set(['required', 'readonly', 'index']);
const VIEW_TYPES = new Set(['form', 'list', 'search']);
const PERM_RE = /^[r-][w-][c-][d-]$/;
const ACCESS_HEADER = 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink';
/** Field types that read badly as a list column or a form `<group>` cell. */
const WIDE_TYPES = new Set(['one2many', 'many2many', 'html', 'text', 'binary']);
const MAX_LIST_COLUMNS = 6;
const MAX_DEFAULT_VIEW_FIELDS = 20;

/**
 * Odoo major version from the text of `odoo/release.py`.
 * @param {string} text - release.py contents.
 * @returns {number | undefined} major version, or undefined when absent.
 */
export function detectOdooVersion(text) {
  const match = /^version_info\s*=\s*\(\s*(?:'saas~)?(\d+)/m.exec(String(text ?? ''));
  return match === null ? undefined : Number(match[1]);
}

/**
 * Version-dependent syntax.
 * @param {number} major - Odoo major version.
 * @returns {{ major: number, listTag: string, viewMode: string }} profile.
 */
export function versionProfile(major) {
  if (!Number.isInteger(major) || major < 10 || major > 40) throw new BuilderError('bad-version', `Unsupported Odoo version: ${major}`);
  const listTag = major >= 17 ? 'list' : 'tree';
  return { major, listTag, viewMode: `${listTag},form` };
}

/** Error with a stable code, for usage-level failures (bad version, bad token). */
export class BuilderError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Parse a CLI field token: `name:type[:comodel[:inverse]|:a=A|b=B][:required][:readonly][:index]`.
 * @param {string} token - e.g. `partner_id:many2one:res.partner:required`.
 * @returns {object} field spec.
 */
export function parseFieldToken(token) {
  const parts = String(token).split(':');
  if (parts.length < 2) throw new BuilderError('bad-field', `Field "${token}" needs name:type`);
  const [name, type, ...rest] = parts;
  const field = { name, type: type.toLowerCase() };
  if (RELATIONAL.has(field.type)) {
    if (rest.length === 0 || FIELD_FLAGS.has(rest[0])) throw new BuilderError('bad-field', `Field "${token}" needs a comodel (name:${type}:res.partner)`);
    field.comodel = rest.shift();
    if (field.type === 'one2many') {
      if (rest.length === 0 || FIELD_FLAGS.has(rest[0])) throw new BuilderError('bad-field', `Field "${token}" needs an inverse field (name:one2many:comodel:inverse_id)`);
      field.inverse = rest.shift();
    }
  } else if (field.type === 'selection') {
    if (rest.length === 0 || FIELD_FLAGS.has(rest[0])) throw new BuilderError('bad-field', `Field "${token}" needs values (state:selection:draft=Draft|done=Done)`);
    field.selection = rest.shift().split('|').map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? [pair, labelOf(pair)] : [pair.slice(0, at), pair.slice(at + 1)];
    });
  }
  for (const flag of rest) {
    if (flag.startsWith('default=')) { field.default = flag.slice('default='.length); continue; }
    if (!FIELD_FLAGS.has(flag)) throw new BuilderError('bad-field', `Field "${token}": unknown flag "${flag}" (required, readonly, index, default=value)`);
    field[flag] = true;
  }
  return field;
}

/**
 * Inverse of `parseFieldToken`, for a text view of form rows. Undefined when the field
 * cannot be written as a token (a selection key/label or default containing `:` or `|`).
 * @param {object} field - field object.
 * @returns {string | undefined} token.
 */
export function fieldToToken(field) {
  const parts = [field.name, field.type];
  const plain = (value) => !/[:|\n]/.test(String(value));
  if (RELATIONAL.has(field.type)) parts.push(field.comodel);
  if (field.type === 'one2many') parts.push(field.inverse);
  if (field.type === 'selection') {
    if (!(field.selection ?? []).every(([key, label]) => plain(key) && plain(label) && !String(key).includes('='))) return undefined;
    parts.push(field.selection.map(([key, label]) => (label === labelOf(key) ? key : `${key}=${label}`)).join('|'));
  }
  for (const flag of FIELD_FLAGS) if (field[flag]) parts.push(flag);
  if (field.default !== undefined) {
    if (!plain(field.default)) return undefined;
    parts.push(`default=${field.default}`);
  }
  return parts.some((part) => part === undefined || part === '') ? undefined : parts.join(':');
}

/** Common fields, by preset name (`--preset name,partner,state`, panel quick chips). */
export const FIELD_PRESETS = Object.freeze({
  name: [{ name: 'name', type: 'char', required: true }],
  partner: [{ name: 'partner_id', type: 'many2one', comodel: 'res.partner' }],
  company: [{ name: 'company_id', type: 'many2one', comodel: 'res.company' }],
  user: [{ name: 'user_id', type: 'many2one', comodel: 'res.users' }],
  state: [{ name: 'state', type: 'selection', selection: [['draft', 'Draft'], ['confirmed', 'Confirmed'], ['done', 'Done'], ['cancel', 'Cancelled']], default: 'draft' }],
  date: [{ name: 'date', type: 'date' }],
  amount: [{ name: 'currency_id', type: 'many2one', comodel: 'res.currency' }, { name: 'amount', type: 'monetary' }],
  active: [{ name: 'active', type: 'boolean', default: 'True' }],
  sequence: [{ name: 'sequence', type: 'integer', default: '10' }],
  note: [{ name: 'note', type: 'text' }],
});

/**
 * Field objects for preset names (copies, safe to edit).
 * @param {string[]} names - preset names.
 * @returns {object[]} fields.
 */
export function expandPresets(names) {
  return names.flatMap((name) => {
    const preset = FIELD_PRESETS[name];
    if (preset === undefined) throw new BuilderError('bad-preset', `Unknown preset "${name}" (${Object.keys(FIELD_PRESETS).join(', ')})`);
    return preset.map((field) => structuredClone(field));
  });
}

/**
 * Whether each field of an existing model can be used from a module, given the module's
 * depends closure: `yes` (some definer is in it), `no`, or `maybe` (older index with only
 * the last definer, redefined elsewhere). Shared by `buildPlan` and the panel's field list.
 * @param {object[]} fields - `{ name, type, module?, modules?, definitions? }`.
 * @param {Set<string> | undefined} closure - depends closure (undefined = unknown: all `yes`).
 * @returns {object[]} fields with `type` lowercased and `reach`.
 */
export function classifyFields(fields, closure) {
  const reach = (field) => {
    if (closure === undefined) return 'yes';
    if (Array.isArray(field.modules) && field.modules.length > 0) return field.modules.some((name) => closure.has(name)) ? 'yes' : 'no';
    if (field.module === undefined || closure.has(field.module)) return 'yes';
    return (field.definitions ?? 1) > 1 ? 'maybe' : 'no';
  };
  return fields.map((field) => ({ ...field, type: String(field.type ?? '').toLowerCase(), reach: reach(field) }));
}

/**
 * Everything a form needs to build specs without typing tokens.
 * @returns {object} field types, flags, presets, view types, limits.
 */
export function builderMeta() {
  return {
    fieldTypes: Object.keys(FIELD_CLASS).map((type) => ({
      type,
      needsComodel: RELATIONAL.has(type),
      needsInverse: type === 'one2many',
      needsSelection: type === 'selection',
      nameSuffix: type === 'many2one' ? '_id' : (type === 'one2many' || type === 'many2many' ? '_ids' : ''),
      wide: WIDE_TYPES.has(type),
    })),
    flags: [...FIELD_FLAGS],
    presets: Object.fromEntries(Object.entries(FIELD_PRESETS).map(([key, fields]) => [key, structuredClone(fields)])),
    viewTypes: [...VIEW_TYPES],
    reservedFields: [...RESERVED_FIELDS],
    namePattern: FIELD_RE.source,
    modelPattern: MODEL_RE.source,
    maxDefaultViewFields: MAX_DEFAULT_VIEW_FIELDS,
  };
}

/**
 * Parse an access token `group:rwcd` (`-` for a missing right; empty group = all users).
 * @param {string} token - e.g. `base.group_user:rwc-`.
 * @returns {{ group: string, perms: string }} access spec.
 */
export function parseAccessToken(token) {
  const at = String(token).lastIndexOf(':');
  if (at < 0) throw new BuilderError('bad-access', `Access "${token}" needs group:rwcd`);
  return { group: token.slice(0, at), perms: token.slice(at + 1) };
}

/** `library_book` → `Library Book`. */
function labelOf(name) {
  return name.replace(/_ids?$/, '').split(/[_.]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

/** `library.book` → `LibraryBook`. */
function classOf(model) {
  return model.split(/[._]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

/** `library.book` → `library_book`. */
const underscored = (model) => model.replaceAll('.', '_');

/** Root arch tag per target view type; templates are edited by hand. */
const VIEW_ROOT_TAGS = {
  form: 'form', list: 'list', tree: 'tree', search: 'search', kanban: 'kanban',
  calendar: 'calendar', graph: 'graph', pivot: 'pivot', activity: 'activity',
};

/** Positions that make sense for an empty/scaffolded xpath. */
const VIEW_POSITIONS = new Set(['inside', 'after', 'before', 'replace']);

/** Python single-quoted string literal. */
function py(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`;
}

/** XML attribute / text escape. */
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** CSV cell (quoted only when needed). */
function csv(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Files the builder may read for this spec (paths relative to the addons root).
 * @param {object} spec - builder spec.
 * @returns {string[]} relative paths.
 */
export function plannedPaths(spec) {
  const module = spec?.module ?? '';
  const paths = new Set([`${module}/__init__.py`, `${module}/__manifest__.py`, `${module}/models/__init__.py`, `${module}/security/ir.model.access.csv`]);
  for (const model of spec?.models ?? []) {
    paths.add(`${module}/models/${underscored(model.name ?? '')}.py`);
    paths.add(`${module}/views/${underscored(model.name ?? '')}_views.xml`);
  }
  for (const view of spec?.views ?? []) {
    if (typeof view?.inherit === 'string' && view.inherit.length > 0) paths.add(`${module}/views/${underscored(view.inherit)}_inherit.xml`);
    else paths.add(`${module}/views/${underscored(view.model ?? '')}_views.xml`);
  }
  return [...paths];
}

/**
 * Build the file plan.
 * @param {object} spec - `{ module, createModule?, models?, views?, access? }`.
 * @param {object} ctx - `{ version, existing: {[path]: text}, xmlIds?: Set, models?: Map<name, {module, fields}> }`.
 * @returns {{ ok: boolean, version: number, files: object[], warnings: string[], errors: object[] }} plan.
 */
export function buildPlan(spec, ctx) {
  const errors = [];
  const warnings = [];
  const fail = (code, message) => {
    if (!errors.some((error) => error.code === code && error.message === message)) errors.push({ code, message });
  };
  const profile = versionProfile(ctx?.version);
  const existing = ctx?.existing ?? {};
  const xmlIds = ctx?.xmlIds ?? new Set();
  const knownModels = ctx?.models ?? new Map();
  // Modules the target module may rely on (itself + transitive depends); undefined = unknown, no filtering.
  const closure = ctx?.dependsClosure;
  const work = new Map();
  const read = (path) => (work.has(path) ? work.get(path) : existing[path]);
  const write = (path, text) => work.set(path, text);
  const createOnly = (path, text) => {
    if (existing[path] !== undefined) fail('file-exists', `${path} already exists; the builder never overwrites a file`);
    else if (work.has(path)) fail('file-conflict', `${path} is generated twice by this spec`);
    else write(path, text);
  };
  const newIds = new Set();
  const claimId = (module, id) => {
    const full = `${module}.${id}`;
    if (xmlIds.has(full) || newIds.has(full)) fail('duplicate-xml-id', `xml id ${full} already exists`);
    newIds.add(full);
    return id;
  };

  const module = spec?.module;
  if (typeof module !== 'string' || !MODULE_RE.test(module)) {
    fail('bad-module', `Module name "${module}" must be lowercase letters, digits and underscores`);
    return result();
  }
  const manifestPath = `${module}/__manifest__.py`;

  if (spec.createModule !== undefined && spec.createModule !== false) {
    const opts = spec.createModule === true ? {} : spec.createModule;
    const depends = opts.depends ?? ['base'];
    for (const dep of depends) if (!MODULE_RE.test(dep)) fail('bad-depends', `Dependency "${dep}" is not a module name`);
    createOnly(manifestPath, manifestText(module, opts, depends, profile));
    createOnly(`${module}/__init__.py`, '');
  } else if (existing[manifestPath] === undefined) {
    fail('unknown-module', `${manifestPath} not found; pass createModule to scaffold the module`);
    return result();
  }

  const dataFiles = [];
  const csvRows = [];

  for (const model of spec.models ?? []) {
    const name = model?.name;
    if (typeof name !== 'string' || !MODEL_RE.test(name)) {
      fail('bad-model', `Model name "${name}" must be dotted lowercase, e.g. library.book`);
      continue;
    }
    if (knownModels.has(name)) fail('model-exists', `Model ${name} is already defined (module ${knownModels.get(name).module ?? '?'}); extend it with _inherit instead`);
    const fields = checkFields(name, model.fields ?? [], knownModels, fail, warnings, closure, newModels(spec));
    if (!fields.some((field) => field.name === 'name')) warnings.push(`${name}: no "name" field, records display as "${name},<id>" unless _rec_name is set`);
    const file = underscored(name);
    createOnly(`${module}/models/${file}.py`, modelText(name, model.description ?? labelOf(name), fields, profile));
    write(`${module}/models/__init__.py`, ensureImport(read(`${module}/models/__init__.py`) ?? '', file));
    write(`${module}/__init__.py`, ensureImport(read(`${module}/__init__.py`) ?? '', 'models'));
    const viewTypes = model.views ?? ['form', 'list', 'search'];
    const viewsPath = `${module}/views/${file}_views.xml`;
    const records = viewRecords(module, name, fields, viewTypes, profile, claimId, fail);
    if (model.action !== false) {
      const actionId = claimId(module, `${file}_action`);
      records.push(actionRecord(actionId, model.description ?? labelOf(name), name, viewTypes, profile));
      if (model.menu !== undefined && model.menu !== false) {
        const menu = model.menu === true ? {} : model.menu;
        if (menu.parent !== undefined && !XMLID_RE.test(menu.parent) && !/^[A-Za-z0-9_]+$/.test(menu.parent)) fail('bad-menu', `Menu parent "${menu.parent}" is not an xml id`);
        const menuId = claimId(module, `${file}_menu`);
        const parent = menu.parent === undefined ? '' : ` parent="${xml(menu.parent)}"`;
        records.push(`    <menuitem id="${menuId}" name="${xml(menu.name ?? model.description ?? labelOf(name))}"${parent} action="${actionId}" sequence="${Number(menu.sequence ?? 10)}"/>`);
      }
    } else if (model.menu) {
      fail('menu-needs-action', `${name}: a menu needs the window action (action: false given)`);
    }
    if (records.length > 0) {
      createOnly(viewsPath, xmlFile(records));
      dataFiles.push(`views/${file}_views.xml`);
    }
    for (const access of model.access ?? [{ group: 'base.group_user', perms: 'rwcd' }]) csvRows.push({ model: name, ...access });
  }

  for (const view of spec.views ?? []) {
    const name = view?.model;
    if (typeof view?.inherit === 'string' && view.inherit.length > 0) {
      const model = typeof name === 'string' ? name : '';
      if (!model.includes('.')) {
        fail('unknown-model', `inherit view ${view.inherit}: the target model could not be resolved`);
        continue;
      }
      const type = String(view.targetType ?? '').toLowerCase();
      const rootTag = VIEW_ROOT_TAGS[type];
      if (rootTag === undefined) {
        fail('unsupported-view-type', `inherit view ${view.inherit}: cannot scaffold a ${type || 'unknown'} view`);
        continue;
      }
      const position = String(view.position ?? 'inside').toLowerCase();
      if (!VIEW_POSITIONS.has(position)) {
        fail('bad-position', `position must be one of ${[...VIEW_POSITIONS].join(', ')}`);
        continue;
      }
      const expr = typeof view.expr === 'string' && view.expr.length > 0 ? view.expr : `//${rootTag}`;
      if (!expr.startsWith('/')) {
        fail('bad-xpath', `expr must start with "/" (got "${expr}")`);
        continue;
      }
      const fields = Array.isArray(view.fields) ? view.fields : [];
      const known = knownModels.get(model);
      if (known !== undefined && Array.isArray(known.fields)) {
        for (const fieldName of fields) {
          if (!known.fields.some((entry) => entry.name === fieldName)) fail('unknown-field', `${model}.${fieldName} is not a field of ${model}`);
        }
      }
      const recordId = typeof view.id === 'string' && view.id.length > 0
        ? view.id
        : `view_${underscored(model)}_${rootTag}_inherit`;
      claimId(module, recordId);
      const content = fields.map((fieldName) => `        <field name="${xml(fieldName)}"/>`).join('\n');
      const xpath = content.length === 0
        ? `      <xpath expr="${xml(expr)}" position="${position}"/>`
        : `      <xpath expr="${xml(expr)}" position="${position}">\n${content}\n      </xpath>`;
      const record = `  <record id="${xml(recordId)}" model="ir.ui.view">
    <field name="name">${xml(`${model}.${rootTag}.inherit.${module}`)}</field>
    <field name="model">${xml(model)}</field>
    <field name="inherit_id" ref="${xml(view.inherit)}"/>
    <field name="arch" type="xml">
${xpath}
    </field>
  </record>`;
      const file = `${underscored(view.inherit)}_inherit.xml`;
      createOnly(`${module}/views/${file}`, xmlFile([record]));
      dataFiles.push(`views/${file}`);
      continue;
    }
    const known = knownModels.get(name);
    if (known === undefined || !Array.isArray(known.fields)) {
      fail('unknown-model', `Model ${name} is not in the Python index; views for an existing model need its fields`);
      continue;
    }
    // Reachable = some module that defines the field is in the depends closure. With
    // `modules` (every definer, from the index) this is exact; an older index only gives
    // the last definer + a count, so a redefined field is allowed by name with a warning.
    const allFields = classifyFields(known.fields, closure);
    const reach = (field) => field.reach;
    let fields;
    if (Array.isArray(view.fields) && view.fields.length > 0) {
      fields = [];
      for (const fieldName of view.fields) {
        const field = allFields.find((entry) => entry.name === fieldName);
        const state = field === undefined ? 'missing' : reach(field);
        if (state === 'missing' && Array.isArray(known.mixins) && known.mixins.length > 0) {
          // Fields of mixins (`mail.thread`, …) are not copied onto the model by the static index.
          warnings.push(`${name}.${fieldName}: not declared on ${name} itself; assumed to come from a mixin (${known.mixins.join(', ')}), not verified`);
          fields.push({ name: fieldName, type: '' });
        } else if (state === 'missing') fail('unknown-field', `${name}.${fieldName} is not a field of ${name}`);
        else if (state === 'no') fail('unknown-field', `${name}.${fieldName} comes from ${(field.modules ?? [field.module]).join(', ')}, which ${module} does not depend on`);
        else {
          if (state === 'maybe' && !warnings.some((w) => w.startsWith(`${name}.${fieldName}:`))) {
            warnings.push(`${name}.${fieldName}: last redefined in ${field.module} (not in depends); make sure a dependency defines it`);
          }
          fields.push(field);
        }
      }
    } else {
      fields = allFields.filter((field) => reach(field) === 'yes' && !RESERVED_FIELDS.has(field.name));
      if (fields.length > MAX_DEFAULT_VIEW_FIELDS) {
        fail('too-many-fields', `${name} has ${fields.length} fields reachable from ${module}; pass the ones to show (fields: [...] / --fields a,b,c)`);
        continue;
      }
    }
    const file = underscored(name);
    const viewsPath = `${module}/views/${file}_views.xml`;
    const records = viewRecords(module, name, fields, [view.type], profile, claimId, fail);
    if (records.length === 0) continue;
    const before = read(viewsPath);
    if (before === undefined) {
      createOnly(viewsPath, xmlFile(records));
      dataFiles.push(`views/${file}_views.xml`);
    } else {
      const patched = appendXmlRecords(before, records);
      if (patched === undefined) fail('xml-unparsable', `${viewsPath} has no closing </odoo> or </openerp>`);
      else write(viewsPath, patched);
    }
  }

  for (const row of spec.access ?? []) csvRows.push(row);
  if (csvRows.length > 0) {
    const csvPath = `${module}/security/ir.model.access.csv`;
    const before = read(csvPath);
    const patched = appendAccessRows(before, csvRows, module, knownModels, newModels(spec), fail, closure, warnings);
    if (patched !== undefined) {
      if (before === undefined) createOnly(csvPath, patched);
      else write(csvPath, patched);
      dataFiles.unshift('security/ir.model.access.csv');
    }
  }

  if (dataFiles.length > 0) {
    const patched = ensureManifestData(read(manifestPath), dataFiles);
    if (patched === undefined) fail('manifest-unparsable', `${manifestPath}: cannot locate the data list; add by hand: ${dataFiles.map((f) => `'${f}'`).join(', ')}`);
    else write(manifestPath, patched);
  }

  return result();

  function result() {
    if (errors.length > 0) return { ok: false, version: ctx?.version, files: [], warnings, errors };
    const files = [];
    for (const [path, after] of work) {
      const before = existing[path];
      if (before === after) continue;
      files.push(before === undefined ? { path, op: 'create', after } : { path, op: 'patch', before, after });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { ok: true, version: ctx?.version, files, warnings, errors };
  }
}

/** Models the spec itself defines (for access rows on them). */
function newModels(spec) {
  return new Set((spec.models ?? []).map((model) => model?.name));
}

/** Validate fields; returns the valid ones. */
function checkFields(model, fields, knownModels, fail, warnings, closure, specModelNames) {
  const seen = new Set();
  const valid = [];
  for (const raw of fields) {
    const field = typeof raw === 'string' ? safeToken(raw, fail) : raw;
    if (field === undefined) continue;
    const where = `${model}.${field.name}`;
    if (typeof field.name !== 'string' || !FIELD_RE.test(field.name)) { fail('bad-field', `${where}: invalid field name`); continue; }
    if (RESERVED_FIELDS.has(field.name)) { fail('reserved-field', `${where}: "${field.name}" is a magic field`); continue; }
    if (seen.has(field.name)) { fail('duplicate-field', `${where}: declared twice`); continue; }
    if (FIELD_CLASS[field.type] === undefined) { fail('bad-field-type', `${where}: unknown type "${field.type}"`); continue; }
    if (RELATIONAL.has(field.type)) {
      if (typeof field.comodel !== 'string' || !MODEL_RE.test(field.comodel)) { fail('bad-comodel', `${where}: comodel "${field.comodel}" is not a model name`); continue; }
      const comodel = knownModels.get(field.comodel);
      if (field.comodel !== model && comodel === undefined && !specModelNames.has(field.comodel)) warnings.push(`${where}: comodel ${field.comodel} is not in the index; make sure its module is in depends`);
      if (comodel?.module !== undefined && closure !== undefined && !closure.has(comodel.module)) warnings.push(`${where}: comodel ${field.comodel} is defined in ${comodel.module}, which is not in depends`);
      if (field.type === 'many2one' && !field.name.endsWith('_id')) warnings.push(`${where}: many2one names usually end in _id`);
      if (field.type !== 'many2one' && !field.name.endsWith('_ids')) warnings.push(`${where}: ${field.type} names usually end in _ids`);
      if (field.type === 'one2many' && (typeof field.inverse !== 'string' || !FIELD_RE.test(field.inverse))) { fail('bad-field', `${where}: one2many needs an inverse field name`); continue; }
    }
    if (field.type === 'selection' && (!Array.isArray(field.selection) || field.selection.length === 0)) { fail('bad-field', `${where}: selection needs values`); continue; }
    if (field.default !== undefined && defaultLiteral(field) === undefined) {
      fail('bad-default', `${where}: default "${field.default}" does not fit a ${field.type} field (boolean True/False, a selection key, a number, or text)`);
      continue;
    }
    if (field.type === 'monetary' && !fields.some((other) => (typeof other === 'string' ? other.startsWith('currency_id:') : other.name === 'currency_id'))) {
      warnings.push(`${where}: monetary fields need a currency_id field (or currency_field=...)`);
    }
    seen.add(field.name);
    valid.push(field);
  }
  return valid;
}

function safeToken(token, fail) {
  try {
    return parseFieldToken(token);
  } catch (error) {
    fail(error.code ?? 'bad-field', error.message);
    return undefined;
  }
}

function manifestText(module, opts, depends, profile) {
  const lines = [
    '# -*- coding: utf-8 -*-',
    '{',
    `    'name': ${py(opts.name ?? labelOf(module))},`,
    `    'version': ${py(`${profile.major}.0.1.0.0`)},`,
    `    'summary': ${py(opts.summary ?? '')},`,
    `    'category': ${py(opts.category ?? 'Uncategorized')},`,
    `    'author': ${py(opts.author ?? '')},`,
    `    'license': ${py(opts.license ?? 'LGPL-3')},`,
    `    'depends': [${depends.map(py).join(', ')}],`,
    "    'data': [",
    '    ],',
    "    'installable': True,",
    `    'application': ${opts.application ? 'True' : 'False'},`,
    '}',
    '',
  ];
  return lines.join('\n');
}

function modelText(name, description, fields, profile) {
  const body = fields.map((field) => `    ${field.name} = fields.${FIELD_CLASS[field.type]}(${fieldArgs(field).join(', ')})`);
  return [
    '# -*- coding: utf-8 -*-',
    'from odoo import fields, models',
    '',
    '',
    `class ${classOf(name)}(models.Model):`,
    `    _name = ${py(name)}`,
    `    _description = ${py(description)}`,
    ...(body.length > 0 ? ['', ...body] : []),
    '',
  ].join('\n');
}

/** Python literal of a field default, or undefined when it does not fit the type. */
function defaultLiteral(field) {
  const value = String(field.default);
  switch (field.type) {
    case 'boolean': return value === 'True' || value === 'False' ? value : undefined;
    case 'integer': return /^-?\d+$/.test(value) ? value : undefined;
    case 'float': case 'monetary': return /^-?\d+(\.\d+)?$/.test(value) ? value : undefined;
    case 'selection': return (field.selection ?? []).some(([key]) => key === value) ? py(value) : undefined;
    case 'char': case 'text': case 'html': return py(value);
    default: return undefined;
  }
}

function fieldArgs(field) {
  const args = [];
  if (RELATIONAL.has(field.type)) args.push(py(field.comodel));
  if (field.type === 'one2many') args.push(py(field.inverse));
  if (field.type === 'selection') args.push(`[${field.selection.map(([key, label]) => `(${py(key)}, ${py(label)})`).join(', ')}]`);
  args.push(`string=${py(field.string ?? labelOf(field.name))}`);
  if (field.required) args.push('required=True');
  if (field.readonly) args.push('readonly=True');
  if (field.index) args.push('index=True');
  if (field.default !== undefined) args.push(`default=${defaultLiteral(field)}`);
  if (field.help) args.push(`help=${py(field.help)}`);
  if (field.type === 'many2one' && field.ondelete) args.push(`ondelete=${py(field.ondelete)}`);
  return args;
}

function viewRecords(module, model, fields, types, profile, claimId, fail) {
  const records = [];
  const file = underscored(model);
  for (const type of types) {
    if (!VIEW_TYPES.has(type)) { fail('bad-view-type', `${model}: view type "${type}" (form, list, search)`); continue; }
    const suffix = type === 'list' ? profile.listTag : type;
    const id = claimId(module, `${file}_view_${suffix}`);
    records.push(viewRecord(id, `${model}.${suffix}`, model, archOf(type, fields, profile)));
  }
  return records;
}

function viewRecord(id, name, model, arch) {
  return [
    `    <record id="${id}" model="ir.ui.view">`,
    `        <field name="name">${xml(name)}</field>`,
    `        <field name="model">${xml(model)}</field>`,
    '        <field name="arch" type="xml">',
    arch.map((line) => `            ${line}`).join('\n'),
    '        </field>',
    '    </record>',
  ].join('\n');
}

function archOf(type, fields, profile) {
  const fieldLine = (field) => `<field name="${field.name}"/>`;
  if (type === 'form') {
    const narrow = fields.filter((field) => !WIDE_TYPES.has(field.type));
    const wide = fields.filter((field) => WIDE_TYPES.has(field.type));
    return [
      '<form>',
      '    <sheet>',
      ...(narrow.length > 0 ? ['        <group>', ...narrow.map((field) => `            ${fieldLine(field)}`), '        </group>'] : []),
      ...wide.map((field) => `        ${fieldLine(field)}`),
      '    </sheet>',
      '</form>',
    ];
  }
  if (type === 'list') {
    const columns = fields.filter((field) => !WIDE_TYPES.has(field.type)).slice(0, MAX_LIST_COLUMNS);
    return [`<${profile.listTag}>`, ...columns.map((field) => `    ${fieldLine(field)}`), `</${profile.listTag}>`];
  }
  const searchable = fields.filter((field) => field.type === 'char' || field.type === 'many2one');
  const groupable = fields.filter((field) => field.type === 'many2one' || field.type === 'selection');
  return [
    '<search>',
    ...searchable.map((field) => `    ${fieldLine(field)}`),
    ...(groupable.length > 0 ? [
      '    <group expand="0" string="Group By">',
      ...groupable.map((field) => `        <filter name="group_by_${field.name}" string="${xml(field.string ?? labelOf(field.name))}" context="{'group_by': '${field.name}'}"/>`),
      '    </group>',
    ] : []),
    '</search>',
  ];
}

function actionRecord(id, name, model, viewTypes, profile) {
  const modes = viewTypes.includes('list') || !viewTypes.includes('form') ? profile.viewMode : 'form';
  return [
    `    <record id="${id}" model="ir.actions.act_window">`,
    `        <field name="name">${xml(name)}</field>`,
    `        <field name="res_model">${xml(model)}</field>`,
    `        <field name="view_mode">${modes}</field>`,
    '    </record>',
  ].join('\n');
}

function xmlFile(records) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<odoo>\n${records.join('\n\n')}\n</odoo>\n`;
}

/** Insert records before the closing root tag; undefined when there is none. */
export function appendXmlRecords(text, records) {
  const match = /<\/(odoo|openerp)>\s*$/.exec(text);
  if (match === null) return undefined;
  const head = text.slice(0, match.index).replace(/\s*$/, '\n');
  return `${head}\n${records.join('\n\n')}\n${text.slice(match.index)}`;
}

/**
 * `depends` of a manifest (comments ignored).
 * @param {string} text - `__manifest__.py` text.
 * @returns {string[]} module names.
 */
export function manifestDepends(text) {
  const match = /(['"])depends\1\s*:\s*\[([^\]]*)\]/.exec(maskPythonComments(String(text ?? '')));
  return match === null ? [] : [...match[2].matchAll(/['"]([\w.]+)['"]/g)].map((entry) => entry[1]);
}

/** Add `from . import <name>` when missing. */
export function ensureImport(text, name) {
  const re = new RegExp(`^from \\. import (.*\\b)?${name}\\b`, 'm');
  if (re.test(text)) return text;
  const prefix = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  return `${prefix}from . import ${name}\n`;
}

/**
 * Add entries to the manifest `data` list (CSV first, others appended). Adds a
 * `data` key after `depends` when there is none. Undefined when unsafe to patch.
 */
export function ensureManifestData(text, entries) {
  if (typeof text !== 'string') return undefined;
  // Keys are located on a copy with `# comments` blanked (same offsets), so a
  // commented-out `# 'data': [...]` is never taken for the real list.
  const masked = maskPythonComments(text);
  const data = /(['"])data\1\s*:\s*\[/.exec(masked);
  if (data === null) {
    const depends = /(['"])depends\1\s*:\s*\[[^\]]*\]\s*,?/.exec(masked);
    if (depends === null) return undefined;
    const end = depends.index + depends[0].length;
    const comma = depends[0].trimEnd().endsWith(',') ? '' : ',';
    const list = entries.map((entry) => `        '${entry}',`).join('\n');
    return `${text.slice(0, end)}${comma}\n    'data': [\n${list}\n    ],${text.slice(end)}`;
  }
  // A commented-out entry is not "present"; a `]` in a comment does not end the list.
  const open = masked.indexOf('[', data.index) + 1;
  const close = masked.indexOf(']', open);
  if (open <= 0 || close < 0 || masked.slice(open, close).includes('[')) return undefined;
  const inner = masked.slice(open, close);
  const quoted = [...inner.matchAll(/(['"])([^'"\n]+)\1/g)];
  const present = new Set(quoted.map((match) => match[2]));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return text;
  const indent = /\n([ \t]+)['"]/.exec(inner)?.[1] ?? '        ';
  const line = (entry) => `\n${indent}'${entry}',`;
  const head = missing.filter((entry) => entry.endsWith('.csv')).map(line).join('');
  const tail = missing.filter((entry) => !entry.endsWith('.csv')).map(line).join('');
  if (quoted.length === 0) {
    const original = text.slice(open, close);
    const closingIndent = /\n([ \t]*)$/.exec(original)?.[1] ?? '    ';
    const body = original.trim().length === 0 ? `\n${closingIndent}` : original;
    return `${text.slice(0, open)}${head}${tail}${body}${text.slice(close)}`;
  }
  // CSV first (right after `[`); other files right after the last active entry, so
  // trailing comments and blank lines inside the list stay where they are.
  const lastEntry = quoted.at(-1);
  const afterLiteral = open + lastEntry.index + lastEntry[0].length;
  const comma = /^[ \t]*,/.exec(masked.slice(afterLiteral));
  let insertAt = comma === null ? afterLiteral : afterLiteral + comma[0].length;
  const eol = text.indexOf('\n', insertAt);
  if (eol >= 0 && eol < close && masked.slice(insertAt, eol).trim() === '') insertAt = eol;
  const missingComma = comma === null ? ',' : '';
  return `${text.slice(0, open)}${head}${text.slice(open, afterLiteral)}${missingComma}${text.slice(afterLiteral, insertAt)}${tail}${text.slice(insertAt)}`;
}

/**
 * Blank `#` comments outside string literals, keeping every offset.
 * @param {string} text - Python source.
 * @returns {string} masked text of the same length.
 */
function maskPythonComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i += 1; continue; }
      if (ch === quote || ch === '\n') quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '#') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else out += ch;
  }
  return out;
}

/** Append ACL rows; returns the new CSV text or undefined after recording errors. */
function appendAccessRows(before, rows, module, knownModels, specModels, fail, closure, warnings) {
  const lines = before === undefined ? [ACCESS_HEADER] : before.replace(/\s*$/, '').split(/\r?\n/);
  const header = lines[0].replace(/^\uFEFF/, '').trim().split(',').map((cell) => cell.trim().replace('/id', ':id'));
  if (header.join(',') !== ACCESS_HEADER) {
    fail('csv-unparsable', `${module}/security/ir.model.access.csv header is "${lines[0].trim()}"; the builder only appends to ${ACCESS_HEADER}`);
    return undefined;
  }
  const ids = new Set(lines.slice(1).map((line) => line.split(',')[0].trim()));
  let ok = true;
  for (const row of rows) {
    const where = `access ${row.model}/${row.group || '(all users)'}`;
    if (!PERM_RE.test(row.perms ?? '')) { fail('bad-access', `${where}: perms "${row.perms}" must look like rwcd / r---`); ok = false; continue; }
    if (row.group && !XMLID_RE.test(row.group) && !/^[A-Za-z0-9_]+$/.test(row.group)) { fail('bad-access', `${where}: group "${row.group}" is not an xml id`); ok = false; continue; }
    const owner = specModels.has(row.model) ? module : knownModels.get(row.model)?.module;
    if (owner === undefined) { fail('unknown-model', `${where}: model ${row.model} is not in the spec or the index`); ok = false; continue; }
    if (owner !== module && closure !== undefined && !closure.has(owner)) warnings.push(`${where}: model ${row.model} is defined in ${owner}, which is not in depends`);
    const groupPart = row.group ? underscored(row.group.split('.').pop()) : 'all';
    const id = `access_${underscored(row.model)}_${groupPart}`;
    if (ids.has(id)) { fail('duplicate-access', `${where}: row ${id} already exists`); ok = false; continue; }
    ids.add(id);
    const modelRef = owner === module ? `model_${underscored(row.model)}` : `${owner}.model_${underscored(row.model)}`;
    const perms = [...row.perms].map((letter) => (letter === '-' ? '0' : '1'));
    lines.push([id, `${row.model} ${row.group || 'all'}`, modelRef, row.group ?? '', ...perms].map(csv).join(','));
  }
  return ok ? `${lines.join('\n')}\n` : undefined;
}

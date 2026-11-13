/**
 * Static ACL and group trace for Odoo addons.
 *
 * Pure functions, no I/O. The Host reads files and feeds text in here:
 * - `parseAccessCsv`   : `security/ir.model.access.csv`
 * - `parseSecurityXml` : `res.groups`, `ir.rule`, `ir.model.access`, menus, actions,
 *                        views and every `groups="…"` attribute / `groups_id` field.
 * - `buildSecurityIndex` merges the per-file results into one queryable index.
 * - `searchSecurity`, `traceGroup`, `traceModel`, `traceArtifact` answer the questions.
 *
 * Everything is static text analysis: no database ids, no `res.users` membership
 * beyond what XML declares, no dynamic `groups` computed in Python. Anything that
 * cannot be read is reported in `errors`, never dropped silently.
 */

const ENTITIES = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const MAX_CLOSURE_DEPTH = 40;
const MAX_MENU_DEPTH = 24;

/**
 * Decode the five predefined XML entities.
 * @param {string} value - raw text.
 * @returns {string} decoded text.
 */
function decode(value) {
  return String(value).replace(/&(?:quot|apos|lt|gt|amp);/g, (match) => ENTITIES[match] ?? match);
}

/**
 * Replace XML comments with spaces of equal length so offsets and line numbers hold.
 * @param {string} text - XML source.
 * @returns {string} source without comment content.
 */
function blankComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * Build a `line(offset)` function for a text.
 * @param {string} text - source text.
 * @returns {(offset: number) => number} 1-based line lookup.
 */
function lineLookup(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * Read the attributes of one tag text.
 * @param {string} tagText - text of an opening tag.
 * @returns {Record<string, string>} decoded attributes.
 */
function attrsOf(tagText) {
  const attrs = Object.create(null);
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(tagText)) !== null) attrs[match[1]] = decode(match[2] ?? match[3] ?? '');
  return attrs;
}

/**
 * Qualify an xml id with its declaring module.
 * @param {string} id - xml id, qualified or not.
 * @param {string} module - declaring module.
 * @returns {string} qualified xml id (empty stays empty).
 */
export function qualifyId(id, module) {
  const clean = String(id ?? '').trim();
  if (clean.length === 0) return '';
  return clean.includes('.') ? clean : `${module}.${clean}`;
}

/**
 * Normalise a model name or `model_x_y` id to a comparison key.
 * Odoo derives `model_res_partner` from `res.partner`; the mapping is lossy for
 * models whose names hold underscores, so every comparison goes through this key.
 * @param {string} value - model name, `model_*` id or xml id of it.
 * @returns {string} lower-case underscore key.
 */
export function modelKey(value) {
  const text = String(value ?? '').trim();
  const ref = /^(?:[\w-]+\.)?model_([\w]+)$/.exec(text);
  const base = ref !== null ? ref[1] : text;
  return base.replace(/[.\s]+/g, '_').toLowerCase();
}

/**
 * Split a `groups="a,b,!c"` attribute into qualified group refs.
 * @param {string} value - attribute value.
 * @param {string} module - declaring module.
 * @returns {Array<{ xmlId: string, negated: boolean }>} refs.
 */
export function parseGroupsAttr(value, module) {
  const out = [];
  for (const part of String(value ?? '').split(',')) {
    let item = part.trim();
    if (item.length === 0) continue;
    let negated = false;
    if (item.startsWith('!')) {
      negated = true;
      item = item.slice(1).trim();
    }
    if (item.length > 0) out.push({ xmlId: qualifyId(item, module), negated });
  }
  return out;
}

/**
 * Split one CSV line (RFC 4180 quoting).
 * @param {string} line - one line.
 * @returns {string[]} cells.
 */
function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(current);
      current = '';
    } else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Parse an `ir.model.access.csv` file.
 * @param {string} text - CSV text.
 * @param {{ module: string, file: string }} source - owning module and relative path.
 * @returns {{ rows: Array<object>, errors: Array<object> }} access rows and problems.
 */
export function parseAccessCsv(text, source) {
  const rows = [];
  const errors = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let header = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().length === 0) continue;
    const cells = splitCsvLine(lines[index]);
    if (header === null) {
      header = cells.map((cell) => cell.toLowerCase().replace(/\/id$/, ':id'));
      const need = ['id', 'model_id:id'];
      if (need.some((name) => !header.includes(name))) {
        errors.push({ file: source.file, line: index + 1, code: 'bad-csv-header', message: `Missing column: ${need.filter((name) => !header.includes(name)).join(', ')}` });
        return { rows, errors };
      }
      continue;
    }
    const get = (name) => {
      const at = header.indexOf(name);
      return at >= 0 ? (cells[at] ?? '') : '';
    };
    const flag = (name) => {
      const value = get(name).toLowerCase();
      return value === '1' || value === 'true';
    };
    const modelRef = get('model_id:id');
    if (modelRef.length === 0) {
      errors.push({ file: source.file, line: index + 1, code: 'missing-model', message: 'Row has no model_id:id.' });
      continue;
    }
    const groupRef = get('group_id:id');
    rows.push({
      id: qualifyId(get('id'), source.module),
      name: get('name'),
      module: source.module,
      file: source.file,
      line: index + 1,
      modelKey: modelKey(modelRef),
      modelRef,
      group: groupRef.length === 0 ? '' : qualifyId(groupRef, source.module),
      perms: { read: flag('perm_read'), write: flag('perm_write'), create: flag('perm_create'), unlink: flag('perm_unlink') },
    });
  }
  return { rows, errors };
}

/**
 * Locate the direct `<field>` children of a record body, skipping nested markup.
 * @param {string} body - inner record text.
 * @returns {Array<{ name: string, attrs: Record<string, string>, content: string }>} fields.
 */
function scanFields(body) {
  const fields = [];
  const open = /<field\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = open.exec(body)) !== null) {
    const attrs = attrsOf(match[1]);
    if (match[2] === '/') {
      fields.push({ name: attrs.name ?? '', attrs, content: '' });
      continue;
    }
    let depth = 1;
    const scan = /<(\/?)field\b([^>]*?)(\/?)>/g;
    scan.lastIndex = open.lastIndex;
    let end = body.length;
    let inner;
    while ((inner = scan.exec(body)) !== null) {
      if (inner[1] === '/') depth -= 1;
      else if (inner[3] !== '/') depth += 1;
      if (depth === 0) {
        end = inner.index;
        break;
      }
    }
    fields.push({ name: attrs.name ?? '', attrs, content: body.slice(open.lastIndex, end) });
    open.lastIndex = depth === 0 ? scan.lastIndex : body.length;
  }
  return fields;
}

/**
 * Collect `ref('x')` targets of an eval expression. Removal commands `(3, …)` / `(5…)` are
 * ignored because they take a group away rather than add one.
 * @param {string} expr - eval text.
 * @param {string} module - declaring module.
 * @returns {string[]} qualified xml ids.
 */
function refsInEval(expr, module) {
  if (/\(\s*[35]\s*[,)]/.test(expr)) {
    const kept = expr.split(/\(\s*[35]\s*(?:,[^)]*)?\)/).join(' ');
    return refsInEval(kept.replace(/\(\s*[35]\b/g, ''), module);
  }
  const out = [];
  const pattern = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(expr)) !== null) out.push(qualifyId(match[1], module));
  return out;
}

/**
 * Group refs held by one record field (`ref=`, `eval=` or inline text).
 * @param {{ attrs: Record<string, string>, content: string }} field - field.
 * @param {string} module - declaring module.
 * @returns {string[]} qualified group xml ids.
 */
function fieldRefs(field, module) {
  if (field.attrs.ref !== undefined) return [qualifyId(field.attrs.ref, module)];
  if (field.attrs.eval !== undefined) return refsInEval(field.attrs.eval, module);
  const text = decode(field.content).trim();
  return text.length > 0 ? refsInEval(text, module) : [];
}

/**
 * Parse a boolean-ish `perm_*` field. Missing means Odoo's default (true).
 * @param {{ attrs: Record<string, string>, content: string } | undefined} field - field or undefined.
 * @returns {boolean} permission flag.
 */
function permField(field) {
  if (field === undefined) return true;
  const raw = (field.attrs.eval ?? decode(field.content)).trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'none' || raw === '');
}

/**
 * Parse one XML data file for access-relevant records.
 * @param {string} text - XML text.
 * @param {{ module: string, file: string }} source - owning module and relative path.
 * @returns {{ groups: object[], rules: object[], access: object[], owners: object[], errors: object[] }} parsed data.
 */
export function parseSecurityXml(text, source) {
  const { module, file } = source;
  const out = { groups: [], rules: [], access: [], owners: [], errors: [] };
  const src = blankComments(String(text));
  const line = lineLookup(src);
  const spans = [];
  const recordPattern = /<record\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = recordPattern.exec(src)) !== null) {
    const attrs = attrsOf(match[1]);
    const start = match.index;
    let end = recordPattern.lastIndex;
    let body = '';
    if (match[2] !== '/') {
      const close = src.indexOf('</record>', recordPattern.lastIndex);
      if (close < 0) {
        out.errors.push({ file, line: line(start), code: 'unclosed-record', message: `Record ${attrs.id ?? '?'} is not closed.` });
        end = src.length;
        body = src.slice(recordPattern.lastIndex);
      } else {
        body = src.slice(recordPattern.lastIndex, close);
        end = close + 9;
      }
      recordPattern.lastIndex = end;
    }
    const xmlId = qualifyId(attrs.id, module);
    const model = attrs.model ?? '';
    if (xmlId.length === 0 || model.length === 0) continue;
    const fields = scanFields(body);
    const byName = new Map(fields.map((field) => [field.name, field]));
    const text_ = (name) => decode(byName.get(name)?.content ?? '').trim();
    spans.push({ start, end, xmlId, model });
    const here = line(start);

    if (model === 'res.groups') {
      out.groups.push({
        xmlId, module, file, line: here,
        name: text_('name'),
        category: byName.has('category_id') ? fieldRefs(byName.get('category_id'), module)[0] ?? '' : '',
        implied: byName.has('implied_ids') ? fieldRefs(byName.get('implied_ids'), module) : [],
        users: byName.has('users') ? fieldRefs(byName.get('users'), module) : [],
        comment: text_('comment'),
      });
      continue;
    }
    if (model === 'ir.rule') {
      const modelField = byName.get('model_id');
      let ruleModel = '';
      if (modelField !== undefined) {
        const ref = modelField.attrs.ref ?? refsInEval(modelField.attrs.eval ?? '', module)[0] ?? '';
        ruleModel = ref;
        const search = modelField.attrs.search ?? '';
        const named = /['"]model['"]\s*,\s*['"]=['"]\s*,\s*['"]([\w.]+)['"]/.exec(search);
        if (named !== null) ruleModel = named[1];
      }
      const groupField = byName.get('groups');
      const domainField = byName.get('domain_force');
      out.rules.push({
        xmlId, module, file, line: here,
        name: text_('name'),
        modelKey: modelKey(ruleModel),
        modelRef: ruleModel,
        domain: domainField === undefined ? '' : (domainField.attrs.eval ?? decode(domainField.content)).trim(),
        groups: groupField === undefined ? [] : fieldRefs(groupField, module),
        global: groupField === undefined || fieldRefs(groupField, module).length === 0,
        active: byName.has('active') ? permField(byName.get('active')) : true,
        perms: {
          read: permField(byName.get('perm_read')),
          write: permField(byName.get('perm_write')),
          create: permField(byName.get('perm_create')),
          unlink: permField(byName.get('perm_unlink')),
        },
      });
      continue;
    }
    if (model === 'ir.model.access') {
      const modelField = byName.get('model_id');
      const groupField = byName.get('group_id');
      const modelRef = modelField === undefined ? '' : (modelField.attrs.ref ?? refsInEval(modelField.attrs.eval ?? '', module)[0] ?? '');
      if (modelRef.length === 0) continue;
      out.access.push({
        id: xmlId, name: text_('name'), module, file, line: here,
        modelKey: modelKey(modelRef), modelRef,
        group: groupField === undefined ? '' : fieldRefs(groupField, module)[0] ?? '',
        perms: {
          read: byName.has('perm_read') ? permField(byName.get('perm_read')) : false,
          write: byName.has('perm_write') ? permField(byName.get('perm_write')) : false,
          create: byName.has('perm_create') ? permField(byName.get('perm_create')) : false,
          unlink: byName.has('perm_unlink') ? permField(byName.get('perm_unlink')) : false,
        },
      });
      continue;
    }

    // Anything else: keep it as an owner when it is a view, menu or action, or when it gates by group.
    const gateField = byName.get('groups_id') ?? byName.get('groups');
    const gateRefs = gateField === undefined ? [] : fieldRefs(gateField, module);
    let kind = '';
    if (model === 'ir.ui.view') kind = 'view';
    else if (model === 'ir.ui.menu') kind = 'menu';
    else if (model.startsWith('ir.actions.')) kind = 'action';
    else if (gateRefs.length > 0) kind = 'record';
    if (kind.length === 0) continue;
    let ownerModel = '';
    if (kind === 'view') ownerModel = text_('model');
    else if (kind === 'action') ownerModel = text_('res_model') || text_('model') || text_('binding_model_id');
    out.owners.push({
      xmlId, kind, recordModel: model, module, file, line: here,
      name: text_('name'),
      model: ownerModel,
      viewType: kind === 'view' ? text_('type') : '',
      inheritId: kind === 'view' && byName.has('inherit_id') ? fieldRefs(byName.get('inherit_id'), module)[0] ?? '' : '',
      parent: kind === 'menu' && byName.has('parent_id') ? fieldRefs(byName.get('parent_id'), module)[0] ?? '' : '',
      action: kind === 'menu' && byName.has('action') ? (byName.get('action').attrs.ref ? qualifyId(byName.get('action').attrs.ref, module) : decode(byName.get('action').content).trim().split(',').pop().trim()) : '',
      groups: gateRefs.map((id) => ({ xmlId: id, negated: false })),
      nodes: [],
    });
  }

  // <menuitem> and <template> are not records; they carry groups= as an attribute.
  const itemPattern = /<(menuitem|template)\b([^>]*?)(\/?)>/g;
  while ((match = itemPattern.exec(src)) !== null) {
    const attrs = attrsOf(match[2]);
    const xmlId = qualifyId(attrs.id, module);
    if (xmlId.length === 0) continue;
    let end = itemPattern.lastIndex;
    if (match[1] === 'template' && match[3] !== '/') {
      const close = src.indexOf('</template>', itemPattern.lastIndex);
      end = close < 0 ? src.length : close + 11;
    }
    const isMenu = match[1] === 'menuitem';
    spans.push({ start: match.index, end, xmlId, model: isMenu ? 'ir.ui.menu' : 'ir.ui.view' });
    out.owners.push({
      xmlId, kind: isMenu ? 'menu' : 'view', recordModel: isMenu ? 'ir.ui.menu' : 'ir.ui.view', module, file, line: line(match.index),
      name: attrs.name ?? '', model: '', viewType: isMenu ? '' : 'qweb',
      inheritId: isMenu ? '' : qualifyId(attrs.inherit_id ?? '', module),
      parent: isMenu ? qualifyId(attrs.parent ?? '', module) : '',
      action: isMenu ? qualifyId(attrs.action ?? '', module) : '',
      groups: parseGroupsAttr(attrs.groups, module),
      nodes: [],
    });
  }

  // Attribute-level groups on arch nodes (and template nodes), attributed to the enclosing owner.
  const ownerByKey = new Map(out.owners.map((owner) => [owner.xmlId, owner]));
  const attrPattern = /\sgroups\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  while ((match = attrPattern.exec(src)) !== null) {
    const offset = match.index;
    const tagStart = src.lastIndexOf('<', offset);
    const tag = /^<([\w:.-]+)/.exec(src.slice(tagStart, tagStart + 80))?.[1] ?? '';
    if (tag === 'menuitem' || tag === 'record') continue;
    const span = spans.find((entry) => offset >= entry.start && offset < entry.end && entry.model !== 'ir.ui.menu');
    if (span === undefined) continue;
    const owner = ownerByKey.get(span.xmlId);
    if (owner === undefined) continue;
    const refs = parseGroupsAttr(decode(match[1] ?? match[2] ?? ''), module);
    if (tag === 'template' && tagStart === span.start) continue; // already the template's own groups
    owner.nodes.push({ tag, line: line(offset), groups: refs });
  }
  return out;
}

/**
 * Merge per-file results into one index.
 * @param {Array<{ csv?: object, xml?: object }>} parsed - per-file parse results.
 * @returns {object} security index.
 */
export function buildSecurityIndex(parsed) {
  const groups = new Map();
  const acl = [];
  const rules = [];
  const owners = new Map();
  const errors = [];
  const touch = (xmlId, patch) => {
    const known = groups.get(xmlId) ?? { xmlId, module: '', name: '', category: '', implied: [], users: [], comment: '', file: '', line: 0, declared: 0 };
    known.implied = [...new Set([...known.implied, ...(patch.implied ?? [])])];
    known.users = [...new Set([...known.users, ...(patch.users ?? [])])];
    if (patch.name && (known.name === '' || patch.module === xmlId.split('.')[0])) known.name = patch.name;
    if (patch.category) known.category = known.category || patch.category;
    if (patch.comment) known.comment = known.comment || patch.comment;
    if (patch.file && (known.file === '' || (patch.module === xmlId.split('.')[0] && known.module !== xmlId.split('.')[0]))) {
      known.file = patch.file;
      known.line = patch.line;
      known.module = patch.module;
    }
    if (patch.file) known.declared += 1;
    groups.set(xmlId, known);
  };
  for (const item of parsed) {
    if (item.csv !== undefined) {
      acl.push(...item.csv.rows);
      errors.push(...item.csv.errors);
    }
    if (item.xml === undefined) continue;
    acl.push(...item.xml.access);
    rules.push(...item.xml.rules);
    errors.push(...item.xml.errors);
    for (const group of item.xml.groups) touch(group.xmlId, group);
    for (const owner of item.xml.owners) {
      const known = owners.get(owner.xmlId);
      if (known === undefined) owners.set(owner.xmlId, owner);
      else {
        // A later record that extends the same id (for example a view that adds groups).
        known.groups.push(...owner.groups);
        known.nodes.push(...owner.nodes);
        for (const key of ['name', 'model', 'viewType', 'inheritId', 'parent', 'action']) if (known[key] === '') known[key] = owner[key];
      }
    }
  }
  // Groups mentioned only in references still get a node, so traces never lose them.
  const mention = (xmlId) => {
    if (xmlId.length > 0 && !groups.has(xmlId)) touch(xmlId, {});
  };
  for (const group of [...groups.values()]) {
    group.implied.forEach(mention);
  }
  for (const row of acl) mention(row.group);
  for (const rule of rules) rule.groups.forEach(mention);
  for (const owner of owners.values()) {
    owner.groups.forEach((ref) => mention(ref.xmlId));
    for (const node of owner.nodes) node.groups.forEach((ref) => mention(ref.xmlId));
  }

  const modelNames = new Map();
  for (const owner of owners.values()) {
    if (owner.model.length > 0) modelNames.set(modelKey(owner.model), owner.model);
  }
  for (const rule of rules) {
    if (rule.modelRef.length > 0 && !rule.modelRef.includes('model_') && !modelNames.has(rule.modelKey)) modelNames.set(rule.modelKey, rule.modelRef);
  }
  const modelKeys = new Set([...acl.map((row) => row.modelKey), ...rules.map((rule) => rule.modelKey), ...modelNames.keys()]);
  modelKeys.delete('');

  const index = {
    groups, acl, rules, owners, errors, modelNames, modelKeys,
    includesCache: new Map(),
    includedByCache: new Map(),
    shortGroups: null,
    stats: { groups: groups.size, acl: acl.length, rules: rules.length, owners: owners.size, models: modelKeys.size, errors: errors.length },
  };
  return index;
}

/**
 * Resolve a possibly short xml id to a known key of a map.
 * @param {Map<string, any>} map - map keyed by qualified xml id.
 * @param {string} id - qualified or short id.
 * @returns {{ key: string | null, ambiguous: string[] }} resolution.
 */
function resolveKey(map, id) {
  const wanted = String(id ?? '').trim();
  if (map.has(wanted)) return { key: wanted, ambiguous: [] };
  if (wanted.includes('.')) return { key: null, ambiguous: [] };
  const hits = [...map.keys()].filter((key) => key.endsWith(`.${wanted}`));
  return hits.length === 1 ? { key: hits[0], ambiguous: [] } : { key: null, ambiguous: hits };
}

/**
 * Transitive closure over group implication.
 * @param {object} index - security index.
 * @param {string} xmlId - start group.
 * @param {'down' | 'up'} direction - `down` = groups this one includes, `up` = groups that include it.
 * @returns {string[]} reachable groups, start excluded, in discovery order.
 */
export function groupClosure(index, xmlId, direction) {
  const cache = direction === 'down' ? index.includesCache : index.includedByCache;
  const cached = cache.get(xmlId);
  if (cached !== undefined) return cached;
  const reverse = new Map();
  if (direction === 'up') {
    for (const group of index.groups.values()) {
      for (const target of group.implied) {
        const bucket = reverse.get(target) ?? [];
        bucket.push(group.xmlId);
        reverse.set(target, bucket);
      }
    }
  }
  const seen = new Set([xmlId]);
  const order = [];
  let frontier = [xmlId];
  for (let depth = 0; depth < MAX_CLOSURE_DEPTH && frontier.length > 0; depth += 1) {
    const next = [];
    for (const id of frontier) {
      const edges = direction === 'down' ? (index.groups.get(id)?.implied ?? []) : (reverse.get(id) ?? []);
      for (const edge of edges) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        order.push(edge);
        next.push(edge);
      }
    }
    frontier = next;
  }
  cache.set(xmlId, order);
  return order;
}

/**
 * Effective permissions of one group on one model, counting implied groups and global rows.
 * @param {object} index - security index.
 * @param {string} group - group xml id.
 * @param {string} key - model key.
 * @returns {{ read: boolean, write: boolean, create: boolean, unlink: boolean, via: Array<object> }} permissions.
 */
export function effectivePerms(index, group, key) {
  const held = new Set([group, ...groupClosure(index, group, 'down')]);
  const result = { read: false, write: false, create: false, unlink: false, via: [] };
  for (const row of index.acl) {
    if (row.modelKey !== key) continue;
    if (row.group !== '' && !held.has(row.group)) continue;
    for (const op of ['read', 'write', 'create', 'unlink']) if (row.perms[op]) result[op] = true;
    result.via.push({ id: row.id, group: row.group, perms: row.perms, direct: row.group === group });
  }
  return result;
}

/**
 * Display name for a model key.
 * @param {object} index - security index.
 * @param {string} key - model key.
 * @returns {string} dotted model name when known, else a best guess.
 */
export function modelDisplay(index, key) {
  return index.modelNames.get(key) ?? key.replace(/_/g, '.');
}

/**
 * Search groups, models and gated artifacts.
 * @param {object} index - security index.
 * @param {string} query - free text, whitespace-separated AND terms.
 * @param {'all' | 'group' | 'model' | 'artifact'} type - kind filter.
 * @param {number} limit - maximum items.
 * @returns {{ items: object[], total: number, truncated: boolean }} result.
 */
export function searchSecurity(index, query, type, limit) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const items = [];
  const wants = (kind) => type === 'all' || type === kind;
  if (wants('group')) {
    for (const group of index.groups.values()) {
      items.push({
        kind: 'group', id: group.xmlId, name: group.name || group.xmlId, module: group.module, file: group.file, line: group.line,
        detail: `${group.implied.length} implied`,
        text: `${group.xmlId} ${group.name} ${group.category}`.toLowerCase(),
      });
    }
  }
  if (wants('model')) {
    for (const key of index.modelKeys) {
      const name = modelDisplay(index, key);
      const aclCount = index.acl.filter((row) => row.modelKey === key).length;
      const ruleCount = index.rules.filter((rule) => rule.modelKey === key).length;
      items.push({
        kind: 'model', id: name, name, module: '', file: '', line: 0,
        detail: `${aclCount} ACL · ${ruleCount} rules`,
        text: `${name} ${key}`.toLowerCase(),
      });
    }
  }
  if (wants('artifact')) {
    for (const owner of index.owners.values()) {
      const gated = owner.groups.length > 0 || owner.nodes.length > 0;
      if (!gated && owner.kind !== 'menu' && owner.kind !== 'action') continue;
      items.push({
        kind: 'artifact', id: owner.xmlId, name: owner.name || owner.xmlId, module: owner.module, root: owner.root, file: owner.file, line: owner.line,
        artifact: owner.kind, model: owner.model, gated,
        detail: `${owner.kind}${owner.model ? ` · ${owner.model}` : ''}`,
        text: `${owner.xmlId} ${owner.name} ${owner.model} ${owner.kind}`.toLowerCase(),
      });
    }
  }
  const matched = items.filter((item) => terms.every((term) => item.text.includes(term)));
  matched.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const clipped = matched.slice(0, limit).map(({ text, ...rest }) => rest);
  return { items: clipped, total: matched.length, truncated: matched.length > limit };
}

/**
 * Everything that names a group directly.
 * @param {object} index - security index.
 * @param {string} xmlId - group xml id.
 * @returns {Array<object>} gate entries.
 */
function gatesOf(index, xmlId) {
  const gates = [];
  for (const owner of index.owners.values()) {
    const direct = owner.groups.filter((ref) => ref.xmlId === xmlId);
    if (direct.length > 0) {
      gates.push({ scope: 'owner', root: owner.root, module: owner.module, negated: direct.some((ref) => ref.negated), owner: owner.xmlId, kind: owner.kind, name: owner.name, model: owner.model, file: owner.file, line: owner.line });
    }
    for (const node of owner.nodes) {
      const hit = node.groups.filter((ref) => ref.xmlId === xmlId);
      if (hit.length > 0) {
        gates.push({ scope: 'node', root: owner.root, negated: hit.some((ref) => ref.negated), owner: owner.xmlId, module: owner.module, kind: owner.kind, name: owner.name, model: owner.model, tag: node.tag, file: owner.file, line: node.line });
      }
    }
  }
  return gates;
}

/**
 * Trace one group: hierarchy, ACL, record rules and the artifacts it gates.
 * @param {object} index - security index.
 * @param {string} id - group xml id (short ids resolve when unique).
 * @returns {object | { error: string, candidates?: string[] }} trace or error.
 */
export function traceGroup(index, id) {
  const resolved = resolveKey(index.groups, id);
  if (resolved.key === null) return { error: resolved.ambiguous.length > 0 ? 'ambiguous-group' : 'unknown-group', candidates: resolved.ambiguous };
  const group = index.groups.get(resolved.key);
  const includes = groupClosure(index, group.xmlId, 'down');
  const includedBy = groupClosure(index, group.xmlId, 'up');
  const own = new Set([group.xmlId]);
  const inherited = new Set(includes);
  const aclDirect = index.acl.filter((row) => own.has(row.group));
  const aclInherited = index.acl.filter((row) => inherited.has(row.group)).map((row) => ({ ...row, via: row.group }));
  const aclGlobal = index.acl.filter((row) => row.group === '');
  const ruleOf = (set) => index.rules.filter((rule) => rule.groups.some((g) => set.has(g)));
  const modelSummary = new Map();
  for (const key of new Set([...aclDirect, ...aclInherited].map((row) => row.modelKey))) {
    const perms = effectivePerms(index, group.xmlId, key);
    const sources = [...aclDirect, ...aclInherited].filter((row) => row.modelKey === key);
    const seen = new Set();
    const via = [];
    for (const row of sources) {
      const direct = own.has(row.group);
      const marker = `${row.group}\u0000${direct}`;
      if (seen.has(marker)) continue;
      seen.add(marker);
      via.push({ group: row.group, direct });
    }
    via.sort((left, right) => (left.direct === right.direct ? left.group.localeCompare(right.group) : left.direct ? -1 : 1));
    modelSummary.set(key, { model: modelDisplay(index, key), key, read: perms.read, write: perms.write, create: perms.create, unlink: perms.unlink, via });
  }
  return {
    kind: 'group',
    group: { xmlId: group.xmlId, name: group.name, category: group.category, comment: group.comment, file: group.file, line: group.line, declared: group.declared, users: group.users, implied: group.implied },
    includes: includes.map((xmlId) => ({ xmlId, name: index.groups.get(xmlId)?.name ?? '' })),
    includedBy: includedBy.map((xmlId) => ({ xmlId, name: index.groups.get(xmlId)?.name ?? '' })),
    models: [...modelSummary.values()].sort((left, right) => left.model.localeCompare(right.model)),
    acl: { direct: aclDirect, inherited: aclInherited, global: aclGlobal.length },
    rules: { direct: ruleOf(own), inherited: ruleOf(inherited) },
    gates: gatesOf(index, group.xmlId),
    warnings: group.declared === 0 ? [{ code: 'undeclared-group', message: 'The group is referenced but no res.groups record for it was found in the scanned roots.' }] : [],
  };
}

/**
 * Trace one model: ACL matrix per group, record rules and the artifacts that use it.
 * @param {object} index - security index.
 * @param {string} name - model name (dotted or underscored).
 * @returns {object} trace.
 */
export function traceModel(index, name) {
  const key = modelKey(name);
  const rows = index.acl.filter((row) => row.modelKey === key);
  const rules = index.rules.filter((rule) => rule.modelKey === key);
  const display = modelDisplay(index, key);
  const groups = [...new Set(rows.map((row) => row.group))].map((group) => {
    const direct = { read: false, write: false, create: false, unlink: false };
    const sources = rows.filter((row) => row.group === group);
    for (const row of sources) for (const op of Object.keys(direct)) if (row.perms[op]) direct[op] = true;
    return {
      group,
      name: group === '' ? '(all users — no group)' : (index.groups.get(group)?.name ?? ''),
      global: group === '',
      perms: direct,
      rows: sources.map((row) => ({ id: row.id, file: row.file, line: row.line, perms: row.perms })),
      grantedAlsoTo: group === '' ? [] : groupClosure(index, group, 'up'),
    };
  }).sort((left, right) => (left.global === right.global ? left.group.localeCompare(right.group) : left.global ? -1 : 1));
  const used = [];
  for (const owner of index.owners.values()) {
    if (modelKey(owner.model) === key && owner.model.length > 0) used.push({ xmlId: owner.xmlId, kind: owner.kind, root: owner.root, module: owner.module, name: owner.name, file: owner.file, line: owner.line, gated: owner.groups.length > 0 || owner.nodes.length > 0 });
  }
  const warnings = [];
  if (rows.length === 0) warnings.push({ code: 'no-acl', message: 'No ir.model.access row grants this model to anyone. Non-admin users get access denied.' });
  if (rows.some((row) => row.group === '')) warnings.push({ code: 'ungrouped-acl', message: 'An ACL row has no group, so it applies to every user.' });
  if (rules.some((rule) => rule.global && rule.active)) warnings.push({ code: 'global-rule', message: 'A global record rule applies to every user and cannot be bypassed by adding groups.' });
  return {
    kind: 'model', model: display, key,
    groups, rules: rules.map((rule) => ({ ...rule, groupNames: rule.groups.map((g) => ({ xmlId: g, name: index.groups.get(g)?.name ?? '' })) })),
    used, warnings,
  };
}

/**
 * Trace one view, menu, action or gated record: which groups reach it and what they may do.
 * @param {object} index - security index.
 * @param {string} id - xml id.
 * @returns {object | { error: string, candidates?: string[] }} trace or error.
 */
export function traceArtifact(index, id) {
  const resolved = resolveKey(index.owners, id);
  if (resolved.key === null) return { error: resolved.ambiguous.length > 0 ? 'ambiguous-artifact' : 'unknown-artifact', candidates: resolved.ambiguous };
  const owner = index.owners.get(resolved.key);
  let model = owner.model;
  let actionId = '';
  const warnings = [];
  const chain = [];
  if (owner.kind === 'menu') {
    const seen = new Set();
    let current = owner;
    for (let depth = 0; current !== undefined && depth < MAX_MENU_DEPTH; depth += 1) {
      if (seen.has(current.xmlId)) {
        warnings.push({ code: 'menu-cycle', message: `Menu parent cycle at ${current.xmlId}.` });
        break;
      }
      seen.add(current.xmlId);
      chain.push({ xmlId: current.xmlId, name: current.name, groups: current.groups });
      current = current.parent.length > 0 ? index.owners.get(current.parent) : undefined;
    }
    if (owner.action.length > 0) {
      actionId = owner.action;
      const action = index.owners.get(actionId);
      if (action !== undefined) model = action.model;
      else warnings.push({ code: 'unresolved-action', message: `Menu action ${actionId} is not in the scanned roots.` });
    }
  }
  const gateSets = [];
  const ownGroups = owner.kind === 'menu' ? chain.flatMap((entry) => entry.groups) : owner.groups;
  if (owner.kind === 'menu') {
    for (const entry of chain) if (entry.groups.length > 0) gateSets.push({ source: entry.xmlId, groups: entry.groups });
    if (actionId.length > 0) {
      const action = index.owners.get(actionId);
      if (action !== undefined && action.groups.length > 0) gateSets.push({ source: action.xmlId, groups: action.groups });
    }
  } else if (owner.groups.length > 0) {
    gateSets.push({ source: owner.xmlId, groups: owner.groups });
  }
  const key = modelKey(model);
  const reachOf = (refs) => [...new Set(refs.filter((ref) => !ref.negated).map((ref) => ref.xmlId))].map((group) => ({
    group,
    name: index.groups.get(group)?.name ?? '',
    perms: key.length > 0 ? effectivePerms(index, group, key) : null,
  }));
  const reach = reachOf(gateSets.flatMap((set) => set.groups));
  const nodeReach = reachOf(owner.nodes.flatMap((node) => node.groups));
  if (model.length === 0 && owner.kind !== 'record') warnings.push({ code: 'model-unknown', message: 'The model could not be determined, so ACL reach is not computed.' });
  if (key.length > 0 && reach.length > 0 && reach.every((entry) => entry.perms && !entry.perms.read)) {
    warnings.push({ code: 'gate-without-read', message: 'No gating group has read access to the model through its own or implied groups. Users reach the data only through some other group they also hold; a flag group such as base.group_no_one is a normal cause.' });
  }
  if (gateSets.length === 0 && owner.nodes.length === 0) warnings.push({ code: 'ungated', message: 'No group restriction is declared: every user who can reach the model sees it.' });
  if (owner.kind === 'view' && owner.inheritId.length > 0 && index.owners.has(owner.inheritId)) {
    const parent = index.owners.get(owner.inheritId);
    if (parent.groups.length > 0) warnings.push({ code: 'parent-gated', message: `The parent view ${parent.xmlId} is itself restricted to ${parent.groups.map((ref) => ref.xmlId).join(', ')}.` });
  }
  return {
    kind: 'artifact',
    artifact: { xmlId: owner.xmlId, kind: owner.kind, root: owner.root, module: owner.module, recordModel: owner.recordModel, name: owner.name, model, file: owner.file, line: owner.line, inheritId: owner.inheritId, action: actionId },
    gates: gateSets,
    menuChain: chain,
    nodes: owner.nodes,
    reach,
    nodeReach,
    rules: key.length > 0 ? index.rules.filter((rule) => rule.modelKey === key).map((rule) => ({ xmlId: rule.xmlId, name: rule.name, global: rule.global, groups: rule.groups, domain: rule.domain, perms: rule.perms })) : [],
    ownGroups,
    warnings,
  };
}

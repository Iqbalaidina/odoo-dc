/**
 * Transport-free core of the Odoo design console: root discovery, the view,
 * Python and security indexes, and every read action (`readAction`). The
 * HTTP route (`index.js`) and the CLI (`cli/odoo-dc.mjs`) are thin adapters;
 * this module never imports either of them.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { indexViewFile, parseArch, parseViewFile, qualifyXmlIdRefs, scanRecordFields } from './parse.js';
import { parsePythonFile, parseSelectionLiteral } from './python.js';
import { buildPythonIndex, resolveMethodChain, findCallers, findCallees, findRelatedDefinitions, searchPython, resolveModel } from './python_index.js';
import { buildMethodFlow } from './python_flow.js';
import { buildSecurityIndex, parseAccessCsv, parseSecurityXml, searchSecurity, traceArtifact, traceGroup, traceModel } from './security.js';
import { builderMeta, classifyFields, detectOdooVersion } from './builder.js';
import { ApplyError, dependsClosure, locateModule, readPlanContext } from './builder_apply.js';

/** Console protocol version, echoed in responses so a reload is observable. */
export const CONSOLE_VERSION = 26;

const DEFAULT_CACHE_TTL_MS = 20_000;

const DEFAULT_INDEX_CONCURRENCY = 16;

const COMPOSE_CACHE_TTL_MS = 30_000;

const PARSE_CACHE_LIMIT = 240;

const MAX_PY_FILES = 12_000;

const MAX_PY_MODULES = 3_000;

const MAX_PY_FILE_BYTES = 1_048_576;

const PY_CACHE_TTL_MS = 60_000;

const PY_FILE_CACHE_LIMIT = 80;

const PY_RELEVANT_DIRS = ['models', 'wizard', 'report', 'controllers'];

const WALK_CACHE_TTL_MS = 30_000;

const DEFAULT_MAX_FILES = 8_000;

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

const ROOTS_TTL_MS = 15_000;

const MAX_DETAIL_VIEWS = 400;

const MAX_SEARCH_RESULTS = 200;

const MAX_RELATED_RESULTS = 200;

const MAX_QUERY_LENGTH = 200;

const MAX_RELATIVE_PATH = 512;

const WALK_DEPTH = 10;

const DETAIL_BUDGET_BYTES = 3.5 * 1024 * 1024;

const FILE_CACHE_LIMIT = 24;

const MAX_EXTRA_ROOTS = 8;

const ENTERPRISE_PATTERN = /^(odoo[-_])?enterprise([-_]?\d+)?$/i;

export const MAX_EDIT_BODY_BYTES = 4 * 1024 * 1024;

export const MAX_EDIT_SOURCE = 2 * 1024 * 1024;

const MAX_COMPOSE_DEPTH = 20;

const MAX_COMPOSED_NODES = 12_000;

const MAX_COMPOSE_VIEWS = 60;

/** Bound on the module dependency graph walked while ordering inheritors. */
const MAX_RANK_MODULES = 400;

const MAX_MODULE_VIEWS = 1_000;

const MAX_REPORT_TEMPLATES = 40;

const MAX_REPORT_DEPTH = 6;

const MAX_ACTIONS_RESULTS = 400;

const MAX_ACTION_VIEWS = 30;

const MAX_RELATED_ACTIONS = 50;

const MAX_XPATH_EXPR = 2_000;

export const MAX_XPATH_PAYLOAD = 64 * 1024;

const MAX_XPATH_MATCHES = 24;

export const MAX_BUILD_BODY_BYTES = 256 * 1024;

/** Bound on the field rows a `fieldtokens` request may translate. */
export const MAX_FIELD_TOKENS = 400;

/** Builder field types the plan generator understands (Python field class names lowercased). */
const BUILDER_FIELD_TYPES = new Set(['char', 'text', 'html', 'integer', 'float', 'monetary', 'boolean', 'date', 'datetime', 'selection', 'binary', 'many2one', 'one2many', 'many2many']);

/** Directory names never descended into while walking an addons root. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  'venv',
  '.venv',
  '.tox',
  'site-packages',
  '.mypy_cache',
  '.pytest_cache',
  '.odoo-data',
  '.testdata',
  'htmlcov',
]);

/** Addons directory suffixes detected under each known workspace base. */
const ROOT_SUFFIXES = [
  ['custom-addons', 'Custom addons'],
  ['custom_addons', 'Custom addons'],
  ['custom', 'Custom addons'],
  ['addons', 'Addons'],
  ['odoo/addons', 'Odoo core addons'],
  ['odoo/odoo/addons', 'Odoo base addons'],
  ['odoo', 'Odoo'],
];

/**
 * Resolve the plugin options with bounded defaults.
 * @param {unknown} config - the Loader row's config.
 * @returns {{ roots: Array<{ path: string, label: string }>, cacheTtlMs: number, maxFiles: number, maxFileBytes: number }} resolved options.
 */
export function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const roots = [];
  if (Array.isArray(source.roots)) {
    for (const entry of source.roots) {
      if (typeof entry === 'string' && entry.length > 0) {
        roots.push({ path: entry, label: basename(entry) || entry });
      } else if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.length > 0) {
        roots.push({ path: entry.path, label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : basename(entry.path) || entry.path });
      }
    }
  }
  return {
    roots,
    cacheTtlMs: clampInt(source.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 2_000, 600_000),
    indexConcurrency: clampInt(source.indexConcurrency, DEFAULT_INDEX_CONCURRENCY, 1, 64),
    maxFiles: clampInt(source.maxFiles, DEFAULT_MAX_FILES, 100, 20_000),
    exclude: Array.isArray(source.exclude) ? source.exclude.filter((x)=>typeof x==='string') : [],
    maxFileBytes: clampInt(source.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 64 * 1024, 32 * 1024 * 1024),
    allowEdits: source.allowEdits !== false,
    backupOnSave: source.backupOnSave !== false,
  };
}

/**
 * Clamp one integer option.
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when the candidate is not numeric.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} the clamped integer.
 */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * Encode one absolute root path as an opaque id.
 * @param {string} path - absolute directory path.
 * @returns {string} base64url id.
 */
export function encodeRootId(path) {
  return Buffer.from(path, 'utf8').toString('base64url');
}

/**
 * Decode one opaque root id.
 * @param {string | null} id - base64url id.
 * @returns {string | undefined} the path text, or undefined when malformed.
 */
export function decodeRootId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 4096) return undefined;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a relative path points at a candidate Odoo view XML file.
 * The index keeps `views/`, `report/`, `static/src/xml/`, wizard and
 * `*view*.xml` files; module data/menu/demo XML stays out of the index.
 * @param {string} relPath - path relative to the addons root, `/`-separated.
 * @returns {boolean} true when the file should be parsed.
 */
export function isCandidateViewFile(relPath) {
  const lower = relPath.toLowerCase().replaceAll('\\', '/');
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (!base.endsWith('.xml')) return false;
  if (lower.includes('/views/') || lower.startsWith('views/')) return true;
  if (lower.includes('/report/') || lower.startsWith('report/')) return true;
  if (lower.includes('/static/src/xml/') || lower.startsWith('static/src/xml/')) return true;
  if (lower.includes('/wizard/') || lower.startsWith('wizard/')) return true;
  return base.includes('view');
}

/**
 * Count Odoo module directories below one directory, bounded by depth.
 *
 * Collections often nest modules (a workspace's `custom_addons/<client>/<module>`
 * or an OCA checkout's `custom-addons/OCA/<repo>/<module>`), so a shallow check
 * misses real addons roots. This probe stops at the first module in a branch and
 * gives up after a bounded number of directories to stay cheap during discovery.
 * @param {string} dir - absolute directory path.
 * @param {number} maxDepth - levels below `dir` that may hold `__manifest__.py`.
 * @returns {number} number of module directories found (0 when none).
 */
function countManifests(dir, maxDepth) {
  let count = 0;
  let visited = 0;
  const visit = (current, depth) => {
    if (count >= 25 || visited >= 800) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === '__manifest__.py' && entry.isFile())) {
      count += 1;
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (visited >= 800 || count >= 25) return;
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      visited += 1;
      visit(join(current, entry.name), depth + 1);
    }
  };
  visit(dir, 0);
  return count;
}

/**
 * Whether one path is `ancestor` or sits below it.
 * @param {string} path - candidate path.
 * @param {string} ancestor - ancestor directory.
 * @returns {boolean} true when `path` is at or below `ancestor`.
 */
function isPathInside(path, ancestor) {
  return path === ancestor || path.startsWith(ancestor + sep);
}

/**
 * Classify one root path.
 * @param {string} dir - absolute directory path.
 * @returns {'module' | 'addons' | 'workspace'} root kind.
 */
function rootKind(dir) {
  try {
    if (statSync(join(dir, '__manifest__.py')).isFile()) return 'module';
  } catch {
    // Not a module root.
  }
  return countManifests(dir, 3) > 0 ? 'addons' : 'workspace';
}

/**
 * Build the type lookup used to give extension views the type of the view they
 * extend. An extension arch usually starts at the patched node (xpath, field,
 * div, ...), so the arch root alone cannot tell whether it patches a form, a
 * list or a kanban.
 * @param {Map<string, object>} entries - per-file index entries.
 * @returns {{ byXmlId: Map<string, string>, byShortId: Map<string, string> }} lookup.
 */
function buildTypeLookup(entries) {
  const byXmlId = new Map();
  const byShortId = new Map();
  for (const entry of entries.values()) {
    for (const view of entry.views) {
      if (view.mode !== 'primary' || view.type === 'unknown' || view.type === '') continue;
      if (view.xmlId !== '' && !byXmlId.has(view.xmlId)) byXmlId.set(view.xmlId, view.type);
      if (view.id !== '' && !byShortId.has(view.id)) byShortId.set(view.id, view.type);
    }
  }
  return { byXmlId, byShortId };
}

/**
 * Resolve one extension view's type through its inherit_id, in place.
 * @param {{ byXmlId: Map<string, string>, byShortId: Map<string, string> }} lookup - type lookup.
 * @param {object} view - view summary or parsed view.
 * @returns {void}
 */
function resolveViewType(lookup, view) {
  if (view.mode !== 'extension' || view.type !== 'unknown' || view.inheritId === '') return;
  const reference = String(view.inheritId);
  let resolved = lookup.byXmlId.get(reference);
  if (resolved === undefined) {
    const shortId = reference.includes('.') ? reference.slice(reference.lastIndexOf('.') + 1) : reference;
    resolved = lookup.byShortId.get(shortId);
  }
  if (resolved !== undefined) {
    view.type = resolved;
    view.typeResolved = true;
  }
}

/**
 * Merge one type lookup into another (existing keys win, so the first primary
 * definition read stays authoritative).
 * @param {{ byXmlId: Map<string, string>, byShortId: Map<string, string> }} target - accumulated lookup.
 * @param {{ byXmlId: Map<string, string>, byShortId: Map<string, string> }} source - new lookup.
 * @returns {number} number of newly added entries.
 */
export function mergeTypeLookup(target, source) {
  let added = 0;
  for (const [key, value] of source.byXmlId) {
    if (target.byXmlId.has(key)) continue;
    target.byXmlId.set(key, value);
    added += 1;
  }
  for (const [key, value] of source.byShortId) {
    if (target.byShortId.has(key)) continue;
    target.byShortId.set(key, value);
  }
  return added;
}

/**
 * Recompute the per-file type maps and the byType statistic of one cached index
 * after global type resolution changed some extension views.
 * @param {object} data - cached index data.
 * @returns {void}
 */
function restateTypes(data) {
  const byType = Object.create(null);
  for (const entry of data.entries.values()) {
    for (const view of entry.views) byType[view.type] = (byType[view.type] ?? 0) + 1;
  }
  data.stats.byType = byType;
  for (const file of data.files) {
    const types = Object.create(null);
    for (const view of data.entries.get(file.path)?.views ?? []) types[view.type] = (types[view.type] ?? 0) + 1;
    file.types = types;
  }
}

/**
 * Find enterprise addons directories for one workspace base. Looks at the base
 * itself and one level below every conventional addons folder, matching names
 * such as `enterprise`, `enterprise12`, `enterprise-15`, `odoo-enterprise`.
 * @param {string} basePath - workspace root.
 * @returns {string[]} canonical enterprise directories that contain modules.
 */
function findEnterpriseRoots(basePath) {
  const found = [];
  const seen = new Set();
  const consider = (candidate) => {
    try {
      if (!statSync(candidate).isDirectory()) return;
    } catch {
      return;
    }
    if (countManifests(candidate, 3) === 0) return;
    let canonical;
    try {
      canonical = realpathSync(candidate);
    } catch {
      return;
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    found.push(canonical);
  };
  const scanChildren = (dir) => {
    let children = [];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.isDirectory() && ENTERPRISE_PATTERN.test(child.name)) consider(join(dir, child.name));
    }
  };
  scanChildren(basePath);
  for (const [suffix] of ROOT_SUFFIXES) scanChildren(join(basePath, suffix));
  return found;
}

/**
 * Host for a plain directory (CLI, scripts): one workspace, also the default.
 * @param {string} base - absolute workspace directory.
 * @returns {{ workspaces: () => Array<object>, defaultDirectory: () => string }} host.
 */
export function hostFromBase(base) {
  return {
    workspaces: () => [{ path: base, title: basename(base) }],
    defaultDirectory: () => base,
  };
}

/**
 * Discover roots through a narrow host (see `hostFromCtx`/`hostFromBase`).
 * @param {{ workspaces: () => Array<object>, defaultDirectory: () => (string | undefined) }} host - workspace source.
 * @param {{ roots: Array<{ path: string, label: string }> }} options - resolved options.
 * @returns {Array<object>} roots in display order.
 */
export function discoverRootsFor(host, options) {
  const roots = [];
  const seen = new Set();

  /**
   * Append one existing directory root.
   * @param {string} path - candidate path.
   * @param {string} label - display label.
   * @returns {void}
   */
  const push = (path, label, meta = {}) => {
    let canonical;
    try {
      canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) return;
    } catch {
      return;
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    roots.push({
      id: encodeRootId(canonical),
      path: canonical,
      label,
      kind: rootKind(canonical),
      workspace: typeof meta.workspace === 'string' ? meta.workspace : '',
      workspaceLabel: typeof meta.workspaceLabel === 'string' ? meta.workspaceLabel : '',
    });
  };

  if (options.roots.length > 0) {
    for (const entry of options.roots) push(resolve(entry.path), entry.label);
    populateRootSubfolders(roots);
    return roots;
  }
  const excluded = new Set(options.exclude);

  const bases = [];
  const seenBases = new Set();
  const workspaces = host.workspaces();
  for (const workspace of workspaces) {
    if (workspace === null || typeof workspace !== 'object' || typeof workspace.path !== 'string') continue;
    let canonical;
    try {
      canonical = realpathSync(workspace.path);
    } catch {
      continue;
    }
    if (seenBases.has(canonical)) continue;
    seenBases.add(canonical);
    const title = typeof workspace.title === 'string' && workspace.title.length > 0 ? workspace.title : basename(canonical) || canonical;
    bases.push({ path: canonical, label: title });
  }
  try {
    const fallback = host.defaultDirectory();
    if (typeof fallback === 'string' && fallback.length > 0) {
      const canonical = realpathSync(fallback);
      if (!seenBases.has(canonical)) {
        seenBases.add(canonical);
        bases.push({ path: canonical, label: basename(canonical) || canonical });
      }
    }
  } catch {
    // No default working directory in this composition.
  }

  for (const base of bases) {
    let foundConventional = false;
    for (const [suffix, label] of ROOT_SUFFIXES) {
      const candidate = join(base.path, suffix);
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      // Accept a conventional addons folder when it holds modules anywhere in a
      // bounded depth: `custom_addons/<client>/<module>` is as real as
      // `custom-addons/<module>`.
      if (countManifests(candidate, 3) === 0) continue;
      // Never add an ancestor of an addons root discovered already (the `odoo`
      // source tree above `odoo/addons`).
      if (roots.some((entry) => isPathInside(entry.path, candidate))) continue;
      if (excluded.has(basename(candidate))) continue;
      push(candidate, `${base.label} · ${label}`, { workspace: base.path, workspaceLabel: base.label });
      foundConventional = true;
    }
    if (!foundConventional && countManifests(base.path, 2) > 0) push(base.path, base.label, { workspace: base.path, workspaceLabel: base.label });
    // A project often keeps extra addons folders beside the conventional ones
    // (`enterprise12`, `_legacy`, a client collection). Add the immediate child
    // directories that hold modules, skipping ancestors/descendants of roots we
    // already found and the per-version odoo source tree.
    if (foundConventional) {
      let extras = 0;
      let children = [];
      try {
        children = readdirSync(base.path, { withFileTypes: true });
      } catch {
        children = [];
      }
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (extras >= MAX_EXTRA_ROOTS) break;
        if (!child.isDirectory()) continue;
        const name = child.name;
        if (name.startsWith('.') || name.startsWith('_') || SKIP_DIRECTORIES.has(name)) continue;
        const candidate = join(base.path, name);
        if (roots.some((entry) => isPathInside(entry.path, candidate) || isPathInside(candidate, entry.path))) continue;
        if (countManifests(candidate, 2) === 0) continue;
        if (excluded.has(name)) continue;
        push(candidate, `${base.label} · ${name}`, { workspace: base.path, workspaceLabel: base.label });
        extras += 1;
      }
    }
    // Enterprise addons live beside or under the conventional roots
    // (`enterprise`, `enterprise12`, `custom-addons/enterprise`, ...). Expose them
    // as their own root and exclude their subtree from the containing custom root
    // so modules are not indexed twice.
    for (const enterprisePath of findEnterpriseRoots(base.path)) {
      if (roots.some((entry) => entry.path === enterprisePath)) continue;
      if (roots.some((entry) => isPathInside(entry.path, enterprisePath))) continue;
      for (const entry of roots) {
        if (!isPathInside(enterprisePath, entry.path)) continue;
        entry.exclude = Array.isArray(entry.exclude) ? entry.exclude : [];
        if (!entry.exclude.includes(enterprisePath)) entry.exclude.push(enterprisePath);
      }
      push(enterprisePath, `${base.label} · Enterprise addons`, { workspace: base.path, workspaceLabel: base.label });
    }
  }
  populateRootSubfolders(roots);
  return roots;
}

/**
 * Read `addons_path` directories declared in `*.conf` files directly under one
 * workspace base. Used only to badge active subfolders in the folder filter UI.
 * @param {string} basePath - workspace directory.
 * @returns {Set<string>} canonical directory paths listed in addons_path.
 */
function readWorkspaceConfAddonsPaths(basePath) {
  const paths = new Set();
  if (typeof basePath !== 'string' || basePath.length === 0) return paths;
  let entries = [];
  try {
    entries = readdirSync(basePath, { withFileTypes: true });
  } catch {
    return paths;
  }
  const confFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.conf')).slice(0, 8);
  for (const entry of confFiles) {
    const filePath = join(basePath, entry.name);
    let text = '';
    try {
      const info = statSync(filePath);
      if (!info.isFile() || info.size > 131_072) continue;
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/^\s*addons_path\s*=\s*(.+)$/gm)) {
      for (const token of match[1].split(',')) {
        const trimmed = token.trim();
        if (trimmed.length === 0) continue;
        try {
          const canonical = realpathSync(resolve(basePath, trimmed));
          paths.add(canonical);
        } catch {
          // Ignore nonexistent addons_path entries.
        }
      }
    }
  }
  return paths;
}

/**
 * Populate toggleable subfolders for roots that group multiple module
 * collections (for example `custom-addons/custom-ddp`, `custom-addons/OCA`,
 * `custom-addons/DDP-online`, plus stray top-level modules). Flat module roots
 * such as `odoo/addons` or `enterprise` have no collection subfolders and keep
 * `subfolders = []`.
 * @param {Array<object>} roots - discovered roots (mutated in place).
 * @returns {void}
 */
function populateRootSubfolders(roots) {
  const confCache = new Map();
  const confFor = (workspace) => {
    if (!workspace) return new Set();
    if (!confCache.has(workspace)) confCache.set(workspace, readWorkspaceConfAddonsPaths(workspace));
    return confCache.get(workspace);
  };
  for (const root of roots) {
    root.subfolders = [];
    root.hasConf = false;
    if (root.kind === 'module') continue;
    const baseExcludes = Array.isArray(root.exclude) ? root.exclude : [];
    let entries = [];
    try {
      entries = readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const collections = [];
    const directModules = [];
    const confPaths = confFor(root.workspace);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('_') || SKIP_DIRECTORIES.has(entry.name)) continue;
      const candidate = join(root.path, entry.name);
      let canonical;
      try {
        canonical = realpathSync(candidate);
      } catch {
        continue;
      }
      if (baseExcludes.some((excluded) => isPathInside(canonical, excluded) || isPathInside(candidate, excluded))) continue;
      const isModule = existsSync(join(canonical, '__manifest__.py'));
      if (isModule) {
        directModules.push({ name: entry.name, path: canonical, kind: 'module', inConf: confPaths.has(canonical) });
      } else if (countManifests(canonical, 3) > 0) {
        collections.push({ name: entry.name, path: canonical, kind: 'collection', inConf: confPaths.has(canonical) });
      }
    }
    if (collections.length > 0 && collections.length + directModules.length <= 60) {
      const combined = [...collections, ...directModules];
      root.subfolders = combined;
      root.hasConf = combined.some((folder) => folder.inConf);
    }
  }
}

/**
 * Disabled subfolder names currently active for one root.
 * @param {object} state - engine state.
 * @param {object} root - discovered root.
 * @returns {Set<string>} disabled subfolder names.
 */
function disabledNamesForRoot(state, root) {
  const valid = new Set((root.subfolders ?? []).map((folder) => folder.name));
  if (valid.size === 0) return new Set();
  const dynamic = state.disabledFolders?.get(root.path);
  if (dynamic !== undefined) {
    return new Set([...dynamic].filter((name) => valid.has(name)));
  }
  const configured = Array.isArray(state.options?.exclude) ? state.options.exclude : [];
  return new Set(configured.filter((name) => valid.has(name)));
}

/**
 * Effective directory exclusions for one root (built-in enterprise exclusions
 * plus user-toggled disabled subfolders).
 * @param {object} state - engine state.
 * @param {object} root - discovered root.
 * @returns {string[]} absolute directory paths to skip.
 */
function effectiveExcludes(state, root) {
  const out = [...(root.exclude ?? [])];
  const disabled = disabledNamesForRoot(state, root);
  if (disabled.size === 0) return out;
  for (const folder of root.subfolders ?? []) {
    if (!disabled.has(folder.name)) continue;
    const joined = join(root.path, folder.name);
    if (!out.includes(joined)) out.push(joined);
    if (folder.path && !out.includes(folder.path)) out.push(folder.path);
  }
  return out;
}

/**
 * Serialize one root for the client, including its subfolder toggle state.
 * @param {object} state - engine state.
 * @param {object} root - discovered root.
 * @returns {object} JSON-ready root descriptor.
 */
export function serializeRoot(state, root) {
  const disabled = disabledNamesForRoot(state, root);
  return {
    id: root.id,
    path: root.path,
    label: root.label,
    kind: root.kind,
    workspace: root.workspace ?? '',
    workspaceLabel: root.workspaceLabel ?? '',
    hasConf: root.hasConf === true,
    subfolders: (root.subfolders ?? []).map((folder) => ({
      name: folder.name,
      kind: folder.kind,
      inConf: folder.inConf === true,
      enabled: !disabled.has(folder.name),
    })),
  };
}

/**
 * Serve roots, refreshing the discovery cache when it is stale.
 * @param {{ workspaces: () => Array<object>, defaultDirectory: () => (string | undefined) }} host - workspace source.
 * @param {object} state - engine state.
 * @returns {Array<object>} the discovered roots.
 */
export function rootsFor(host, state) {
  const now = Date.now();
  if (state.rootsCache.roots !== null && now - state.rootsCache.at < ROOTS_TTL_MS) return state.rootsCache.roots;
  const roots = discoverRootsFor(host, state.options);
  state.rootsCache = { at: now, roots };
  return roots;
}

/**
 * Resolve one requested root id against the discovered roots.
 * @param {Array<object>} roots - discovered roots.
 * @param {string | null} id - requested root id.
 * @returns {{ root?: object, error?: string }} the root, or an error code.
 */
export function resolveRoot(roots, id) {
  if (id === null || id.length === 0) {
    return roots.length > 0 ? { root: roots[0] } : { error: 'no-roots' };
  }
  const path = decodeRootId(id);
  if (path === undefined) return { error: 'unknown-root' };
  const root = roots.find((entry) => entry.path === path);
  return root === undefined ? { error: 'unknown-root' } : { root };
}

/**
 * Walk one addons root and collect candidate view XML files with their module
 * and group labels.
 * @param {string} rootPath - absolute addons root.
 * @param {{ maxFiles: number }} options - resolved options.
 * @returns {Promise<{ files: Array<{ abs: string, rel: string, module: string, group: string }>, truncated: boolean }>} collected files.
 */
/**
 * Run async work over a list with bounded concurrency.
 * @param {Array<any>} items - work items.
 * @param {number} limit - maximum in-flight operations.
 * @param {(item: any, index: number) => Promise<void>} worker - operation.
 * @returns {Promise<void>} resolves when every item is processed.
 */
async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Math.max(1, Math.min(limit, items.length || 1));
  const run = async () => {
    while (true) {
      const position = cursor;
      cursor += 1;
      if (position >= items.length) return;
      await worker(items[position], position);
    }
  };
  await Promise.all(Array.from({ length: runners }, run));
}

/**
 * Walk one addons root and collect candidate view XML files with their module
 * and group labels. Directories are traversed breadth-first with bounded
 * parallel readdir calls; files in one module are never parsed here.
 * @param {string} rootPath - absolute addons root.
 * @param {{ maxFiles: number }} options - resolved options.
 * @returns {Promise<{ files: Array<{ abs: string, rel: string, module: string, group: string }>, truncated: boolean }>} collected files.
 */
export async function collectCandidateFiles(rootPath, options, excludes = []) {
  const files = [];
  const modules = new Map();
  let truncated = false;
  const excluded = Array.isArray(excludes) ? excludes : [];
  const rootManifest = existsSync(join(rootPath, '__manifest__.py'));
  if (rootManifest) modules.set(basename(rootPath), rootPath);
  let level = [{
    abs: rootPath,
    rel: '',
    module: rootManifest ? basename(rootPath) : '',
    group: rootManifest ? basename(rootPath) : '',
    depth: 0,
  }];
  while (level.length > 0) {
    const next = [];
    await mapLimit(level, 12, async (item) => {
      if (files.length >= options.maxFiles) {
        truncated = true;
        return;
      }
      if (item.rel !== '' && excluded.some((exclude) => isPathInside(item.abs, exclude))) return;
      let entries;
      try {
        entries = await readdir(item.abs, { withFileTypes: true });
      } catch {
        return;
      }
      let dirModule = item.module;
      let dirGroup = item.group;
      const hasManifest = entries.some((entry) => entry.name === '__manifest__.py' && entry.isFile());
      if (hasManifest && item.rel !== '') {
        const module = basename(item.abs);
        const parent = item.rel.includes('/') ? item.rel.slice(0, item.rel.lastIndexOf('/')) : '';
        dirModule = module;
        dirGroup = parent === '' ? module : parent;
        // Every module directory is recorded, even when it holds no view XML:
        // its manifest still carries the dependency order composition needs.
        modules.set(module, item.abs);
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= options.maxFiles) {
          truncated = true;
          break;
        }
        const childRel = item.rel === '' ? entry.name : `${item.rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (item.depth >= WALK_DEPTH) continue;
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          if (entry.name === 'lib' && basename(item.abs) === 'static') continue;
          next.push({ abs: join(item.abs, entry.name), rel: childRel, module: dirModule, group: dirGroup, depth: item.depth + 1 });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml') && isCandidateViewFile(childRel)) {
          files.push({ abs: join(item.abs, entry.name), rel: childRel, module: dirModule, group: dirGroup });
        }
      }
    });
    level = next;
  }
  return { files, truncated, modules };
}

/**
 * Cached directory walk: TTL-based reuse so automatic index refreshes do not
 * re-traverse thousands of directories. An explicit rescan bypasses the cache.
 * @param {object} state - engine state.
 * @param {string} rootPath - absolute addons root.
 * @param {object} options - resolved options.
 * @param {boolean} forceWalk - walk even when a cached walk exists.
 * @returns {Promise<{ files: Array<object>, truncated: boolean }>} collected files.
 */
async function collectCandidateFilesCached(state, rootPath, options, forceWalk, excludes = []) {
  const key = `${rootPath}\u0000${[...(excludes ?? [])].sort().join('|')}`;
  const cached = state.walkCache.get(key);
  if (!forceWalk && cached !== undefined && Date.now() - cached.at < WALK_CACHE_TTL_MS) {
    return { files: cached.files, truncated: cached.truncated, modules: cached.modules ?? new Map() };
  }
  const collected = await collectCandidateFiles(rootPath, options, excludes ?? []);
  state.walkCache.set(key, { at: Date.now(), files: collected.files, truncated: collected.truncated, modules: collected.modules });
  return collected;
}

/**
 * Rebuild the per-root summary index, reusing unchanged per-file parse results.
 * @param {object} state - engine state.
 * @param {object} root - resolved root.
 * @param {Map<string, object> | undefined} previous - previous per-file entries.
 * @returns {Promise<{ files: Array<object>, entries: Map<string, object>, stats: object }>} the rebuilt index.
 */
/**
 * Resolve view types for one root's entries against the accumulated corpus
 * lookup, and re-resolve extension views cached for other roots when new primary
 * types appear.
 * @param {object} state - engine state.
 * @param {string} rootPath - root that owns the entries.
 * @param {Map<string, object>} entries - per-file entries.
 * @returns {object} type lookup.
 */
function finalizeIndexTypes(state, rootPath, entries) {
  const typeLookup = buildTypeLookup(entries);
  const added = mergeTypeLookup(state.globalTypes, typeLookup);
  for (const entry of entries.values()) {
    for (const view of entry.views) resolveViewType(state.globalTypes, view);
  }
  if (added > 0) {
    // A newly indexed root can resolve extension views cached from another root
    // (custom addons inheriting a core view, for example).
    for (const [path, cached] of state.indexCache) {
      if (path === rootPath || cached.data === undefined) continue;
      let changed = false;
      for (const entry of cached.data.entries.values()) {
        for (const view of entry.views) {
          if (view.mode !== 'extension' || view.type !== 'unknown') continue;
          resolveViewType(state.globalTypes, view);
          if (view.typeResolved === true) changed = true;
        }
      }
      if (changed) restateTypes(cached.data);
    }
  }
  return typeLookup;
}

/**
 * Build the files list and type/module counts from per-file entries.
 * @param {Map<string, object>} entries - per-file entries.
 * @returns {{ files: Array<object>, byType: object, byModule: Map<string, number> }} summary.
 */
function summarizeEntries(entries) {
  const files = [];
  const byType = Object.create(null);
  const byModule = new Map();
  let actions = 0;
  for (const entry of entries.values()) {
    // A file that only declares window actions (a wizard/menu/action file) is
    // still listed so the Actions panel can open it and resolve its views.
    if (entry.views.length === 0 && (entry.actions?.length ?? 0) === 0) continue;
    const types = Object.create(null);
    for (const view of entry.views) {
      types[view.type] = (types[view.type] ?? 0) + 1;
      byType[view.type] = (byType[view.type] ?? 0) + 1;
    }
    const actionCount = (entry.actions ?? []).filter((action) => action.kind !== 'windowView').length;
    actions += actionCount;
    files.push({
      path: entry.rel,
      module: entry.module,
      group: entry.group,
      views: entry.views.length,
      types,
      actions: actionCount,
      mtimeMs: entry.mtimeMs,
    });
    const key = entry.module === '' ? '—' : entry.module;
    byModule.set(key, (byModule.get(key) ?? 0) + entry.views.length);
  }
  files.sort((left, right) => left.group.localeCompare(right.group) || left.module.localeCompare(right.module) || left.path.localeCompare(right.path));
  return { files, byType, byModule, actions };
}

/**
 * Compose the public stats object from one summary plus build counters.
 * @param {{ files: Array<object>, byType: object, byModule: Map<string, number> }} summary - entry summary.
 * @param {object} [extra] - build counters and flags.
 * @returns {object} stats.
 */
function statsFromSummary(summary, extra = {}) {
  return {
    files: summary.files.length,
    candidateFiles: extra.candidateFiles ?? 0,
    views: summary.files.reduce((total, file) => total + file.views, 0),
    actions: summary.actions ?? 0,
    modules: summary.byModule.size,
    byType: summary.byType,
    byModule: Object.fromEntries([...summary.byModule.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    parsed: extra.parsed ?? 0,
    reused: extra.reused ?? 0,
    skippedTooLarge: extra.skippedTooLarge ?? 0,
    failed: extra.failed ?? 0,
    truncated: extra.truncated ?? false,
    builtAt: new Date().toISOString(),
  };
}

/**
 * Rebuild the global view/model locator maps from every cached index. Called
 * after an index build or an in-place save update so compose/report resolution
 * always sees current rows.
 * @param {object} state - engine state.
 * @returns {void}
 */
export function rebuildLocators(state) {
  state.moduleDirCache.clear();
  state.moduleDepsCache.clear();
  state.viewLocator.clear();
  state.viewShortLocator.clear();
  state.modelLocator.clear();
  for (const [rootPath, cached] of state.indexCache) {
    const data = cached.data;
    if (data === undefined || data.entries === undefined) continue;
    if (data.modules !== undefined) {
      for (const [name, dir] of data.modules) {
        if (typeof name === 'string' && name.length > 0 && !state.moduleDirCache.has(name)) state.moduleDirCache.set(name, dir);
      }
    }
    for (const entry of data.entries.values()) {
      if (typeof entry.module === 'string' && entry.module.length > 0 && !state.moduleDirCache.has(entry.module)) {
        // The indexed path tells where the module directory sits, including
        // collection folders (`custom_addons/<client>/<module>`), without a
        // second directory walk.
        const segments = String(entry.rel ?? '').split('/');
        const index = segments.lastIndexOf(entry.module);
        if (index >= 0) state.moduleDirCache.set(entry.module, join(rootPath, ...segments.slice(0, index + 1)));
      }
      for (const view of entry.views) {
        if (typeof view.xmlId !== 'string' || view.xmlId.length === 0) continue;
        const location = { rootPath, module: entry.module, file: entry.rel, view };
        if (!state.viewLocator.has(view.xmlId)) state.viewLocator.set(view.xmlId, location);
        if (view.id.length > 0 && !state.viewShortLocator.has(view.id)) state.viewShortLocator.set(view.id, location);
        if (typeof view.model === 'string' && view.model.length > 0) {
          let bucket = state.modelLocator.get(view.model);
          if (bucket === undefined) {
            bucket = new Map();
            state.modelLocator.set(view.model, bucket);
          }
          if (!bucket.has(view.xmlId)) bucket.set(view.xmlId, location);
        }
      }
    }
  }
}

/**
 * Stat, read and summarize one candidate file.
 * @param {object} state - engine state.
 * @param {{ abs: string, rel: string, module: string, group: string }} item - candidate file.
 * @param {Map<string, object> | undefined} previous - previous per-file entries.
 * @returns {Promise<{ status: string, entry?: object }>} outcome.
 */
async function indexOneFile(state, item, previous) {
  let info;
  try {
    info = await stat(item.abs);
  } catch {
    return { status: 'failed' };
  }
  if (!info.isFile()) return { status: 'skipped' };
  if (info.size > state.options.maxFileBytes) return { status: 'too-large' };
  const cached = previous?.get(item.rel);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { status: 'reused', entry: cached };
  }
  let text;
  try {
    text = await readFile(item.abs, 'utf8');
  } catch {
    return { status: 'failed' };
  }
  let indexed;
  try {
    indexed = indexViewFile(text, { moduleName: item.module, filePath: item.rel });
  } catch {
    return { status: 'failed' };
  }
  const views = Array.isArray(indexed.views) ? indexed.views.filter((view) => typeof view.id === 'string' && view.id.length > 0) : [];
  const actions = Array.isArray(indexed.actions)
    ? indexed.actions.filter((action) => typeof action.id === 'string' && action.id.length > 0)
    : [];
  return {
    status: 'parsed',
    entry: {
      rel: item.rel,
      module: item.module,
      group: item.group,
      mtimeMs: info.mtimeMs,
      size: info.size,
      views,
      actions,
      otherRecordCount: indexed.otherRecordCount ?? 0,
    },
  };
}

/**
 * Rebuild one root's summary index with bounded parallel file I/O. Changed files
 * are read and parsed concurrently; unchanged files are reused by mtime/size.
 * @param {object} state - engine state.
 * @param {object} root - resolved root.
 * @param {Map<string, object> | undefined} previous - previous per-file entries.
 * @returns {Promise<{ files: Array<object>, entries: Map<string, object>, stats: object, typeLookup: object }>} the rebuilt index.
 */
async function rebuildIndex(state, root, previous, forceWalk = false) {
  const options = state.options;
  const collected = await collectCandidateFilesCached(state, root.path, options, forceWalk, effectiveExcludes(state, root));
  const slots = new Array(collected.files.length);
  let parsed = 0;
  let reused = 0;
  let failed = 0;
  let skippedTooLarge = 0;
  let cursor = 0;
  const workers = Math.max(1, Math.min(options.indexConcurrency, collected.files.length || 1));
  const worker = async () => {
    while (true) {
      const position = cursor;
      cursor += 1;
      if (position >= collected.files.length) return;
      const outcome = await indexOneFile(state, collected.files[position], previous);
      slots[position] = outcome;
      if (outcome.status === 'parsed') parsed += 1;
      else if (outcome.status === 'reused') reused += 1;
      else if (outcome.status === 'too-large') skippedTooLarge += 1;
      else if (outcome.status === 'failed') failed += 1;
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));

  const entries = new Map();
  for (const slot of slots) {
    if (slot !== undefined && slot.entry !== undefined) entries.set(slot.entry.rel, slot.entry);
  }
  const typeLookup = finalizeIndexTypes(state, root.path, entries);
  const summary = summarizeEntries(entries);
  const stats = statsFromSummary(summary, {
    candidateFiles: collected.files.length,
    parsed,
    reused,
    skippedTooLarge,
    failed,
    truncated: collected.truncated,
  });
  return { files: summary.files, entries, stats, typeLookup, modules: collected.modules };
}

export function ensureIndex(state, root, refresh) {
  const cached = state.indexCache.get(root.path);
  if (!refresh && cached?.data !== undefined && Date.now() - cached.at < state.options.cacheTtlMs) return Promise.resolve(cached.data);
  if (cached?.promise !== undefined) return cached.promise;
  const promise = (async () => {
    const data = await rebuildIndex(state, root, cached?.data?.entries, refresh === true);
    state.indexCache.set(root.path, { at: Date.now(), data });
    rebuildLocators(state);
    return data;
  })();
  promise.catch(() => {
    state.indexCache.delete(root.path);
  });
  state.indexCache.set(root.path, { at: cached?.at ?? 0, promise });
  return promise;
}

/**
 * Resolve one `<root>/<relative path>` pair, refusing traversal.
 * @param {object} root - resolved root.
 * @param {string} rel - requested relative path.
 * @returns {{ rel: string, abs: string } | undefined} the resolved file, or undefined when invalid.
 */
export function resolveFileUnderRoot(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_RELATIVE_PATH) return undefined;
  const normalized = rel.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes('\0')) return undefined;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined;
  if (!normalized.toLowerCase().endsWith('.xml')) return undefined;
  const abs = resolve(root.path, normalized);
  const prefix = root.path.endsWith(sep) ? root.path : root.path + sep;
  if (!abs.startsWith(prefix)) return undefined;
  return { rel: normalized, abs };
}

/**
 * Summary fields of one view, without arch, source, or preview.
 * @param {object} view - parsed view.
 * @returns {object} summary.
 */
function viewSummary(view) {
  const {
    id, xmlId, kind, name, model, type, rawType, inheritId, mode, priority, line, fieldCount, typeResolved,
  } = view;
  return { id, xmlId, kind, name, model, type, rawType, inheritId, mode, priority, line, fieldCount: fieldCount ?? 0, typeResolved: typeResolved === true };
}

/**
 * Score one view against a search query.
 * @param {string} query - lowercased query.
 * @param {object} view - view summary.
 * @param {object} entry - index file entry.
 * @returns {number} relevance score.
 */
function scoreView(query, view, entry) {
  let score = 0;
  const xmlId = String(view.xmlId ?? '').toLowerCase();
  const name = String(view.name ?? '').toLowerCase();
  const model = String(view.model ?? '').toLowerCase();
  const inheritId = String(view.inheritId ?? '').toLowerCase();
  const module = String(entry.module ?? '').toLowerCase();
  const file = String(entry.rel ?? '').toLowerCase();
  if (xmlId === query) score += 1_000;
  else if (xmlId.endsWith(`.${query}`)) score += 850;
  else if (xmlId.includes(query)) score += 700;
  if (model === query) score += 800;
  else if (model.includes(query)) score += 500;
  if (name === query) score += 600;
  else if (name.includes(query)) score += 350;
  if (view.type === query) score += 450;
  const fieldText = String(view.fieldText ?? '').toLowerCase();
  if (fieldText.length > 0) {
    if (fieldText.split(' ').includes(query)) score += 550;
    else if (fieldText.includes(query)) score += 300;
  }
  if (inheritId.includes(query)) score += 250;
  if (module === query) score += 200;
  else if (file.includes(query)) score += 120;
  return score + 40;
}

/**
 * Search every indexed view under one root.
 * @param {object} index - index snapshot.
 * @param {string} rawQuery - raw query text.
 * @param {string} typeFilter - normalized type filter, or ''.
 * @param {number} limit - result cap.
 * @returns {{ items: Array<object>, total: number, truncated: boolean }} search results.
 */
function searchIndex(index, rawQuery, typeFilter, limit, lookup) {
  const query = rawQuery.trim().toLowerCase();
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  const items = [];
  let total = 0;
  for (const [rel, entry] of index.entries) {
    const fileLower = rel.toLowerCase();
    for (const view of entry.views) {
      if (lookup !== undefined) resolveViewType(lookup, view);
      if (typeFilter !== '' && view.type !== typeFilter) continue;
      const haystacks = [
        String(view.xmlId ?? '').toLowerCase(),
        String(view.name ?? '').toLowerCase(),
        String(view.model ?? '').toLowerCase(),
        String(view.type ?? '').toLowerCase(),
        String(view.inheritId ?? '').toLowerCase(),
        String(view.id ?? '').toLowerCase(),
        String(view.fieldText ?? '').toLowerCase(),
        String(entry.module ?? '').toLowerCase(),
        fileLower,
      ];
      if (!tokens.every((token) => haystacks.some((haystack) => haystack.includes(token)))) continue;
      total += 1;
      items.push({
        file: rel,
        module: entry.module,
        group: entry.group,
        ...viewSummary(view),
        score: scoreView(query, view, entry),
      });
    }
  }
  items.sort((left, right) => right.score - left.score || String(left.xmlId).localeCompare(String(right.xmlId)));
  return { items: items.slice(0, limit), total, truncated: total > limit };
}

/**
 * Find one indexed view by xml id, falling back to a unique short-id match.
 * @param {object} index - index snapshot.
 * @param {string} xmlId - requested view id.
 * @returns {{ file: string, module: string, group: string, view: object } | null} the match.
 */
function findView(index, xmlId) {
  const wanted = xmlId.trim();
  if (wanted.length === 0) return null;
  // A qualified id must match exactly (or by its owned record id); falling back
  // to a bare short-id match would pick another module's view that reuses the
  // same record id, which is common for localized partner/order views.
  const qualified = wanted.includes('.');
  const shortId = qualified ? wanted.slice(wanted.lastIndexOf('.') + 1) : wanted;
  let fallback = null;
  for (const [rel, entry] of index.entries) {
    for (const view of entry.views) {
      if (view.xmlId === wanted) return { file: rel, module: entry.module, group: entry.group, view };
      if (!qualified && view.id === wanted) return { file: rel, module: entry.module, group: entry.group, view };
      if (!qualified && fallback === null && (view.xmlId === shortId || view.id === shortId)) {
        fallback = { file: rel, module: entry.module, group: entry.group, view };
      }
    }
  }
  return fallback;
}

/**
 * Whether an inherit_id reference resolves to one view summary.
 * @param {string} ref - raw inherit_id value.
 * @param {object} view - target view summary.
 * @returns {boolean} true when the reference names the view.
 */
function inheritRefMatches(ref, view) {
  const value = String(ref ?? '').trim().toLowerCase();
  if (value.length === 0) return false;
  const xmlId = String(view.xmlId ?? '').toLowerCase();
  const id = String(view.id ?? '').toLowerCase();
  if (value === xmlId) return true;
  // A qualified reference names one module. Matching it by its record-id tail
  // would attach the view to another module's view that reuses that record id
  // (`calendar.res_users_view_form` vs `mail.res_users_view_form`), which
  // reorders the whole inheritance tree.
  if (value.includes('.')) return false;
  return value === id;
}

/**
 * Build the inheritance neighbourhood of one view.
 * @param {object} index - index snapshot.
 * @param {string} xmlId - requested view id.
 * @returns {object} target, parent, and inheriting views.
 */
function relatedIndex(index, xmlId, lookup) {
  const match = findView(index, xmlId);
  if (match === null) return { target: null, parent: null, children: [], actions: [], actionsTotal: 0 };
  if (lookup !== undefined) {
    resolveViewType(lookup, match.view);
    if (match.view.inheritId.length > 0) {
      const parentMatch = findView(index, match.view.inheritId);
      if (parentMatch !== null) resolveViewType(lookup, parentMatch.view);
    }
  }
  const target = { file: match.file, module: match.module, group: match.group, ...viewSummary(match.view) };
  const parent = match.view.inheritId.length > 0 ? findView(index, match.view.inheritId) : null;
  const children = [];
  for (const [rel, entry] of index.entries) {
    for (const view of entry.views) {
      if (view.inheritId.length === 0) continue;
      if (lookup !== undefined) resolveViewType(lookup, view);
      if (!inheritRefMatches(view.inheritId, match.view)) continue;
      children.push({ file: rel, module: entry.module, group: entry.group, ...viewSummary(view) });
    }
  }
  children.sort((left, right) => String(left.xmlId).localeCompare(String(right.xmlId)));
  const referencing = relatedActions(index, match.view);
  return {
    target,
    parent: parent === null ? null : { file: parent.file, module: parent.module, group: parent.group, ...viewSummary(parent.view) },
    children: children.slice(0, MAX_RELATED_RESULTS),
    childrenTotal: children.length,
    actions: referencing.actions,
    actionsTotal: referencing.actionsTotal,
  };
}

/**
 * Build an O(1) view lookup for the current root's index, keyed by qualified
 * xml id and by bare record id. Used to resolve window-action `view_id` refs
 * without scanning the index once per reference.
 * @param {object} index - index snapshot.
 * @returns {Map<string, object>} abstract view id -> location.
 */
function buildViewRefLookup(index) {
  const lookup = new Map();
  for (const [rel, entry] of index.entries) {
    for (const view of entry.views) {
      const location = { rootPath: null, module: entry.module, file: rel, view };
      if (typeof view.xmlId === 'string' && view.xmlId.length > 0) lookup.set(view.xmlId, location);
      if (typeof view.id === 'string' && view.id.length > 0 && !lookup.has(view.id)) lookup.set(view.id, location);
    }
  }
  return lookup;
}

/**
 * Resolve one action view reference (`base.view_partner_form`, or a bare record
 * id) against the current root, then against every indexed root.
 * @param {Map<string, object>} lookup - current-root view lookup.
 * @param {object} state - engine state.
 * @param {string} ref - raw reference.
 * @param {string} currentRootId - encoded id of the root being listed.
 * @returns {object | null} resolved view descriptor.
 */
function resolveActionViewRef(lookup, state, ref, currentRootId) {
  const value = String(ref ?? '').trim();
  if (value.length === 0) return null;
  const local = lookup.get(value) ?? lookup.get(shortIdOf(value));
  const location = local !== undefined
    ? local
    : state.viewLocator.get(value) ?? (value.includes('.') ? undefined : state.viewShortLocator.get(shortIdOf(value)));
  if (location === undefined) return null;
  const view = location.view;
  return {
    found: true,
    xmlId: view.xmlId,
    id: view.id,
    name: view.name,
    type: view.type,
    archMode: view.mode,
    file: location.file,
    module: location.module,
    rootId: location.rootPath === null ? currentRootId : encodeRootId(location.rootPath),
  };
}

/**
 * Join the window actions and their `ir.actions.act_window.view` links of one
 * index into one action list with a normalized `views` array.
 *
 * The resolved list is: explicit act_window.view links (by sequence), then the
 * default `view_id` for the first `view_mode` token, then implicit defaults for
 * every remaining mode. `default` rows have no `viewRef`.
 * @param {object} index - index snapshot.
 * @returns {{ actions: Array<object>, links: Array<object>, total: number }} joined actions.
 */
function collectIndexActions(index) {
  const rawWindows = [];
  const links = [];
  for (const [rel, entry] of index.entries) {
    for (const action of entry.actions ?? []) {
      const row = { ...action, file: rel, module: entry.module, group: entry.group };
      if (row.kind === 'windowView') links.push(row);
      else rawWindows.push(row);
    }
  }

  // Odoo lets a later module patch the same qualified action xml id with only
  // the fields it changes (`<record id="account.action_x" model=...>`). Merge
  // those definitions into one action so the panel shows the effective values
  // and all defining files, instead of duplicate partial rows.
  const mergedByXmlId = new Map();
  for (const row of rawWindows) {
    const key = typeof row.xmlId === 'string' && row.xmlId.length > 0 ? row.xmlId : `${row.file}\u0000${row.id}`;
    const merged = mergedByXmlId.get(key);
    if (merged === undefined) {
      mergedByXmlId.set(key, {
        ...row,
        definitions: [{ module: row.module, file: row.file, line: row.line }],
      });
      continue;
    }
    merged.definitions.push({ module: row.module, file: row.file, line: row.line });
    if ((typeof merged.id !== 'string' || merged.id.length === 0) && typeof row.id === 'string') merged.id = row.id;
    // The definition that owns res_model is the primary one for display: a
    // patch-only record usually has no model of its own. Decide before merging
    // res_model, otherwise the field copy below hides that this row is primary.
    if ((typeof merged.resModel !== 'string' || merged.resModel.length === 0) && typeof row.resModel === 'string' && row.resModel.length > 0) {
      merged.module = row.module;
      merged.file = row.file;
      merged.line = row.line;
    }
    for (const field of ['name', 'resModel', 'viewMode', 'viewId', 'target', 'usage', 'domain', 'context', 'bindingModel']) {
      const current = merged[field];
      const incoming = row[field];
      if ((typeof current !== 'string' || current.length === 0) && typeof incoming === 'string' && incoming.length > 0) {
        merged[field] = incoming;
      }
    }
  }
  const windows = [...mergedByXmlId.values()];

  const byRef = new Map();
  for (const action of windows) {
    byRef.set(action.xmlId, action);
    if (typeof action.id === 'string' && action.id.length > 0) byRef.set(action.id, action);
    const short = shortIdOf(action.xmlId);
    if (!byRef.has(short)) byRef.set(short, action);
  }

  const linksByAction = new Map();
  for (const link of links) {
    const ref = String(link.actWindowId ?? '').trim();
    if (ref.length === 0) continue;
    const action = byRef.get(ref) ?? byRef.get(shortIdOf(ref));
    if (action === undefined) continue;
    if (!linksByAction.has(action)) linksByAction.set(action, []);
    linksByAction.get(action).push(link);
  }

  for (const action of windows) {
    const views = [];
    const explicit = (linksByAction.get(action) ?? [])
      .slice()
      .sort((left, right) => (Number.parseInt(left.sequence, 10) || 0) - (Number.parseInt(right.sequence, 10) || 0));
    for (const link of explicit) {
      if (typeof link.viewId !== 'string' || link.viewId.length === 0) continue;
      const mode = typeof link.viewMode === 'string' && link.viewMode.length > 0 ? link.viewMode : '';
      views.push({ mode, viewRef: link.viewId, sequence: Number.parseInt(link.sequence, 10) || 0, source: 'link' });
    }
    const modes = String(action.viewMode ?? '')
      .split(',')
      .map((mode) => mode.trim())
      .filter((mode) => mode.length > 0);
    if (typeof action.viewId === 'string' && action.viewId.length > 0 && modes.length > 0 && !views.some((item) => item.mode === modes[0])) {
      views.unshift({ mode: modes[0], viewRef: action.viewId, sequence: -1, source: 'view_id' });
    } else if (typeof action.viewId === 'string' && action.viewId.length > 0 && modes.length === 0) {
      views.unshift({ mode: '', viewRef: action.viewId, sequence: -1, source: 'view_id' });
    }
    for (const mode of modes) {
      if (!views.some((item) => item.mode === mode)) {
        views.push({ mode, viewRef: '', sequence: 0, source: 'default' });
      }
    }
    action.views = views.slice(0, MAX_ACTION_VIEWS);
  }

  windows.sort((left, right) => String(left.module).localeCompare(String(right.module)) || String(left.xmlId).localeCompare(String(right.xmlId)));
  return { actions: windows, links, total: windows.length };
}

/**
 * Public summary of one joined action, with every view reference resolved.
 * @param {object} action - joined action row.
 * @param {object} state - engine state.
 * @param {Map<string, object>} lookup - current-root view lookup.
 * @param {string} currentRootId - encoded current root id.
 * @returns {object} action summary row.
 */
function actionSummary(action, state, lookup, currentRootId) {
  return {
    id: action.id,
    xmlId: action.xmlId,
    kind: action.kind,
    name: action.name,
    resModel: action.resModel,
    viewMode: action.viewMode,
    target: action.target,
    usage: action.usage,
    module: action.module,
    file: action.file,
    line: action.line,
    definitions: Array.isArray(action.definitions) ? action.definitions.slice(0, 12) : [],
    definitionCount: Array.isArray(action.definitions) ? action.definitions.length : 1,
    views: (action.views ?? []).map((entry) => {
      const resolved = entry.viewRef.length > 0 ? resolveActionViewRef(lookup, state, entry.viewRef, currentRootId) : null;
      return {
        mode: entry.mode,
        viewRef: entry.viewRef,
        sequence: entry.sequence,
        source: entry.source,
        found: resolved !== null,
        ...(resolved ?? {}),
      };
    }),
  };
}

/**
 * Score one action against a lowercased search query.
 * @param {string} query - lowercased query.
 * @param {object} action - action summary row.
 * @returns {number} relevance score (0 when nothing matches).
 */
function scoreAction(query, action) {
  const xmlId = String(action.xmlId ?? '').toLowerCase();
  const name = String(action.name ?? '').toLowerCase();
  const model = String(action.resModel ?? '').toLowerCase();
  const file = String(action.file ?? '').toLowerCase();
  let score = 0;
  if (xmlId === query) score += 1_000;
  else if (xmlId.endsWith(`.${query}`)) score += 850;
  else if (xmlId.includes(query)) score += 700;
  if (model === query) score += 800;
  else if (model.includes(query)) score += 500;
  if (name === query) score += 600;
  else if (name.includes(query)) score += 350;
  if (file.includes(query)) score += 120;
  return score;
}

/**
 * Search the joined action list of one root.
 * @param {Array<object>} rows - summarized action rows (views already resolved).
 * @param {string} rawQuery - query text.
 * @param {string} modelFilter - res_model equality filter ('' = all).
 * @param {string} kindFilter - `window` or `windowView` ('' = all kinds).
 * @returns {{ items: Array<object>, total: number, truncated: boolean }} results.
 */
function searchActions(rows, rawQuery, modelFilter, kindFilter) {
  const query = rawQuery.trim().toLowerCase();
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  const items = [];
  let total = 0;
  for (const row of rows) {
    if (kindFilter.length > 0 && row.kind !== kindFilter) continue;
    if (modelFilter.length > 0 && row.resModel !== modelFilter) continue;
    const haystacks = [
      String(row.xmlId ?? '').toLowerCase(),
      String(row.name ?? '').toLowerCase(),
      String(row.resModel ?? '').toLowerCase(),
      String(row.viewMode ?? '').toLowerCase(),
      String(row.module ?? '').toLowerCase(),
      String(row.file ?? '').toLowerCase(),
      row.views.map((view) => `${view.viewRef} ${view.xmlId ?? ''} ${view.mode}`).join(' ').toLowerCase(),
    ];
    if (!tokens.every((token) => haystacks.some((haystack) => haystack.includes(token)))) continue;
    total += 1;
    items.push({ ...row, score: scoreAction(query, row) });
  }
  items.sort((left, right) => right.score - left.score || String(left.module).localeCompare(String(right.module)) || String(left.xmlId).localeCompare(String(right.xmlId)));
  return { items, total, truncated: total > MAX_ACTIONS_RESULTS };
}

/**
 * Window actions that open one view, for the Inheritance tab.
 * @param {object} index - index snapshot.
 * @param {object} view - target view summary.
 * @returns {{ actions: Array<object>, actionsTotal: number }} referencing actions.
 */
function relatedActions(index, view) {
  const { actions } = collectIndexActions(index);
  const rows = [];
  const seen = new Set();
  for (const action of actions) {
    const matchingModes = [];
    for (const entry of action.views ?? []) {
      if (entry.viewRef.length === 0) continue;
      if (inheritRefMatches(entry.viewRef, view)) matchingModes.push(entry.mode);
    }
    if (matchingModes.length === 0) continue;
    const mode = matchingModes[0] ?? '';
    const key = `${action.xmlId}\u0000${mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: action.id,
      xmlId: action.xmlId,
      name: action.name,
      resModel: action.resModel,
      viewMode: action.viewMode,
      mode,
      target: action.target,
      module: action.module,
      file: action.file,
      line: action.line,
    });
  }
  rows.sort((left, right) => String(left.xmlId).localeCompare(String(right.xmlId)));
  return { actions: rows.slice(0, MAX_RELATED_ACTIONS), actionsTotal: rows.length };
}

/**
 * Human label for one preview node, used in xpath match paths.
 * @param {object} node - preview node.
 * @returns {string} label.
 */
function locatorNodeLabel(node) {
  if (node === null || node === undefined) return '';
  const attrs = node.attrs ?? {};
  const parts = [];
  if (typeof attrs.name === 'string' && attrs.name.length > 0) parts.push(`@name=${attrs.name}`);
  else if (typeof attrs.id === 'string' && attrs.id.length > 0) parts.push(`@id=${attrs.id}`);
  if (typeof attrs.string === 'string' && attrs.string.length > 0) parts.push(`string=${attrs.string}`);
  return parts.length > 0 ? `${node.tag}[${parts.join(' ')}]` : node.tag;
}

/**
 * Describe locator matches with their human-readable arch path.
 * @param {object} tree - preview tree the expression was evaluated on.
 * @param {Array<{ node: object, parent: object | null, index: number }>} matches - evaluator matches.
 * @returns {Array<object>} bounded match descriptors.
 */
function describeLocatorMatches(tree, matches) {
  const paths = new Map();
  const walk = (node, prefix) => {
    if (node === null || node === undefined) return;
    const label = locatorNodeLabel(node);
    const path = prefix.length > 0 ? `${prefix} > ${label}` : label;
    paths.set(node, path);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walk(child, path);
  };
  walk(tree, '');
  return matches.slice(0, MAX_XPATH_MATCHES).map((match) => ({
    tag: match.node.tag,
    name: typeof match.node.attrs?.name === 'string' ? match.node.attrs.name : '',
    label: locatorNodeLabel(match.node),
    path: paths.get(match.node) ?? locatorNodeLabel(match.node),
    depth: (paths.get(match.node) ?? '').split(' > ').length - 1,
    parentTag: match.parent?.tag ?? '',
    siblingIndex: match.index,
  }));
}

/**
 * Compose one located view and all of its ancestors into one preview tree.
 * Unlike composeView this starts from a located view, so a custom view whose
 * parent lives in another addons root still resolves.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {object} start - located view record.
 * @returns {Promise<{ tree: object | null, chain: Array<object>, missingBase: string | null }>} composition.
 */
async function composeLocatedChain(state, roots, start) {
  const locations = [];
  const seen = new Set();
  let current = start;
  let missingBase = null;
  while (current !== undefined && locations.length < MAX_COMPOSE_DEPTH) {
    const key = `${current.rootPath}\u0000${current.view.xmlId}`;
    if (seen.has(key)) {
      missingBase = current.view.inheritId || null;
      break;
    }
    seen.add(key);
    locations.unshift(current);
    if (typeof current.view.inheritId !== 'string' || current.view.inheritId.length === 0) break;
    const parent = await locateView(null, state, roots, current.view.inheritId);
    if (parent === undefined) {
      missingBase = current.view.inheritId;
      break;
    }
    current = parent;
  }
  const fileCache = new Map();
  const chain = [];
  for (const location of locations) {
    const parsed = await loadLocatedView(location, fileCache, state);
    if (parsed !== null) chain.push({ xmlId: parsed.xmlId, preview: parsed.preview });
  }
  const composition = composePreviewTrees(chain);
  return {
    tree: composition.tree,
    chain: locations,
    missingBase,
    skippedTotal: composition.skipped.length,
    complete: missingBase === null && composition.skipped.length === 0,
  };
}

/**
 * Resolve the preview tree a locator is validated against: the composed
 * inheritance chain for `base`, or the view's own arch body for `own`.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {object} location - located view record.
 * @param {'base'|'own'} mode - which arch to resolve.
 * @returns {Promise<{ tree: object | null, scope: string, baseXmlId: string, missingBase: string | null, complete: boolean }>} resolved tree.
 */
async function resolveXPathTree(state, roots, location, mode) {
  const own = mode === 'own';
  const isExtension = typeof location.view.inheritId === 'string' && location.view.inheritId.length > 0;
  if (own) {
    const fileCache = new Map();
    const parsed = await loadLocatedView(location, fileCache, state);
    return { tree: parsed === null ? null : parsed.preview, scope: 'own', baseXmlId: location.view.xmlId, missingBase: null, complete: true };
  }
  if (isExtension) {
    const parent = await locateView(null, state, roots, location.view.inheritId);
    if (parent === undefined) {
      return { tree: null, scope: 'base', baseXmlId: location.view.inheritId, missingBase: location.view.inheritId, complete: false };
    }
    const composition = await composeLocatedChain(state, roots, parent);
    return {
      tree: composition.tree,
      scope: 'base',
      baseXmlId: parent.view.xmlId,
      missingBase: composition.missingBase,
      complete: composition.complete,
    };
  }
  const composition = await composeLocatedChain(state, roots, location);
  return {
    tree: composition.tree,
    scope: 'base',
    baseXmlId: location.view.xmlId,
    missingBase: composition.missingBase,
    complete: composition.complete,
  };
}

/**
 * Evaluate one xpath locator against the effective arch of one view.
 *
 * `mode: 'base'` uses the composed inheritance chain the view sits on (its
 * parent for an extension, its own chain for a base view), which is what a patch
 * locator is resolved against by Odoo. `mode: 'own'` uses only the view's own
 * arch body.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {object} location - located view record.
 * @param {string} expr - xpath locator.
 * @param {'base'|'own'} mode - evaluation scope.
 * @returns {Promise<object>} evaluation payload.
 */
async function evaluateXPathScope(state, roots, location, expr, mode) {
  const { tree, scope, baseXmlId, missingBase, complete } = await resolveXPathTree(state, roots, location, mode);
  // An unqualified `%(action_id)d` in this view's arch means this view's module,
  // so qualify it before comparing it with the (canonically qualified) previews.
  const normalized = qualifyXmlIdRefs(expr, location.module);
  const supported = supportsLocator(normalized);
  const matches = supported && tree !== null ? evaluateLocator(tree, normalized) : [];
  return {
    scope,
    baseXmlId,
    missingBase,
    complete,
    supported,
    treeRootTag: tree === null ? '' : tree.tag === '#arch' ? (tree.children ?? []).map((child) => child.tag).join(',') : tree.tag,
    matchCount: matches.length,
    matches: tree === null ? [] : describeLocatorMatches(tree, matches),
  };
}

/**
 * Validate one locator (and an optional XML payload) for the XPath editor.
 * @param {object} host - workspace source (unused; kept for symmetry).
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {object} root - root that owns the view.
 * @param {{ xmlId?: string, expr?: string, mode?: string, payload?: string }} params - request values.
 * @returns {Promise<object>} response payload.
 */
export async function computeXPathPayload(host, state, roots, root, params) {
  const xmlId = String(params.xmlId ?? '').trim().slice(0, 300);
  const expr = String(params.expr ?? '').trim();
  if (xmlId.length === 0) throw new RequestError(400, 'missing-xml-id', 'A view xml id is required.');
  if (expr.length === 0) throw new RequestError(400, 'missing-expr', 'An xpath expression is required.');
  if (expr.length > MAX_XPATH_EXPR) throw new RequestError(400, 'expr-too-long', 'The xpath expression is too long.');
  const payload = typeof params.payload === 'string' ? params.payload : '';
  if (payload.length > MAX_XPATH_PAYLOAD) throw new RequestError(413, 'payload-too-large', 'The locator payload is too large.');
  const index = await ensureIndex(state, root, false);
  const target = findView(index, xmlId);
  if (target === null) throw new RequestError(404, 'unknown-view', 'That view id is not defined in this addons root.');
  const location = { rootPath: root.path, module: target.module, file: target.file, view: target.view };
  const result = await evaluateXPathScope(state, roots, location, expr, params.mode === 'own' ? 'own' : 'base');
  let payloadInfo = null;
  if (payload.trim().length > 0) {
    const parsed = parseArch(payload, { moduleName: target.module });
    payloadInfo = {
      valid: parsed.root !== null,
      rootTag: parsed.root === null
        ? ''
        : parsed.root.virtual === true
          ? (parsed.root.children ?? []).map((child) => child.tag).join(',')
          : parsed.root.tag,
      fieldCount: parsed.fields.length,
      xpathCount: parsed.xpaths.length,
      error: parsed.error ?? null,
    };
  }
  return {
    target: { ...viewSummary(target.view), file: target.file, module: target.module, rootId: root.id },
    expr,
    mode: params.mode === 'own' ? 'own' : 'base',
    ...result,
    payload: payloadInfo,
  };
}

/**
 * Approximate the JSON weight of one preview tree so the detail response budget
 * accounts for the wireframes, not only the XML strings.
 * @param {object | null} node - preview node.
 * @param {{ count: number }} [budget] - shared node counter.
 * @returns {number} estimated bytes.
 */
function previewByteWeight(node, budget = { count: 0 }) {
  if (node === null || node === undefined || budget.count >= 4_000) return 0;
  budget.count += 1;
  let weight = 96;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) weight += previewByteWeight(child, budget);
  return weight;
}

/**
 * Read one index file entry from the cached file payload, parsing when stale.
 * @param {object} state - engine state.
 * @param {object} root - resolved root.
 * @param {{ rel: string, abs: string }} file - resolved file.
 * @param {object} fallback - index entry used for module/group labels.
 * @returns {Promise<object>} file payload.
 */
export async function readFileDetail(state, root, file, fallback) {
  let info;
  try {
    info = await stat(file.abs);
  } catch {
    const error = new Error('This file is no longer available.');
    error.code = 'missing-file';
    throw error;
  }
  if (!info.isFile()) {
    const error = new Error('This path is not a file.');
    error.code = 'missing-file';
    throw error;
  }
  const cacheKey = `${root.path}\u0000${file.rel}`;
  const cached = state.fileCache.get(cacheKey);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    state.fileCache.delete(cacheKey);
    state.fileCache.set(cacheKey, cached);
    return cached.payload;
  }
  if (info.size > state.options.maxFileBytes) {
    const error = new Error('This XML file is larger than the configured read limit.');
    error.code = 'file-too-large';
    throw error;
  }
  const text = await readFile(file.abs, 'utf8');
  const parsed = parseViewFile(text, { moduleName: fallback?.module ?? '', filePath: file.rel });
  const parsedViews = parsed.views.filter((view) => typeof view.id === 'string' && view.id.length > 0);
  // Type resolution is answered by the accumulated primary-view lookup, so an
  // extension view shows the type of the view it extends even when that base
  // view lives in another addons root (custom addons inheriting core views).
  if (state.globalTypes !== undefined) {
    for (const view of parsedViews) resolveViewType(state.globalTypes, view);
  }
  const details = [];
  let budget = 0;
  for (const view of parsedViews.slice(0, MAX_DETAIL_VIEWS)) {
    const cost = (view.arch?.length ?? 0) + (view.source?.length ?? 0) + (view.sourceRaw?.length ?? 0) + previewByteWeight(view.preview) + 2048;
    if (budget + cost > DETAIL_BUDGET_BYTES) {
      details.push({ ...viewSummary(view), detailOmitted: true });
      continue;
    }
    budget += cost;
    details.push(view);
  }
  const payload = {
    file: file.rel,
    module: fallback?.module ?? '',
    group: fallback?.group ?? '',
    mtimeMs: info.mtimeMs,
    size: info.size,
    viewCount: parsedViews.length,
    otherRecordCount: parsed.otherRecordCount ?? 0,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 20) : [],
    reports: Array.isArray(parsed.reports) ? parsed.reports.slice(0, 30) : [],
    paperformats: Array.isArray(parsed.paperformats) ? parsed.paperformats.slice(0, 30) : [],
    actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 100) : [],
    truncated: parsedViews.length > MAX_DETAIL_VIEWS,
    views: details,
  };
  state.fileCache.set(cacheKey, { mtimeMs: info.mtimeMs, size: info.size, payload });
  while (state.fileCache.size > FILE_CACHE_LIMIT) {
    const oldest = state.fileCache.keys().next().value;
    if (oldest === undefined) break;
    state.fileCache.delete(oldest);
  }
  return payload;
}

/**
 * One failed request with an HTTP status and a machine code.
 */
/**
 * A failed engine action: machine `code`, HTTP `status`, human `message`, and
 * an optional exact response `body` for the few errors that carry extra fields.
 */
export class EngineError extends Error {
  /**
   * @param {string} code - machine code.
   * @param {number} status - HTTP status.
   * @param {string} message - human message.
   * @param {object} [body] - exact error body, when it differs from `{ error, code, message }`.
   */
  constructor(code, status, message, body) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
    if (body !== undefined) this.body = body;
  }
}

export class RequestError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - machine code.
   * @param {string} message - human message.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Re-indent one regenerated arch body to the indentation of the file slot it
 * replaces. The builder serializes an arch from column 0; the original body is
 * usually indented below `<field name="arch" type="xml">`, so the first line is
 * appended after the slot's prefix and every later line gets the same base
 * indentation. The original leading/trailing whitespace is preserved.
 * @param {string} original - the arch body currently in the file.
 * @param {string} archText - the new body from the builder.
 * @returns {string | undefined} the replacement text, or undefined for an empty slot.
 */
export function formatArchSlot(original, archText) {
  const first = original.search(/\S/);
  if (first === -1) return undefined;
  const tail = /\S\s*$/.exec(original);
  const last = tail === null ? original.length - 1 : tail.index;
  const prefix = original.slice(0, first);
  const suffix = original.slice(last + 1);
  const baseIndent = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const trimmed = String(archText).replace(/^\s*\n/, '').replace(/\s+$/, '');
  const lines = trimmed.split('\n').map((line) => line.replace(/\s+$/, ''));
  const body = lines
    .map((line, index) => (index === 0 || line.length === 0 ? line : baseIndent + line))
    .join('\n');
  return prefix + body + suffix;
}

/**
 * Reflect one saved file in the live index without invalidating the whole root:
 * reparse that file, refresh the summary/stats, retype extension views and
 * rebuild locator maps, then drop caches that may contain the old file.
 * @param {object} state - engine state.
 * @param {object} root - resolved root.
 * @param {{ rel: string, abs: string }} file - saved file.
 * @returns {Promise<void>} resolves after the index reflects the save.
 */
export async function updateIndexAfterSave(state, root, file) {
  state.fileCache.delete(`${root.path}\u0000${file.rel}`);
  state.parseCache.delete(`${root.path}\u0000${file.rel}`);
  state.composeCache.clear();
  state.secCache.clear();
  state.reportCache.clear();
  state.composeInflight.clear();
  state.reportInflight.clear();
  const data = state.indexCache.get(root.path)?.data;
  if (data === undefined) return;
  let info;
  try {
    info = await stat(file.abs);
  } catch {
    state.indexCache.delete(root.path);
    return;
  }
  let text;
  try {
    text = await readFile(file.abs, 'utf8');
  } catch {
    state.indexCache.delete(root.path);
    return;
  }
  const previous = data.entries.get(file.rel);
  let indexed;
  try {
    indexed = indexViewFile(text, { moduleName: previous?.module ?? '', filePath: file.rel });
  } catch {
    state.indexCache.delete(root.path);
    return;
  }
  const views = Array.isArray(indexed.views) ? indexed.views.filter((view) => typeof view.id === 'string' && view.id.length > 0) : [];
  const actions = Array.isArray(indexed.actions)
    ? indexed.actions.filter((action) => typeof action.id === 'string' && action.id.length > 0)
    : [];
  data.entries.set(file.rel, {
    rel: file.rel,
    module: previous?.module ?? '',
    group: previous?.group ?? '',
    mtimeMs: info.mtimeMs,
    size: info.size,
    views,
    actions,
    otherRecordCount: indexed.otherRecordCount ?? 0,
  });
  data.typeLookup = finalizeIndexTypes(state, root.path, data.entries);
  const summary = summarizeEntries(data.entries);
  data.files = summary.files;
  data.stats = statsFromSummary(summary, {
    candidateFiles: data.stats.candidateFiles,
    parsed: data.stats.parsed,
    reused: data.stats.reused,
    skippedTooLarge: data.stats.skippedTooLarge,
    failed: data.stats.failed,
    truncated: data.stats.truncated,
  });
  state.indexCache.set(root.path, { at: Date.now(), data });
  rebuildLocators(state);
}

/**
 * Serialize writes to the same file through a promise chain.
 * @param {object} state - engine state.
 * @param {string} key - absolute file path.
 * @param {() => Promise<any>} run - the operation to serialize.
 * @returns {Promise<any>} the operation result.
 */
export function withSaveLock(state, key, run) {
  const previous = state.saveLocks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.catch(() => {});
  state.saveLocks.set(key, settled);
  settled.then(() => {
    if (state.saveLocks.get(key) === settled) state.saveLocks.delete(key);
  });
  return next;
}

/**
 * Map one Python `fields.X` class name to the lowercase type the builder's view
 * generator understands, or undefined when the type has no builder form.
 * @param {unknown} fieldType - `Char`, `Many2one`, `Selection`, …
 * @returns {string | undefined} builder type (`char`, `many2one`, …).
 */
function builderFieldType(fieldType) {
  const type = String(fieldType ?? '').toLowerCase();
  return BUILDER_FIELD_TYPES.has(type) ? type : undefined;
}

/**
 * Build the builder's `ctx.models` map from the Python index: every indexed model
 * gets `{ module, mixins, fields: [{name, type, string, module, modules, definitions}] }`.
 *
 * Parity with `cli/build.mjs` (D6):
 * - the field type is lowercased so the view generator classifies wide/searchable
 *   fields correctly;
 * - every field keeps its provenance (`module`, all `modules`, `definitions`) so
 *   `buildPlan` can test depends-reachability instead of guessing;
 * - the model owner is the *rank-sorted* first definer (`resolveModel(...).modules[0]`),
 *   not the index insertion order, so an ACL row never references an inheritor's
 *   `model_*` xml id.
 * @param {object} data - python index from `ensurePythonIndex`.
 * @param {{ needed?: Set<string> }} [options] - models whose owner must be exact.
 * @returns {Map<string, { module: string, mixins: string[], fields: Array<object> }>} model map.
 */
export function builderModelsFromPython(data, options = {}) {
  const needed = options.needed instanceof Set ? options.needed : new Set();
  const map = new Map();
  for (const model of data?.models ?? []) {
    const fieldMap = data.modelFields?.get(model.name);
    const fields = [];
    if (fieldMap !== undefined) {
      for (const field of fieldMap.values()) {
        const type = builderFieldType(field.fieldType);
        if (type === undefined) continue;
        fields.push({
          name: field.name,
          type,
          string: field.string ?? '',
          module: field.module ?? '',
          modules: Array.isArray(field.modules) && field.modules.length > 0 ? [...field.modules] : (field.module ? [field.module] : []),
          definitions: field.definitions ?? 1,
        });
      }
    }
    // `data.models[].modules` is a Set in index order; only the models the spec
    // actually references are worth the rank-sorted lookup.
    let owner = model.modules?.[0] ?? '';
    if (needed.has(model.name)) {
      const resolved = resolveModel(data, model.name);
      if (Array.isArray(resolved?.modules) && resolved.modules.length > 0) owner = resolved.modules[0];
    }
    map.set(model.name, { module: owner, mixins: Array.isArray(model.mixins) ? [...model.mixins] : [], fields });
  }
  return map;
}

/**
 * Every model name a builder spec references: the models it defines, their
 * comodels, and the models of explicit views and access rows.
 * @param {object} spec - builder spec.
 * @returns {Set<string>} model names.
 */
export function builderSpecModels(spec) {
  const names = new Set();
  for (const model of spec.models ?? []) {
    if (typeof model?.name === 'string') names.add(model.name);
    for (const field of model?.fields ?? []) {
      const comodel = typeof field === 'string' ? field.split(':')[2] : field?.comodel;
      if (typeof comodel === 'string' && comodel.includes('.')) names.add(comodel);
    }
  }
  for (const entry of [...(spec.views ?? []), ...(spec.access ?? [])]) {
    if (typeof entry?.model === 'string') names.add(entry.model);
  }
  return names;
}

/**
 * Drop every cache a builder apply can invalidate for one root. The index and
 * walk caches for the root are removed, locators and the accumulated type lookup
 * are rebuilt from the surviving indexes, and the compose/report/python/security
 * caches are cleared so the next request re-reads the generated files.
 * @param {object} state - engine state.
 * @param {object} root - resolved root.
 * @returns {void}
 */
export function clearRootCachesAfterBuild(state, root) {
  state.indexCache.delete(root.path);
  // Walk-cache keys are `${rootPath}\0${excludes}`: drop every variant for this
  // root, otherwise the new module is invisible until the 30 s TTL expires.
  const prefix = `${root.path}\u0000`;
  for (const key of [...state.walkCache.keys()]) {
    if (key.startsWith(prefix)) state.walkCache.delete(key);
  }
  state.fileCache.clear();
  state.parseCache.clear();
  state.composeCache.clear();
  state.reportCache.clear();
  state.composeInflight.clear();
  state.reportInflight.clear();
  state.pyCache.clear();
  state.secCache.clear();
  state.globalTypes = { byXmlId: new Map(), byShortId: new Map() };
  for (const cached of state.indexCache.values()) {
    if (cached?.data?.typeLookup !== undefined) mergeTypeLookup(state.globalTypes, cached.data.typeLookup);
  }
  rebuildLocators(state);
}

/** Map an `ApplyError` code to its HTTP status. */
export function applyErrorStatus(code) {
  if (code === 'core-root' || code === 'outside-roots') return 403;
  if (code === 'file-exists' || code === 'stale-file') return 409;
  if (code === 'bad-path' || code === 'plan-not-ok' || code === 'bad-plan') return 400;
  return 500;
}

/**
 * Resolve one relative directory below an addons root, refusing absolute paths,
 * `.`/`..` segments and anything that would leave the root.
 * @param {object} root - resolved root.
 * @param {string} rel - relative directory (`custom-ddp`, `OCA/repo`).
 * @returns {string | undefined} absolute directory, or undefined when unsafe.
 */
export function resolveRelativeDir(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_RELATIVE_PATH) return undefined;
  const normalized = rel.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.includes('\0')) return undefined;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return undefined;
  const abs = resolve(root.path, ...segments);
  const prefix = root.path.endsWith(sep) ? root.path : root.path + sep;
  return abs.startsWith(prefix) ? abs : undefined;
}

/**
 * Odoo major version of the workspace, from `odoo/odoo/release.py` or
 * `odoo/release.py` under the root's workspace base (or the root itself).
 * @param {object} root - resolved root.
 * @returns {Promise<number | undefined>} major version, or undefined when no release.py is found.
 */
export async function detectWorkspaceVersion(root) {
  const bases = [root.workspace, root.path].filter((value) => typeof value === 'string' && value.length > 0);
  for (const base of bases) {
    for (const rel of ['odoo/odoo/release.py', 'odoo/release.py']) {
      try {
        const version = detectOdooVersion(await readFile(join(base, rel), 'utf8'));
        if (version !== undefined) return version;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
  }
  return undefined;
}

/**
 * The unqualified part of a view xml id.
 * @param {string} xmlId - module-qualified id.
 * @returns {string} short id.
 */
function shortIdOf(xmlId) {
  return xmlId.includes('.') ? xmlId.slice(xmlId.lastIndexOf('.') + 1) : xmlId;
}

/**
 * Resolve one view across every addons root, indexing more roots on demand so a
 * custom view can still trace a base view that lives in the core root.
 * @param {{ workspaces: () => Array<object>, defaultDirectory: () => (string | undefined) }} host - workspace source.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {string} xmlId - requested view id.
 * @returns {Promise<object | undefined>} the located view.
 */
async function locateView(host, state, roots, xmlId) {
  // A qualified xml id must match exactly. Falling back to the bare record id
  // would pick another module's view with the same short id (a custom record can
  // reuse `view_account_move_line_filter`), which breaks inheritance resolution
  // and creates a self-cycle.
  const qualified = typeof xmlId === 'string' && xmlId.includes('.');
  const lookup = () => {
    const exact = state.viewLocator.get(xmlId);
    if (exact !== undefined) return exact;
    if (qualified) return undefined;
    return state.viewShortLocator.get(shortIdOf(xmlId));
  };
  const direct = lookup();
  if (direct !== undefined) return direct;
  for (const candidate of roots) {
    if (state.indexCache.get(candidate.path)?.data !== undefined) continue;
    try {
      await ensureIndex(state, candidate, false);
    } catch {
      continue;
    }
    const found = lookup();
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Read and parse the full view (arch + preview tree) for one located view.
 * @param {object} location - located view record.
 * @param {Map<string, object>} fileCache - per-request file parse cache.
 * @returns {Promise<object | null>} the parsed view.
 */
async function loadLocatedView(location, fileCache, state = null) {
  const key = `${location.rootPath}\u0000${location.file}`;
  const abs = join(location.rootPath, ...location.file.split('/'));
  let parsed;
  const requestHit = fileCache !== null && fileCache !== undefined ? fileCache.get(key) : undefined;
  if (requestHit !== undefined) {
    parsed = requestHit;
  }
  if (parsed === undefined && state !== null && state !== undefined) {
    const cached = state.parseCache.get(key);
    if (cached !== undefined) {
      try {
        const info = await stat(abs);
        if (info.mtimeMs === cached.mtimeMs && info.size === cached.size) {
          parsed = cached.parsed;
        } else {
          state.parseCache.delete(key);
        }
      } catch {
        state.parseCache.delete(key);
      }
    }
  }
  if (parsed === undefined) {
    let info = null;
    let text;
    try {
      info = await stat(abs);
      text = await readFile(abs, 'utf8');
    } catch {
      text = undefined;
    }
    parsed = text === undefined ? null : parseViewFile(text, { moduleName: location.module, filePath: location.file });
    if (state !== null && state !== undefined) {
      state.parseCache.set(key, {
        mtimeMs: info === null ? 0 : info.mtimeMs,
        size: info === null ? 0 : info.size,
        parsed,
      });
      while (state.parseCache.size > PARSE_CACHE_LIMIT) {
        const oldest = state.parseCache.keys().next().value;
        if (oldest === undefined) break;
        state.parseCache.delete(oldest);
      }
    }
    if (fileCache !== null && fileCache !== undefined) fileCache.set(key, parsed);
  }
  if (parsed === null) return null;
  return parsed.views.find((view) => view.xmlId === location.view.xmlId || view.id === location.view.id) ?? null;
}

/**
 * Find the closing bracket of one xpath predicate, honoring quoted strings.
 * @param {string} text - locator text.
 * @param {number} start - index of '['.
 * @returns {number} index of ']' or -1.
 */
function locatorBracketEnd(text, start) {
  let quote = '';
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') {
      depth += 1;
      continue;
    }
    if (character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Explicit axis prefixes Odoo views use, mapped to the internal axis name.
 * `descendant::` is strict (children and below, not the context node), while the
 * `//` shorthand and `descendant-or-self::` include the context node.
 */
const EXPLICIT_AXES = {
  ancestor: 'ancestor',
  'ancestor-or-self': 'ancestor-or-self',
  child: 'child',
  descendant: 'descendant-strict',
  'descendant-or-self': 'descendant-or-self',
  following: 'following',
  'following-sibling': 'following-sibling',
  parent: 'parent',
  preceding: 'preceding',
  'preceding-sibling': 'preceding-sibling',
  self: 'self',
};

/**
 * Parse one practical Odoo xpath locator into steps.
 * Supports `//tag`, `/tag`, `//tag[@attr='value']`, `[hasclass('x')]`,
 * `[1]`, `[last()]`, `[contains(@attr,'x')]`, `[contains(text(),'x')]`,
 * `[local-name()='x']`, `..`, `and`/`or`-joined predicates, and the explicit
 * `parent::`, `ancestor::`, `ancestor-or-self::`, `child::`, `self::`,
 * `following::`, `following-sibling::`, `preceding::`, `preceding-sibling::`,
 * `descendant::` and `descendant-or-self::` axes.
 * @param {string} expression - locator expression.
 * @returns {Array<object> | null} steps, or null when unsupported.
 */
export function parseLocator(expression) {
  const text = String(expression).trim();
  if (!text.startsWith('/') && !text.startsWith('.')) return null;
  let body = text;
  let relative = false;
  if (body === '.' || body.startsWith('./')) {
    // Odoo's ETXPath evaluates the arch element as the context node, so `.` is
    // the arch root itself, `./x` is a child of it and `.//x` is the same
    // descendant axis as `//x`.
    relative = true;
    body = body === '.' ? '' : body.slice(1);
    if (body === '') return [{ axis: 'self', tag: '', predicates: [] }];
  } else if (body.startsWith('.')) {
    return null;
  }
  const steps = [];
  let index = 0;
  while (index < body.length) {
    let axis;
    if (body.startsWith('//', index)) {
      axis = 'descendant';
      index += 2;
    } else if (body[index] === '/') {
      axis = 'child';
      index += 1;
    } else {
      return null;
    }
    if (body.startsWith('..', index)) {
      steps.push({ axis: 'parent', tag: '', predicates: [] });
      index += 2;
      continue;
    }
    // An explicit `axis::` prefix overrides the `/`/`//` shorthand.
    const explicit = /^([A-Za-z-]+)::/.exec(body.slice(index));
    if (explicit !== null && Object.prototype.hasOwnProperty.call(EXPLICIT_AXES, explicit[1])) {
      axis = EXPLICIT_AXES[explicit[1]];
      index += explicit[0].length;
    }
    const name = /^[A-Za-z_][\w:.-]*|\*/.exec(body.slice(index));
    if (name === null) return null;
    const tag = name[0] === '*' ? '*' : name[0];
    index += name[0].length;
    const predicates = [];
    while (index < body.length && body[index] === '[') {
      const end = locatorBracketEnd(body, index);
      if (end === -1) return null;
      predicates.push(body.slice(index + 1, end));
      index = end + 1;
    }
    steps.push({ axis, tag, predicates });
    if (index < body.length && body[index] !== '/') return null;
  }
  if (steps.length === 0) return null;
  if (relative) steps[0].relative = true;
  return steps;
}

/**
 * Parse one relative path predicate (`tag[pred][pred]`) inside an XPath
 * bracket, e.g. `div[field[@name='qty_delivered']]`.
 * @param {string} text - predicate text.
 * @returns {{ tag: string, predicates: string[] } | null} child step, or null when unsupported.
 */
function parseChildStep(text) {
  const match = /^([A-Za-z_][\w:.-]*|\*)\s*((?:\[[\s\S]*\])*)$/.exec(text);
  if (match === null) return null;
  const predicates = [];
  let rest = match[2].trim();
  while (rest.length > 0) {
    if (rest[0] !== '[') return null;
    const end = locatorBracketEnd(rest, 0);
    if (end === -1) return null;
    predicates.push(rest.slice(1, end));
    rest = rest.slice(end + 1).trim();
  }
  return { tag: match[1], predicates };
}

/**
 * Collect one node and its descendants with parent links.
 * @param {object} node - root node.
 * @param {object | null} parent - parent node.
 * @param {number} index - index in the parent.
 * @param {Array<object>} out - accumulated entries.
 * @returns {void}
 */
function collectDescendantEntries(node, parent, index, out) {
  out.push({ node, parent, index });
  const children = Array.isArray(node.children) ? node.children : [];
  for (let position = 0; position < children.length; position += 1) {
    collectDescendantEntries(children[position], node, position, out);
  }
}

/**
 * Split one predicate on top-level `and`/`or`, honoring quoted strings and
 * parentheses so `not(@a and @b)` and `@t-if='a or b'` stay atomic.
 * @param {string} text - predicate text.
 * @returns {Array<{ op: 'value' | 'and' | 'or', value?: string }>} tokens.
 */
function splitTopLevelLogical(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  let index = 0;
  const flush = () => {
    const value = current.trim();
    if (value !== '') parts.push({ op: 'value', value });
    current = '';
  };
  while (index < text.length) {
    const character = text[index];
    if (quote !== '') {
      if (character === quote) quote = '';
      current += character;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      index += 1;
      continue;
    }
    if (character === '(') {
      depth += 1;
      current += character;
      index += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      current += character;
      index += 1;
      continue;
    }
    if (depth === 0) {
      const operator = /^(and|or)\b/i.exec(text.slice(index));
      if (operator !== null) {
        flush();
        parts.push({ op: operator[1].toLowerCase() });
        index += operator[0].length;
        continue;
      }
    }
    current += character;
    index += 1;
  }
  flush();
  return parts;
}

/**
 * Apply a positional predicate (`[n]` or `[last()]`) per parent.
 *
 * Odoo's `//tag[1]` means "the first `tag` child of each parent", not "the
 * first `tag` in document order" (that is `(//tag)[1]`), because `//tag` is
 * `descendant-or-self::node()/child::tag`. Grouping candidates by their parent
 * reproduces that; `last()` selects each group's final member.
 * @param {Array<object>} entries - candidate entries in document order.
 * @param {number | null} wanted - 1-based position, or null for `last()`.
 * @param {boolean} last - select each group's last entry.
 * @returns {Array<object>} selected entries in document order.
 */
function applyPositionalPredicate(entries, wanted, last) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.parent)) groups.set(entry.parent, []);
    groups.get(entry.parent).push(entry);
  }
  const order = new Map();
  entries.forEach((entry, index) => {
    if (!order.has(entry.node)) order.set(entry.node, index);
  });
  const selected = [];
  for (const group of groups.values()) {
    if (last) selected.push(group[group.length - 1]);
    else if (wanted >= 1 && wanted <= group.length) selected.push(group[wanted - 1]);
  }
  selected.sort((left, right) => order.get(left.node) - order.get(right.node));
  return selected;
}

/**
 * Apply one atomic predicate (no top-level `and`/`or`) to a candidate list.
 * @param {Array<object>} entries - candidate entries.
 * @param {string} predicate - predicate text.
 * @returns {Array<object>} filtered entries.
 */
function applyAtomicPredicate(entries, predicate) {
  const text = predicate.trim();
  if (text.length === 0) return entries;
  const negated = /^not\(\s*([\s\S]*?)\s*\)$/i.exec(text);
  if (negated !== null) {
    // `not(predicate)` complements the candidate set, like XPath.
    const excluded = new Set(applyLocatorPredicate(entries, negated[1]).map((entry) => entry.node));
    return entries.filter((entry) => !excluded.has(entry.node));
  }
  const hasAttribute = /^@([\w:.-]+)$/.exec(text);
  if (hasAttribute !== null) return entries.filter((entry) => entry.node.attrs?.[hasAttribute[1]] !== undefined);
  const hasClass = /^hasclass\(\s*(.*?)\s*\)$/i.exec(text);
  if (hasClass !== null) {
    // Odoo's `hasclass(*classes)` requires every class to be present.
    const classes = [...hasClass[1].matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
    if (classes.length === 0) return [];
    return entries.filter((entry) => {
      const nodeClasses = String(entry.node.attrs?.class ?? '').split(/\s+/);
      return classes.every((name) => nodeClasses.includes(name));
    });
  }
  const containsText = /^contains\(\s*text\(\)\s*,\s*(['"])(.*?)\1\s*\)$/i.exec(text);
  if (containsText !== null) {
    return entries.filter((entry) => String(entry.node.text ?? '').includes(containsText[2]));
  }
  const contains = /^contains\(\s*@([\w:.-]+)\s*,\s*(['"])(.*?)\2\s*\)$/.exec(text);
  if (contains !== null) {
    return entries.filter((entry) => String(entry.node.attrs?.[contains[1]] ?? '').includes(contains[3]));
  }
  const localName = /^(?:local-name|name)\(\)\s*=\s*(['"])(.*?)\1$/.exec(text);
  if (localName !== null) {
    return entries.filter((entry) => entry.node.tag === localName[2]);
  }
  const attribute = /^@([\w:.-]+)\s*=\s*(['"])(.*?)\2$/.exec(text);
  if (attribute !== null) {
    return entries.filter((entry) => String(entry.node.attrs?.[attribute[1]] ?? '') === attribute[3]);
  }
  if (text === 'last()') return applyPositionalPredicate(entries, null, true);
  const position = /^(\d+)$/.exec(text);
  if (position !== null) return applyPositionalPredicate(entries, Number.parseInt(position[1], 10), false);
  const childStep = parseChildStep(text);
  if (childStep !== null) {
    // `tag[...]` inside a predicate is a relative child path: keep the nodes
    // that have at least one matching child.
    return entries.filter((entry) => {
      const children = Array.isArray(entry.node.children) ? entry.node.children : [];
      let candidates = children
        .map((child, position) => ({ node: child, parent: entry.node, index: position }))
        .filter((candidate) => childStep.tag === '*' || candidate.node.tag === childStep.tag);
      for (const childPredicate of childStep.predicates) candidates = applyLocatorPredicate(candidates, childPredicate);
      return candidates.length > 0;
    });
  }
  return [];
}

/**
 * Apply every predicate of one `and`-joined clause in order.
 * @param {Array<object>} entries - candidate entries.
 * @param {string[]} predicates - atomic predicate texts.
 * @returns {Array<object>} filtered entries.
 */
function applyAtomicPredicateAll(entries, predicates) {
  let result = entries;
  for (const predicate of predicates) result = applyAtomicPredicate(result, predicate);
  return result;
}

/**
 * Apply one predicate to a candidate entry list.
 *
 * `or` binds looser than `and`: `[A and B or C]` is `[(A and B) or C]`.
 * @param {Array<object>} entries - candidate entries.
 * @param {string} predicate - predicate text.
 * @returns {Array<object>} filtered entries.
 */
function applyLocatorPredicate(entries, predicate) {
  const parts = splitTopLevelLogical(String(predicate));
  if (parts.length === 0) return entries;
  if (parts.length === 1 && parts[0].op === 'value') {
    return applyAtomicPredicate(entries, parts[0].value);
  }
  // Group into `or`-joined clauses; `and` is implicit within one clause.
  const clauses = [];
  let currentClause = [];
  for (const part of parts) {
    if (part.op === 'or') {
      if (currentClause.length > 0) {
        clauses.push(currentClause);
        currentClause = [];
      }
    } else if (part.op === 'and') {
      // no-op: `and` joins the values already in the current clause
    } else {
      currentClause.push(part.value);
    }
  }
  if (currentClause.length > 0) clauses.push(currentClause);
  if (clauses.length > 1) {
    const seen = new Set();
    const union = [];
    for (const clause of clauses) {
      for (const entry of applyAtomicPredicateAll(entries, clause)) {
        if (seen.has(entry.node)) continue;
        seen.add(entry.node);
        union.push(entry);
      }
    }
    return union;
  }
  return applyAtomicPredicateAll(entries, clauses[0] ?? []);
}

/**
 * Whether one locator is inside the supported practical subset.
 * @param {string} expression - locator expression.
 * @returns {boolean} true when the source path can be parsed.
 */
export function supportsLocator(expression) {
  const text = String(expression).trim();
  if (parseLocator(text) !== null) return true;
  const grouped = /^\(\s*([\s\S]+?)\s*\)\s*\[\s*(\d+|last\(\))\s*\]$/.exec(text);
  return grouped !== null && supportsLocator(grouped[1]);
}

/**
 * Expand one location step's axis from a single context entry, appending unique
 * candidate entries to `push`. `allEntries` and `orderIndex` describe the whole
 * tree in document order so sibling/following/preceding axes can walk it.
 * @param {object} step - parsed locator step.
 * @param {object} entry - context entry.
 * @param {Array<object>} allEntries - document-order entries.
 * @param {Map<object, number>} orderIndex - node → document-order index.
 * @param {boolean} firstStep - whether this is the first step of the path.
 * @param {(entry: object) => void} push - deduplicating collector.
 * @returns {void}
 */
function expandLocatorAxis(step, entry, allEntries, orderIndex, firstStep, push) {
  const axis = step.axis;
  if (axis === 'self') {
    push(entry);
    return;
  }
  if (axis === 'child') {
    // An absolute path's first step names the document element, which is the
    // arch root itself in Odoo's context (there is no document node above it).
    if (firstStep && step.relative !== true) {
      push(entry);
      return;
    }
    const children = Array.isArray(entry.node.children) ? entry.node.children : [];
    for (let position = 0; position < children.length; position += 1) {
      push({ node: children[position], parent: entry.node, index: position });
    }
    return;
  }
  if (axis === 'descendant' || axis === 'descendant-or-self') {
    const subtree = [];
    collectDescendantEntries(entry.node, entry.parent, entry.index, subtree);
    for (const descendant of subtree) push(descendant);
    return;
  }
  if (axis === 'descendant-strict') {
    const subtree = [];
    collectDescendantEntries(entry.node, entry.parent, entry.index, subtree);
    for (let index = 1; index < subtree.length; index += 1) push(subtree[index]);
    return;
  }
  if (axis === 'parent') {
    if (entry.parent === null) return;
    const parentIndex = orderIndex.get(entry.parent);
    if (parentIndex !== undefined) push(allEntries[parentIndex]);
    return;
  }
  if (axis === 'ancestor' || axis === 'ancestor-or-self') {
    if (axis === 'ancestor-or-self') push(entry);
    let parentNode = entry.parent;
    while (parentNode !== null) {
      const parentIndex = orderIndex.get(parentNode);
      if (parentIndex === undefined) break;
      const parentEntry = allEntries[parentIndex];
      push(parentEntry);
      parentNode = parentEntry.parent;
    }
    return;
  }
  if (axis === 'following-sibling' || axis === 'preceding-sibling') {
    const siblings = entry.parent !== null ? (Array.isArray(entry.parent.children) ? entry.parent.children : []) : [];
    if (axis === 'following-sibling') {
      for (let position = entry.index + 1; position < siblings.length; position += 1) {
        push({ node: siblings[position], parent: entry.parent, index: position });
      }
    } else {
      for (let position = entry.index - 1; position >= 0; position -= 1) {
        push({ node: siblings[position], parent: entry.parent, index: position });
      }
    }
    return;
  }
  if (axis === 'following' || axis === 'preceding') {
    const documentIndex = orderIndex.get(entry.node);
    if (documentIndex === undefined) return;
    if (axis === 'following') {
      const descendants = new Set();
      const subtree = [];
      collectDescendantEntries(entry.node, entry.parent, entry.index, subtree);
      for (const descendant of subtree) descendants.add(descendant.node);
      for (let index = documentIndex + 1; index < allEntries.length; index += 1) {
        if (!descendants.has(allEntries[index].node)) push(allEntries[index]);
      }
    } else {
      const ancestors = new Set();
      let parentNode = entry.parent;
      while (parentNode !== null) {
        ancestors.add(parentNode);
        const parentIndex = orderIndex.get(parentNode);
        parentNode = parentIndex !== undefined ? allEntries[parentIndex].parent : null;
      }
      for (let index = documentIndex - 1; index >= 0; index -= 1) {
        if (!ancestors.has(allEntries[index].node)) push(allEntries[index]);
      }
    }
  }
}

/**
 * Evaluate one practical xpath locator against a preview tree.
 * @param {object} root - composed tree root.
 * @param {string} expression - locator expression.
 * @returns {Array<{ node: object, parent: object | null, index: number }>} matches.
 */
export function evaluateLocator(root, expression) {
  const text = String(expression).trim();
  // `(path)[n]` selects by global document position, unlike `tag[n]`, which is
  // per-parent. Odoo views use both.
  const grouped = /^\(\s*([\s\S]+?)\s*\)\s*\[\s*(\d+|last\(\))\s*\]$/.exec(text);
  if (grouped !== null) {
    const matches = evaluateLocator(root, grouped[1]);
    if (grouped[2] === 'last()') return matches.length === 0 ? [] : [matches[matches.length - 1]];
    const wanted = Number.parseInt(grouped[2], 10);
    return wanted >= 1 && wanted <= matches.length ? [matches[wanted - 1]] : [];
  }
  const steps = parseLocator(text);
  if (steps === null) return [];
  const allEntries = [];
  collectDescendantEntries(root, null, -1, allEntries);
  const orderIndex = new Map();
  allEntries.forEach((entry, index) => orderIndex.set(entry.node, index));
  let entries = [{ node: root, parent: null, index: -1 }];
  let firstStep = true;
  for (const step of steps) {
    const candidates = [];
    const seen = new Set();
    const pushUnique = (entry) => {
      if (seen.has(entry.node)) return;
      seen.add(entry.node);
      candidates.push(entry);
    };
    for (const entry of entries) {
      expandLocatorAxis(step, entry, allEntries, orderIndex, firstStep, pushUnique);
    }
    firstStep = false;
    if (step.tag !== '' && step.tag !== '*') {
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (candidates[index].node.tag !== step.tag) candidates.splice(index, 1);
      }
    }
    let filtered = candidates;
    for (const predicate of step.predicates) filtered = applyLocatorPredicate(filtered, predicate);
    entries = filtered;
    if (entries.length === 0) return [];
  }
  return entries;
}

/**
 * Deep-clone the content children of one inheritance operation.
 * @param {object} operation - xpath/field operation node.
 * @returns {Array<object>} cloned child nodes.
 */
function inheritanceContent(operation) {
  const children = Array.isArray(operation.children) ? operation.children : [];
  return children
    .filter((child) => child.tag !== 'attribute')
    .map((child) => JSON.parse(JSON.stringify(child)));
}

/**
 * Apply Odoo's `$0` placeholder of a `replace` spec: every content element whose
 * text is `$0` gets that text cleared and a copy of the replaced node appended,
 * so `<notebook position="replace"><header/><sheet>$0</sheet></notebook>` keeps
 * the original notebook inside the new sheet.
 * @param {Array<object>} content - cloned replacement content.
 * @param {object} original - the node being replaced.
 * @returns {void}
 */
function substituteMovedNode(content, original) {
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (typeof node.text === 'string' && node.text.trim() === '$0') {
      node.text = '';
      if (!Array.isArray(node.children)) node.children = [];
      node.children.push(JSON.parse(JSON.stringify(original)));
      return;
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
  };
  for (const node of content) visit(node);
}

/**
 * Mark one contributed subtree root for highlighting in the UI.
 * @param {Array<object>} nodes - contributed nodes.
 * @returns {void}
 */
function markContributed(nodes) {
  for (const node of nodes) {
    node.highlight = true;
    if (!Array.isArray(node.children)) node.children = [];
  }
}

/**
 * Render one value as an XPath predicate literal for display. Odoo's own error
 * message uses double quotes, so values that hold an apostrophe (an `attrs`
 * dictionary, for example) stay readable.
 * @param {string} value - attribute value.
 * @returns {string} quoted literal.
 */
function locatorLiteral(value) {
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

/**
 * Render one inheritance operation as a locator string for skip reporting.
 *
 * Shorthand specs are named the way Odoo names them: the tag plus every
 * attribute except `position` (and `version`, which Odoo compares separately).
 * @param {object} operation - inheritance operation node.
 * @returns {string} display locator ('' when an xpath has no expr).
 */
function operationLocator(operation) {
  const attrs = operation.attrs ?? {};
  if (operation.tag === 'xpath') return typeof attrs.expr === 'string' ? attrs.expr : '';
  if (operation.tag === 'field' && attrs.name !== undefined) return `//field[@name=${locatorLiteral(String(attrs.name))}]`;
  let locator = `//${operation.tag}`;
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'position' || name === 'version') continue;
    locator += `[@${name}=${locatorLiteral(String(value))}]`;
  }
  return locator;
}

/**
 * Flatten one extension preview into the ordered operations Odoo applies.
 *
 * A `<data>` wrapper is transparent at any depth, exactly like
 * `apply_inheritance_specs`, which expands a data node into its children when
 * it pops it off the spec queue.
 * @param {object} preview - extension preview root.
 * @returns {Array<object>} operations in application order.
 */
function inheritanceOperations(preview) {
  const operations = [];
  const visit = (node) => {
    if (node === null || node === undefined) return;
    if (node.virtual === true || node.tag === 'data') {
      for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
      return;
    }
    operations.push(node);
  };
  visit(preview);
  return operations;
}

/**
 * Locate the parent-arch node one inheritance operation patches.
 *
 * Mirrors Odoo's `locate_node`: an `xpath` spec is evaluated as ETXPath, a
 * `field` spec matches the first field with that name, and any other tag
 * matches the first node of that tag whose attributes equal the spec's, all
 * attributes except `position` (and `version`, which must match the arch root's
 * version when the spec sets it). Nodes are visited in document order, root
 * included.
 * @param {object} tree - arch composed so far.
 * @param {object} operation - inheritance operation node.
 * @returns {{ status: 'ok', match: object } | { status: 'missing-locator' } | { status: 'no-match' }} lookup.
 */
function matchInheritanceOperation(tree, operation) {
  const attrs = operation.attrs ?? {};
  if (operation.tag === 'xpath') {
    const expr = typeof attrs.expr === 'string' ? attrs.expr : '';
    if (expr.trim().length === 0) return { status: 'missing-locator' };
    const matches = evaluateLocator(tree, expr);
    return matches.length === 0 ? { status: 'no-match' } : { status: 'ok', match: matches[0] };
  }
  if (attrs.version !== undefined && String(tree.attrs?.version ?? '') !== String(attrs.version)) return { status: 'no-match' };
  const entries = [];
  collectDescendantEntries(tree, null, -1, entries);
  for (const entry of entries) {
    const node = entry.node;
    if (node.tag !== operation.tag) continue;
    if (operation.tag === 'field') {
      if (String(node.attrs?.name ?? '') !== String(attrs.name ?? '')) continue;
      return { status: 'ok', match: entry };
    }
    let same = true;
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'position' || name === 'version') continue;
      if (String(node.attrs?.[name] ?? '') !== String(value)) {
        same = false;
        break;
      }
    }
    if (same) return { status: 'ok', match: entry };
  }
  return { status: 'no-match' };
}

/**
 * Merge one inheritance chain into one composed preview tree.
 *
 * The chain is ordered base first, clicked view last. Each extension is applied
 * in order: xpath/field locators are resolved on the tree built so far, then the
 * operation inserts, replaces, or edits attributes. Only content contributed by
 * the last (clicked) view is marked `highlight: true`.
 * @param {Array<{ xmlId: string, preview: object }>} chain - base-first chain.
 * @returns {{ tree: object | null, applied: number, skipped: Array<object>, truncated: boolean }} composition.
 */
export function composePreviewTrees(chain, options = {}) {
  const result = { tree: null, applied: 0, skipped: [], truncated: false };
  if (chain.length === 0) return result;
  const base = chain[0].preview;
  if (base === null || base === undefined) return result;
  let tree = JSON.parse(JSON.stringify(base));
  let nodeCount = 0;
  const count = (node) => {
    nodeCount += 1;
    if (nodeCount > MAX_COMPOSED_NODES) result.truncated = true;
    for (const child of node.children ?? []) count(child);
  };
  count(tree);

  for (let level = 1; level < chain.length && !result.truncated; level += 1) {
    const preview = chain[level].preview;
    if (preview === null || preview === undefined) continue;
    const operations = inheritanceOperations(preview);
    const isClickedView = options.highlightAll === true || level === chain.length - 1;
    for (const operation of operations) {
      const position = String(operation.attrs?.position ?? 'inside').toLowerCase();
      const expression = operationLocator(operation);
      const lookup = matchInheritanceOperation(tree, operation);
      if (lookup.status !== 'ok') {
        const skipped = { xmlId: chain[level].xmlId, expr: expression, reason: lookup.status };
        if (lookup.status === 'no-match') skipped.note = 'target node is absent from the composed arch';
        result.skipped.push(skipped);
        continue;
      }
      const match = lookup.match;
      if (position === 'attributes') {
        for (const attribute of operation.children ?? []) {
          if (attribute.tag !== 'attribute') continue;
          const name = attribute.attrs?.name;
          if (name === undefined) continue;
          const value = typeof attribute.text === 'string' && attribute.text.length > 0
            ? attribute.text
            : attribute.attrs?.value ?? '';
          if (!match.node.attrs) match.node.attrs = {};
          match.node.attrs[name] = value;
          if (isClickedView) match.node.highlight = true;
        }
        result.applied += 1;
        continue;
      }
      if (position === 'move') {
        result.skipped.push({ xmlId: chain[level].xmlId, expr: expression, reason: 'unsupported-position' });
        continue;
      }
      const content = inheritanceContent(operation);
      if (position === 'replace') {
        // An empty replace removes the node; `$0` puts the replaced node back
        // inside the replacement content.
        substituteMovedNode(content, match.node);
        if (isClickedView) markContributed(content);
        if (match.parent === null) {
          if (content.length === 0) {
            result.skipped.push({ xmlId: chain[level].xmlId, expr: expression, reason: 'root-replace' });
            continue;
          }
          if (content.length === 1) tree = content[0];
          else tree = { tag: '#arch', attrs: {}, children: content, text: '', virtual: true };
        } else {
          match.parent.children.splice(match.index, 1, ...content);
        }
        for (const node of content) count(node);
        result.applied += 1;
        continue;
      }
      if (content.length === 0) {
        result.applied += 1;
        continue;
      }
      if (isClickedView) markContributed(content);
      if (position === 'before' || position === 'after') {
        if (match.parent === null) {
          result.skipped.push({ xmlId: chain[level].xmlId, expr: expression, reason: 'root-sibling' });
          continue;
        }
        match.parent.children.splice(match.index + (position === 'after' ? 1 : 0), 0, ...content);
      } else {
        if (!Array.isArray(match.node.children)) match.node.children = [];
        match.node.children.push(...content);
      }
      for (const node of content) count(node);
      result.applied += 1;
    }
  }
  result.tree = tree;
  return result;
}

/**
 * The numeric inheritance priority of one view (Odoo's default is 16).
 * @param {object} view - view summary.
 * @returns {number} priority.
 */
function viewPriority(view) {
  const parsed = Number.parseInt(String(view.priority ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 16;
}

/**
 * Read one module's declared dependencies, cached per module name.
 *
 * The module directory comes from the view index (`moduleDirCache`), so no
 * extra directory walk is needed. A missing or unreadable manifest contributes
 * no dependencies instead of failing the composition.
 * @param {object} state - engine state.
 * @param {string} module - module name.
 * @returns {string[]} declared module names.
 */
function moduleDeps(state, module) {
  const cached = state.moduleDepsCache.get(module);
  if (cached !== undefined) return cached;
  const dir = state.moduleDirCache?.get(module);
  let deps = [];
  if (typeof dir === 'string') {
    try {
      deps = manifestDepends(readFileSync(join(dir, '__manifest__.py'), 'utf8'));
    } catch {
      deps = [];
    }
  }
  state.moduleDepsCache.set(module, deps);
  return deps;
}

/**
 * Rank the modules of one composition in dependency order.
 *
 * Odoo applies inheritors by `priority, id`, where the id is the database
 * creation order: a module's views exist from the moment that module is loaded,
 * so a view of a module is always created after the views of the modules it
 * depends on. A file index has no ids, so the module dependency graph (longest
 * dependency path) is the closest available proxy. The whole dependency chain is
 * followed, including modules that own no view of the model (`stock_dropshipping
 * → sale_purchase_stock → purchase_stock`), which is what makes the rank
 * transitive.
 * @param {object} state - engine state.
 * @param {Array<object>} locations - located views sharing one model.
 * @returns {Map<string, number>} module name → dependency rank.
 */
function moduleDependencyRanks(state, locations) {
  const ranks = new Map();
  const visiting = new Set();
  let resolved = 0;
  const depth = (name) => {
    const known = ranks.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name) || resolved >= MAX_RANK_MODULES) return 0;
    visiting.add(name);
    resolved += 1;
    let rank = 0;
    for (const dep of moduleDeps(state, name)) rank = Math.max(rank, depth(dep) + 1);
    visiting.delete(name);
    ranks.set(name, rank);
    return rank;
  };
  for (const location of locations) {
    if (typeof location.module === 'string' && location.module.length > 0) depth(location.module);
  }
  return ranks;
}

/**
 * Order two inheriting views the way Odoo collects them: priority, then the
 * database id (creation order). A file index has no ids, so the id order is
 * approximated by module dependency rank, then module, file and declaration
 * line, which reproduces creation order within one module.
 * @param {object} left - located view.
 * @param {object} right - located view.
 * @param {Map<string, number>} ranks - module dependency ranks.
 * @returns {number} sort order.
 */
function compareInheritors(left, right, ranks) {
  const priority = viewPriority(left.view) - viewPriority(right.view);
  if (priority !== 0) return priority;
  const rank = (ranks.get(left.module) ?? 0) - (ranks.get(right.module) ?? 0);
  if (rank !== 0) return rank;
  if (left.module !== right.module) return left.module.localeCompare(right.module);
  if (left.file !== right.file) return left.file.localeCompare(right.file);
  const line = (left.view.line ?? 0) - (right.view.line ?? 0);
  if (line !== 0) return line;
  return left.view.xmlId.localeCompare(right.view.xmlId);
}

/**
 * Collect one base view and every view inheriting it, transitively, in the
 * order Odoo applies them: each inheritor sorted by priority (then id) and its
 * own inheritors right after it, depth first.
 * @param {object} state - engine state.
 * @param {object} base - located base view.
 * @returns {Array<object>} located views in application order.
 */
function collectInheritanceTree(state, base) {
  const bucket = state.modelLocator.get(base.view.model);
  const ordered = [base];
  if (bucket === undefined) return ordered;
  const locations = [...bucket.values()];
  const ranks = moduleDependencyRanks(state, locations);
  const visited = new Set([`${base.rootPath}\u0000${base.view.xmlId}`]);
  const inheritorsOf = (parent) => {
    const candidates = [];
    for (const location of locations) {
      if (location.view.mode !== 'extension') continue;
      if (typeof location.view.inheritId !== 'string' || location.view.inheritId.length === 0) continue;
      if (!inheritRefMatches(location.view.inheritId, parent.view)) continue;
      candidates.push(location);
    }
    candidates.sort((left, right) => compareInheritors(left, right, ranks));
    return candidates;
  };
  const visit = (parent) => {
    for (const child of inheritorsOf(parent)) {
      if (ordered.length >= MAX_COMPOSE_VIEWS) return;
      const key = `${child.rootPath}\u0000${child.view.xmlId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      ordered.push(child);
      visit(child);
    }
  };
  visit(base);
  return ordered;
}

/**
 * Compose the inheritance chain of one view into an aggregated, highlighted
 * preview tree.
 * @param {{ workspaces: () => Array<object>, defaultDirectory: () => (string | undefined) }} host - workspace source.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {object} requestedRoot - the root that owns the selected view.
 * @param {string} xmlId - selected view id.
 * @returns {Promise<object | null>} composition payload, or null when unknown.
 */
async function composeView(host, state, roots, requestedRoot, xmlId, mode = 'chain') {
  const index = await ensureIndex(state, requestedRoot, false);
  const target = findView(index, xmlId);
  if (target === null) return null;
  const targetLocation = { rootPath: requestedRoot.path, module: target.module, file: target.file, view: target.view };
  let locations = [];
  let missingBase = null;
  if (mode === 'all') {
    // A view is rendered with its ancestors (Odoo merges the whole chain, which
    // matters for a primary view that inherits another one) and with every view
    // inheriting it, across roots: index the remaining roots first.
    for (const candidate of roots) {
      if (state.indexCache.get(candidate.path)?.data !== undefined) continue;
      try {
        await ensureIndex(state, candidate, false);
      } catch {
        // An unreadable root simply contributes no views.
      }
    }
    const ancestors = [];
    const seen = new Set([`${targetLocation.rootPath}\u0000${targetLocation.view.xmlId}`]);
    let parentRef = targetLocation.view.inheritId;
    while (typeof parentRef === 'string' && parentRef.length > 0 && ancestors.length < MAX_COMPOSE_DEPTH) {
      const parent = await locateView(host, state, roots, parentRef);
      if (parent === undefined) {
        missingBase = parentRef;
        break;
      }
      const key = `${parent.rootPath}\u0000${parent.view.xmlId}`;
      if (seen.has(key)) {
        missingBase = parentRef;
        break;
      }
      seen.add(key);
      ancestors.unshift(parent);
      parentRef = parent.view.inheritId;
    }
    locations = ancestors.concat(collectInheritanceTree(state, targetLocation));
  } else {
    const seen = new Set();
    let current = targetLocation;
    while (current !== undefined && locations.length < MAX_COMPOSE_DEPTH) {
      const key = `${current.rootPath}\u0000${current.view.xmlId}`;
      if (seen.has(key)) {
        missingBase = current.view.inheritId || null;
        break;
      }
      seen.add(key);
      locations.unshift(current);
      if (typeof current.view.inheritId !== 'string' || current.view.inheritId.length === 0) {
        missingBase = null;
        break;
      }
      const parent = await locateView(host, state, roots, current.view.inheritId);
      if (parent === undefined) {
        missingBase = current.view.inheritId;
        break;
      }
      current = parent;
    }
  }

  const fileCache = new Map();
  const chain = [];
  for (const location of locations) {
    const parsed = await loadLocatedView(location, fileCache, state);
    if (parsed === null) continue;
    chain.push({ xmlId: parsed.xmlId, preview: parsed.preview });
  }
  const composition = composePreviewTrees(chain, { highlightAll: mode === 'all' });
  const viewEntries = locations.map((location) => ({
      xmlId: location.view.xmlId,
      name: location.view.name,
      model: location.view.model,
      type: location.view.type,
      mode: location.view.mode,
      priority: location.view.priority,
      file: location.file,
      module: location.module,
      rootId: encodeRootId(location.rootPath),
    }));
  return {
    target: { ...viewSummary(target.view), file: target.file, module: target.module, rootId: requestedRoot.id },
    mode,
    chain: viewEntries,
    views: viewEntries,
    inheritedCount: Math.max(0, locations.length - 1),
    composed: composition.tree,
    applied: composition.applied,
    skipped: composition.skipped.slice(0, 20),
    skippedTotal: composition.skipped.length,
    truncated: composition.truncated,
    missingBase,
    // `complete` means "this merged arch is faithful": every ancestor was found
    // and every inheritance operation could be applied. A skipped operation
    // leaves a hole in the arch, so it must not be reported as complete.
    complete: missingBase === null && composition.skipped.length === 0,
    highlightMode: mode === 'all' ? 'all' : 'clicked',
    highlightXmlId: mode === 'all' ? null : target.view.xmlId,
  };
}

/**
 * Collect every static `<t t-call="...">` target inside one preview tree.
 * Dynamic expressions (QWeb interpolation) are ignored because they cannot be
 * resolved from a file index.
 * @param {object | null} node - preview node.
 * @param {Set<string>} out - accumulated template names.
 * @returns {Set<string>} template names.
 */
function templateCallsOf(node, out = new Set()) {
  if (node === null || node === undefined) return out;
  const call = node.attrs?.['t-call'];
  if (typeof call === 'string' && call.length > 0 && !call.includes('{{') && !call.includes('${')) {
    out.add(call);
  }
  for (const child of Array.isArray(node.children) ? node.children : []) templateCallsOf(child, out);
  return out;
}

/**
 * Resolve the `t-call` graph of one report template from the addons index, so the
 * client can inline layout/document templates statically (the same graph Studio's
 * report editor loads with `/web_studio/get_report_views`, without rendering QWeb).
 * @param {{ workspaces: () => Array<object>, defaultDirectory: () => (string | undefined) }} host - workspace source.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {object} requestedRoot - root owning the selected template.
 * @param {string} xmlId - selected template xml id.
 * @returns {Promise<object | null>} graph payload, or null when unknown.
 */
async function collectReportGraph(host, state, roots, requestedRoot, xmlId) {
  const index = await ensureIndex(state, requestedRoot, false);
  const target = findView(index, xmlId);
  if (target === null) return null;
  const start = { rootPath: requestedRoot.path, module: target.module, file: target.file, view: target.view };
  const fileCache = new Map();
  const templates = {};
  const missing = [];
  const seen = new Set([start.view.xmlId]);
  const queue = [{ location: start, depth: 0 }];
  const truncated = { templates: false, depth: false };
  let rootXmlId = start.view.xmlId;

  while (queue.length > 0) {
    const { location, depth } = queue.shift();
    const parsed = await loadLocatedView(location, fileCache, state);
    const key = parsed !== null && parsed.xmlId.length > 0 ? parsed.xmlId : location.view.xmlId;
    if (parsed === null) {
      missing.push(key);
      continue;
    }
    if (key === start.view.xmlId) rootXmlId = key;
    templates[key] = {
      preview: parsed.preview,
      file: location.file,
      module: location.module,
      model: parsed.model,
      id: parsed.id,
      kind: parsed.kind,
      depth,
    };
    // An empty template is a real indexed extension stub (e.g. `primary=True`
    // inherit with no body); it is not "missing", it just renders nothing.
    if (parsed.preview === null) continue;
    for (const call of templateCallsOf(parsed.preview)) {
      if (seen.has(call)) continue;
      seen.add(call);
      if (Object.keys(templates).length + queue.length >= MAX_REPORT_TEMPLATES) {
        truncated.templates = true;
        continue;
      }
      if (depth + 1 > MAX_REPORT_DEPTH) {
        truncated.depth = true;
        continue;
      }
      const parent = await locateView(host, state, roots, call);
      if (parent === undefined) {
        missing.push(call);
        continue;
      }
      queue.push({ location: parent, depth: depth + 1 });
    }
  }

  return {
    target: { ...viewSummary(target.view), file: target.file, module: target.module, rootId: requestedRoot.id },
    rootXmlId,
    templates,
    missing: missing.slice(0, 30),
    missingTotal: missing.length,
    templateCount: Object.keys(templates).length,
    truncated,
  };
}

/**
 * Directories that never contain model methods we want to index.
 */
const PY_SKIP_DIRECTORIES = new Set([
  ...SKIP_DIRECTORIES, 'tests', 'migrations', 'upgrade', 'i18n', 'static', 'security',
  'data', 'demo', 'doc', 'docs', 'lib', '__pycache__', 'node_modules', '.git', '.venv',
  'vendors', 'vendor',
]);

/**
 * Read a module manifest and extract its direct dependencies.
 * @param {string} text - manifest source.
 * @returns {string[]} dependency module names.
 */
function manifestDepends(text) {
  const match = /['"]depends['"]\s*:\s*\[([\s\S]*?)\]/.exec(text) ?? /depends\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (match === null) return [];
  return [...match[1].matchAll(/['"]([\w.]+)['"]/g)].map((entry) => entry[1]);
}

/**
 * Walk one addons root for modules and their Python files (models/wizard/report/
 * controllers, plus module-level Python files). Bounded and level-parallel.
 * @param {string} rootPath - absolute addons root.
 * @returns {Promise<{ modules: Map<string, object>, files: Array<object>, truncated: boolean }>} collected data.
 */
async function collectPythonModules(rootPath, excludes = []) {
  const modules = new Map();
  const files = [];
  const excluded = Array.isArray(excludes) ? excludes : [];
  let truncated = false;
  let level = [{ abs: rootPath, rel: '', module: '', moduleRel: '', depth: 0 }];
  while (level.length > 0) {
    const next = [];
    await mapLimit(level, 12, async (item) => {
      if (item.rel !== '' && excluded.some((exclude) => isPathInside(item.abs, exclude))) return;
      let entries;
      try {
        entries = await readdir(item.abs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const hasManifest = entries.some((entry) => entry.name === '__manifest__.py' && entry.isFile());
      let module = item.module;
      let moduleRel = item.moduleRel;
      if (hasManifest) {
        const name = basename(item.abs);
        module = name;
        moduleRel = item.rel;
        if (!modules.has(name) && modules.size < MAX_PY_MODULES) {
          modules.set(name, { name, rel: item.rel, dir: item.abs, depends: [] });
        } else if (modules.size >= MAX_PY_MODULES) {
          truncated = true;
        }
      }
      for (const entry of entries) {
        const childRel = item.rel === '' ? entry.name : `${item.rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (item.depth >= 10) continue;
          if (PY_SKIP_DIRECTORIES.has(entry.name)) continue;
          next.push({ abs: join(item.abs, entry.name), rel: childRel, module, moduleRel, depth: item.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.py') || module === '') continue;
        if (entry.name === '__init__.py' || entry.name === '__manifest__.py') continue;
        const segments = childRel.split('/');
        const relevant = segments.some((segment) => PY_RELEVANT_DIRS.includes(segment));
        if (!relevant && childRel.includes('/')) continue;
        if (files.length >= MAX_PY_FILES) {
          truncated = true;
          continue;
        }
        files.push({ abs: join(item.abs, entry.name), rel: childRel, module });
      }
    });
    level = next;
  }
  await mapLimit([...modules.values()], 16, async (info) => {
    try {
      const text = await readFile(join(info.dir, '__manifest__.py'), 'utf8');
      info.depends = manifestDepends(text);
    } catch {
      info.depends = [];
    }
  });
  return { modules, files, truncated };
}

/**
 * Pick the roots a Python request may see. The default is the selected root's
 * whole workspace (so custom → enterprise → core chains resolve); `scope=root`
 * limits the index to that single addons root.
 * @param {Array<object>} roots - all discovered roots.
 * @param {object} root - selected root.
 * @param {'workspace' | 'root'} scope - requested scope.
 * @returns {Array<object>} roots in scope.
 */
function pythonScopeRoots(roots, root, scope) {
  if (scope === 'root') return [root];
  const workspace = root.workspace ?? '';
  return roots.filter((entry) => (entry.workspace ?? '') === workspace);
}

/**
 * Build the Python-index scope for one request: roots, stable cache key and the
 * labels shown in the client.
 * @param {Array<object>} roots - discovered roots.
 * @param {object} root - selected root.
 * @param {'workspace' | 'root'} mode - scope mode.
 * @returns {{ mode: string, scoped: Array<object>, key: string, workspace: string, labels: string[] }} scope.
 */
export function pythonScopeInfo(state, roots, root, mode) {
  const scoped = pythonScopeRoots(roots, root, mode);
  const key = `${mode}\u0000${root.workspace ?? root.path}\u0000${scoped.map((entry) => `${entry.path}:${[...disabledNamesForRoot(state, entry)].sort().join(',')}`).sort().join('|')}`;
  return {
    mode,
    scoped,
    key,
    workspace: root.workspaceLabel ?? '',
    labels: scoped.map((entry) => entry.label),
  };
}

/**
 * Ensure the lazy Python index across all roots of the workspace. Built on first
 * use (Python mode), cached with a TTL, and refreshed only on explicit request.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - discovered roots.
 * @param {boolean} refresh - rebuild even when the cache is fresh.
 * @returns {Promise<object>} python index data.
 */
export async function ensurePythonIndex(state, roots, cacheKey, refresh) {
  let cache = state.pyCache.get(cacheKey);
  if (cache === undefined) {
    cache = { at: 0, data: null, promise: null };
    state.pyCache.set(cacheKey, cache);
  }
  // Keep the built index for the lifetime of the Host process. Python mode is
  // read-only, so the only invalidation is the explicit Refresh action.
  if (refresh !== true && cache.data !== null) return cache.data;
  if (cache.promise !== null) return cache.promise;
  const promise = (async () => {
    const manifests = new Map();
    const entries = [];
    let truncated = false;
    let failedFiles = 0;
    let skippedLarge = 0;
    for (const root of roots) {
      let collected;
      try {
        collected = await collectPythonModules(root.path, effectiveExcludes(state, root));
      } catch {
        continue;
      }
      if (collected.truncated) truncated = true;
      for (const [name, info] of collected.modules) {
        if (!manifests.has(name)) manifests.set(name, { depends: info.depends ?? [], name, rel: info.rel });
      }
      const slots = new Array(collected.files.length);
      let cursor = 0;
      const workers = Math.max(1, Math.min(state.options.indexConcurrency, collected.files.length || 1));
      const worker = async () => {
        while (true) {
          const position = cursor;
          cursor += 1;
          if (position >= collected.files.length) return;
          const item = collected.files[position];
          let info;
          try {
            info = await stat(item.abs);
          } catch {
            failedFiles += 1;
            continue;
          }
          if (!info.isFile() || info.size > MAX_PY_FILE_BYTES) {
            skippedLarge += 1;
            continue;
          }
          let text;
          try {
            text = await readFile(item.abs, 'utf8');
          } catch {
            failedFiles += 1;
            continue;
          }
          let parsed;
          try {
            parsed = parsePythonFile(text, { moduleName: item.module, filePath: item.rel });
          } catch {
            failedFiles += 1;
            continue;
          }
          slots[position] = { rootPath: root.path, module: item.module, file: item.rel, parsed };
        }
      };
      await Promise.all(Array.from({ length: workers }, worker));
      for (const slot of slots) if (slot !== undefined) entries.push(slot);
    }
    const data = buildPythonIndex(entries, manifests);
    data.stats = { ...data.stats, truncated, failedFiles, skippedLarge, builtAt: new Date().toISOString() };
    cache.at = Date.now();
    cache.data = data;
    cache.promise = null;
    return data;
  })();
  cache.promise = promise;
  promise.catch(() => {
    cache.promise = null;
  });
  return promise;
}

/** Directories the security scan never enters. */
const SEC_SKIP_DIRECTORIES = new Set([...SKIP_DIRECTORIES, 'static', 'i18n', 'tests', 'migrations', 'upgrade', 'doc', 'docs', 'node_modules', '.git', 'vendors', 'vendor']);

const MAX_SEC_FILES = 30_000;

/**
 * Walk one addons root and list the data files the security scan reads:
 * every module `*.xml` and every `security/*.csv`.
 * @param {string} rootPath - absolute addons root.
 * @param {string[]} excludes - absolute paths to skip.
 * @returns {Promise<{ files: Array<{ abs: string, rel: string, module: string, csv: boolean }>, truncated: boolean }>} files.
 */
async function collectSecurityFiles(rootPath, excludes = []) {
  const files = [];
  let truncated = false;
  let level = [{ abs: rootPath, rel: '', module: '', depth: 0 }];
  while (level.length > 0) {
    const next = [];
    await mapLimit(level, 12, async (item) => {
      if (item.rel !== '' && excludes.some((exclude) => isPathInside(item.abs, exclude))) return;
      let entries;
      try {
        entries = await readdir(item.abs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const module = entries.some((entry) => entry.name === '__manifest__.py' && entry.isFile()) ? basename(item.abs) : item.module;
      for (const entry of entries) {
        const childRel = item.rel === '' ? entry.name : `${item.rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (item.depth < 10 && !SEC_SKIP_DIRECTORIES.has(entry.name)) next.push({ abs: join(item.abs, entry.name), rel: childRel, module, depth: item.depth + 1 });
          continue;
        }
        if (!entry.isFile() || module === '') continue;
        const isXml = entry.name.endsWith('.xml');
        const isCsv = entry.name.endsWith('.csv') && item.abs.endsWith(`${sep}security`);
        if (!isXml && !isCsv) continue;
        if (files.length >= MAX_SEC_FILES) {
          truncated = true;
          continue;
        }
        files.push({ abs: join(item.abs, entry.name), rel: childRel, module, csv: isCsv });
      }
    });
    level = next;
  }
  return { files, truncated };
}

/**
 * Build (or reuse) the ACL/group index for a set of roots. Cached for the life of the
 * Host process; an explicit refresh or a save rebuilds it.
 * @param {object} state - engine state.
 * @param {Array<object>} roots - roots in scope.
 * @param {string} cacheKey - scope key.
 * @param {boolean} refresh - rebuild even when cached.
 * @returns {Promise<object>} security index.
 */
async function ensureSecurityIndex(state, roots, cacheKey, refresh) {
  let cache = state.secCache.get(cacheKey);
  if (cache === undefined) {
    cache = { data: null, promise: null };
    state.secCache.set(cacheKey, cache);
  }
  if (refresh !== true && cache.data !== null) return cache.data;
  if (cache.promise !== null) return cache.promise;
  const promise = (async () => {
    const parsed = [];
    const problems = [];
    let truncated = false;
    let skippedLarge = 0;
    for (const root of roots) {
      const collected = await collectSecurityFiles(root.path, effectiveExcludes(state, root));
      if (collected.truncated) truncated = true;
      await mapLimit(collected.files, state.options.indexConcurrency, async (item) => {
        let text;
        try {
          const info = await stat(item.abs);
          if (info.size > state.options.maxFileBytes) {
            skippedLarge += 1;
            return;
          }
          text = await readFile(item.abs, 'utf8');
        } catch (error) {
          problems.push({ file: item.rel, line: 0, code: 'read-failed', message: error instanceof Error ? error.message : String(error) });
          return;
        }
        const source = { module: item.module, file: item.rel };
        if (item.csv) {
          if (item.abs.endsWith('ir.model.access.csv')) {
            const csv = parseAccessCsv(text, source);
            csv.rows.forEach((row) => { row.root = root.id; });
            parsed.push({ csv });
          }
          return;
        }
        if (!text.includes('<record') && !text.includes('<menuitem') && !text.includes('<template')) return;
        const xml = parseSecurityXml(text, source);
        for (const list of [xml.groups, xml.rules, xml.access, xml.owners]) list.forEach((entry) => { entry.root = root.id; });
        parsed.push({ xml });
      });
    }
    // Deterministic merge order regardless of read concurrency.
    parsed.sort((left, right) => {
      const a = (left.csv?.rows[0] ?? left.xml?.owners[0] ?? left.xml?.groups[0] ?? left.xml?.rules[0] ?? {}).file ?? '';
      const b = (right.csv?.rows[0] ?? right.xml?.owners[0] ?? right.xml?.groups[0] ?? right.xml?.rules[0] ?? {}).file ?? '';
      return a.localeCompare(b);
    });
    const data = buildSecurityIndex(parsed);
    data.errors.push(...problems);
    data.stats = { ...data.stats, errors: data.errors.length, truncated, skippedLarge, builtAt: new Date().toISOString() };
    cache.data = data;
    cache.promise = null;
    return data;
  })();
  cache.promise = promise;
  promise.catch(() => {
    cache.promise = null;
  });
  return promise;
}

/**
 * Read a Python file through a small LRU cache, returning its lines.
 * @param {object} state - engine state.
 * @param {string} rootPath - absolute root.
 * @param {string} file - relative file path.
 * @param {Map<string, string>} [pending] - per-request cache.
 * @returns {Promise<string>} file text (empty on failure).
 */
async function readPythonFile(state, rootPath, file, pending) {
  const key = `${rootPath}\u0000${file}`;
  const requestHit = pending !== undefined ? pending.get(key) : undefined;
  if (requestHit !== undefined) return requestHit;
  const cached = state.pyFileCache.get(key);
  if (cached !== undefined) {
    state.pyFileCache.delete(key);
    state.pyFileCache.set(key, cached);
    return cached;
  }
  let text = '';
  try {
    text = await readFile(join(rootPath, ...file.split('/')), 'utf8');
  } catch {
    text = '';
  }
  state.pyFileCache.set(key, text);
  while (state.pyFileCache.size > PY_FILE_CACHE_LIMIT) {
    const oldest = state.pyFileCache.keys().next().value;
    if (oldest === undefined) break;
    state.pyFileCache.delete(oldest);
  }
  return text;
}

/**
 * Build the method-explorer payload: ordered chain, per-step source lines,
 * callers and callees.
 * @param {object} state - engine state.
 * @param {object} data - python index.
 * @param {{ model: string, name: string, file: string, line: number, step: number }} request - selected method.
 * @returns {Promise<object | null>} payload, or null when the method is unknown for the model.
 */
async function methodPayload(state, data, request) {
  const chain = resolveMethodChain(data, request.model, request.name, { file: request.file, line: request.line });
  if (chain.length === 0) return null;
  const steps = chain.slice(0, 40);
  const files = new Map();
  const pending = new Map();
  for (const step of steps) {
    const key = `${step.rootPath}\u0000${step.file}`;
    if (!files.has(key)) {
      const text = await readPythonFile(state, step.rootPath, step.file, pending);
      files.set(key, text.split(/\r?\n/));
    }
  }
  let totalLines = 0;
  const formatted = steps.map((step) => {
    const source = files.get(`${step.rootPath}\u0000${step.file}`) ?? [];
    const start = Math.max(step.line - 1, 0);
    const end = Math.min(step.endLine, source.length);
    const slice = source.slice(start, end);
    const limited = slice.slice(0, 120);
    totalLines += limited.length;
    const superLines = new Set(step.superCalls.map((call) => call.line));
    const definition = {
      step: step.step,
      total: step.total,
      module: step.module,
      moduleRank: step.moduleRank,
      className: step.className,
      model: step.model,
      file: step.file,
      line: step.line,
      endLine: step.endLine,
      decorators: step.decorators,
      args: step.args,
      superCalls: step.superCalls,
      hasSuper: step.hasSuper,
      brokenChain: step.brokenChain,
      isBase: step.isBase,
      isLast: step.isLast,
      next: step.next,
      sourceLines: limited.map((text, index) => ({
        line: step.line + index,
        text,
        isDef: step.line + index === step.line,
        isSuper: superLines.has(step.line + index),
      })),
      sourceTruncated: slice.length > limited.length,
    };
    return definition;
  });
  const selectedIndex = Math.min(Math.max(request.step ?? 0, 0), formatted.length - 1);
  const selected = chain[selectedIndex] ?? chain[0];
  const callees = findCallees(data, selected.calls ?? [], 60);
  const callers = findCallers(data, request.name, 80);
  const related = findRelatedDefinitions(data, request.model, request.name);
  const modelInfo = data.models.find((entry) => entry.name === request.model) ?? null;
  const modelFieldMap = data.modelFields.get(request.model) ?? new Map();
  const fieldAttribute = (name) => {
    const field = modelFieldMap.get(name);
    if (field === undefined) return null;
    return {
      fieldType: field.fieldType,
      comodel: field.comodel,
      string: field.string,
      attrs: field.attrs,
      module: field.module,
      definitions: field.definitions,
    };
  };
  const flowFile = files.get(`${selected.rootPath}\u0000${selected.file}`) ?? [];
  const flowSource = flowFile.slice(selected.line - 1, Math.min(selected.endLine, selected.line - 1 + 400));
  let flow = null;
  try {
    flow = buildMethodFlow(flowSource, {
      line: selected.line,
      args: selected.args,
      decorators: selected.decorators,
      model: selected.model,
      name: selected.name,
      superCalls: selected.superCalls,
    });
  } catch {
    flow = null;
  }
  if (flow !== null) {
    flow.fields = flow.fields.map((entry) => ({ ...entry, attribute: fieldAttribute(entry.name) }));
    flow.decoratorInputs = flow.decoratorInputs.map((entry) => ({ ...entry, attribute: fieldAttribute(entry.name) }));
    flow.outputs.writes = flow.outputs.writes.map((entry) => ({ ...entry, attribute: fieldAttribute(entry.name) }));
  }
  const warnings = [];
  for (const step of formatted) {
    if (step.brokenChain) {
      warnings.push(`${step.module}.${step.className}.${request.name}() does not call super().${request.name}(); the chain stops there in this approximation.`);
    }
  }
  if (formatted.length === 1) warnings.push('Only one definition is indexed for this model.method.');
  return {
    model: request.model,
    name: request.name,
    selectedStep: selectedIndex + 1,
    chain: formatted,
    callers,
    callees,
    related,
    flow,
    modelInfo: modelInfo === null ? null : {
      description: modelInfo.description ?? '',
      table: modelInfo.table ?? '',
      order: modelInfo.order ?? '',
      recName: modelInfo.recName ?? '',
      parentName: modelInfo.parentName ?? '',
      mixins: modelInfo.mixins ?? [],
      fieldCount: modelInfo.fieldCount ?? 0,
    },
    warnings,
    totalLines,
    approxOrder: true,
    stats: data.stats,
  };
}

/**
 * Run one expensive computation through a short-lived cache with in-flight
 * de-duplication and a bounded entry count.
 * @param {object} state - engine state.
 * @param {Map<string, object>} cacheMap - value cache.
 * @param {Map<string, Promise>} inflightMap - in-flight map.
 * @param {string} key - cache key.
 * @param {number} ttl - freshness window in ms.
 * @param {() => Promise<any>} run - the computation.
 * @returns {Promise<any>} the cached or computed value.
 */
function cachedComputation(state, cacheMap, inflightMap, key, ttl, run) {
  const cached = cacheMap.get(key);
  if (cached !== undefined) {
    if (Date.now() - cached.at < ttl) return Promise.resolve(cached.data);
    cacheMap.delete(key);
  }
  const running = inflightMap.get(key);
  if (running !== undefined) return running;
  const promise = (async () => {
    const data = await run();
    cacheMap.set(key, { at: Date.now(), data });
    while (cacheMap.size > 24) {
      const oldest = cacheMap.keys().next().value;
      if (oldest === undefined) break;
      cacheMap.delete(oldest);
    }
    return data;
  })();
  inflightMap.set(key, promise);
  return promise.finally(() => {
    inflightMap.delete(key);
  });
}

/**
 * Run one read-only action. Transport-free: returns the payload or throws
 * `EngineError` with the HTTP status the route maps it to.
 * @param {{ workspaces: () => Array<object>, defaultDirectory: () => (string | undefined) }} host - workspace source.
 * @param {object} state - state from `createState`.
 * @param {string} action - read action name.
 * @param {URLSearchParams} params - action parameters.
 * @returns {Promise<object>} the action payload.
 */
export async function readAction(host, state, action, params) {
  const roots = rootsFor(host, state);
  if (action === 'roots') {
    const payload = {
      roots: roots.map((root) => serializeRoot(state, root)),
      defaultRootId: roots[0]?.id ?? null,
      consoleVersion: CONSOLE_VERSION,
      config: {
        cacheTtlMs: state.options.cacheTtlMs,
        maxFiles: state.options.maxFiles,
        allowEdits: state.options.allowEdits,
        // The Builder panel needs all of these: edits disabled blocks every write,
        // a core root can never be a build target, and the panel builds its field
        // rows from `builderMeta` instead of hard-coding the type table.
        builder: state.options.allowEdits,
        backupOnSave: state.options.backupOnSave,
        builderMeta: state.options.allowEdits ? builderMeta() : null,
        explicitRoots: state.options.roots.map((root) => root.path),
      },
    };
    return payload;
  }

  const resolved = resolveRoot(roots, params.get('root'));
  if (resolved.error !== undefined) {
    throw new EngineError(resolved.error, resolved.error === 'no-roots' ? 409 : 404, resolved.error === 'no-roots' ? 'No Odoo addons root was detected. Set `roots` in the plugin config.' : 'The requested root is not available.');
  }
  const root = resolved.root;

  if (action === 'index') {
    const refresh = params.get('refresh') === '1';
    const index = await ensureIndex(state, root, refresh);
    const payload = {
      root: { id: root.id, path: root.path, label: root.label, kind: root.kind },
      files: index.files,
      stats: index.stats,
    };
    return payload;
  }

  if (action === 'file') {
    const file = resolveFileUnderRoot(root, params.get('file') ?? '');
    if (file === undefined) {
      throw new EngineError('invalid-file', 400, 'The file path is not a relative XML path inside this root.');
    }
    const index = await ensureIndex(state, root, false);
    const entry = index.entries.get(file.rel);
    if (entry === undefined) {
      throw new EngineError('unknown-file', 404, 'This file is not part of the current view index.');
    }
    try {
      const payload = await readFileDetail(state, root, file, entry);
      return payload;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'read-failed';
      throw new EngineError(code, code === 'file-too-large' ? 413 : 404, error instanceof Error ? error.message : 'The file could not be read.');
    }
  }

  if (action === 'module') {
    const moduleName = (params.get('module') ?? '').trim().slice(0, 200);
    if (moduleName.length === 0) {
      throw new EngineError('missing-module', 400, 'A module name is required.');
    }
    const index = await ensureIndex(state, root, false);
    const views = [];
    const fileSet = new Set();
    for (const [rel, entry] of index.entries) {
      if (entry.module !== moduleName) continue;
      fileSet.add(rel);
      for (const view of entry.views) {
        views.push({ file: rel, module: entry.module, group: entry.group, ...viewSummary(view) });
      }
    }
    views.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    return {
      root: { id: root.id, path: root.path },
      module: moduleName,
      files: fileSet.size,
      total: views.length,
      truncated: views.length > MAX_MODULE_VIEWS,
      views: views.slice(0, MAX_MODULE_VIEWS),
    };
  }

  if (action === 'report') {
    const xmlId = (params.get('xmlId') ?? '').trim().slice(0, 300);
    if (xmlId.length === 0) {
      throw new EngineError('missing-xml-id', 400, 'A template xml id is required.');
    }
    const result = await cachedComputation(
      state,
      state.reportCache,
      state.reportInflight,
      `${root.path}\u0000report\u0000${xmlId}`,
      COMPOSE_CACHE_TTL_MS,
      () => collectReportGraph(host, state, roots, root, xmlId),
    );
    if (result === null) {
      throw new EngineError('unknown-view', 404, 'That template id is not defined in this addons root.');
    }
    return { root: { id: root.id, path: root.path }, ...result };
  }

  if (action === 'pyindex') {
    try {
      const scopeMode = params.get('scope') === 'root' ? 'root' : 'workspace';
      const scope = pythonScopeInfo(state, roots, root, scopeMode);
      const data = await ensurePythonIndex(state, scope.scoped, scope.key, params.get('refresh') === '1');
      const query = (params.get('q') ?? '').trim().slice(0, 200);
      const requestedType = params.get('type') ?? 'all';
      const type = ['all', 'method', 'function', 'model'].includes(requestedType) ? requestedType : 'all';
      const limitValue = Number.parseInt(params.get('limit') ?? '200', 10);
      const limit = Number.isFinite(limitValue) ? Math.min(Math.max(limitValue, 1), 2_000) : 200;
      let result;
      if (query.length === 0 && (type === 'all' || type === 'model')) {
        const items = data.models.slice(0, limit).map((model) => ({
          kind: 'model',
          name: model.name,
          model: model.name,
          module: model.modules[0] ?? '',
          classes: model.classes,
          methodCount: model.methods.length,
          modules: model.modules,
          file: '',
          line: 0,
        }));
        result = { items, total: data.models.length, truncated: data.models.length > limit };
      } else {
        result = searchPython(data, query, type, limit);
      }
      return {
        query,
        type,
        items: result.items,
        total: result.total,
        truncated: result.truncated,
        stats: data.stats,
        approxOrder: true,
        scope: { mode: scope.mode, workspace: scope.workspace, roots: scope.labels },
      };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('python-index-failed', 500, error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'secindex' || action === 'sectrace') {
    try {
      const scopeMode = params.get('scope') === 'root' ? 'root' : 'workspace';
      const scope = pythonScopeInfo(state, roots, root, scopeMode);
      const data = await ensureSecurityIndex(state, scope.scoped, `sec\u0000${scope.key}`, params.get('refresh') === '1');
      const scopeInfo = { mode: scope.mode, workspace: scope.workspace, roots: scope.labels };
      if (action === 'secindex') {
        const query = (params.get('q') ?? '').trim().slice(0, 200);
        const requestedType = params.get('type') ?? 'all';
        const type = ['all', 'group', 'model', 'artifact'].includes(requestedType) ? requestedType : 'all';
        const limitValue = Number.parseInt(params.get('limit') ?? '300', 10);
        const limit = Number.isFinite(limitValue) ? Math.min(Math.max(limitValue, 1), 2_000) : 300;
        const result = searchSecurity(data, query, type, limit);
        return { query, type, ...result, stats: data.stats, errors: data.errors.slice(0, 20), scope: scopeInfo };
      }
      const kind = params.get('kind') ?? '';
      const id = (params.get('id') ?? '').trim().slice(0, 300);
      if (id.length === 0 || !['group', 'model', 'artifact'].includes(kind)) {
        throw new EngineError('bad-trace-request', 400, 'kind (group|model|artifact) and id are required.');
      }
      let trace;
      if (kind === 'group') trace = traceGroup(data, id);
      else if (kind === 'artifact') trace = traceArtifact(data, id);
      else {
        trace = traceModel(data, id);
        // Field-level groups live in Python (`fields.X(groups=…)`); a failure is reported, not hidden.
        try {
          const pyScope = pythonScopeInfo(state, roots, root, scopeMode);
          const py = await ensurePythonIndex(state, pyScope.scoped, pyScope.key, false);
          const model = resolveModel(py, trace.model);
          trace.fieldGroups = (model?.fields ?? [])
            .filter((field) => typeof field.attrs?.groups === 'string' && field.attrs.groups.length > 0)
            .map((field) => ({ name: field.name, fieldType: field.fieldType, groups: field.attrs.groups, module: field.module, file: field.file, line: field.line }));
        } catch (error) {
          trace.fieldGroups = [];
          trace.warnings.push({ code: 'python-index-failed', message: `Field-level groups unavailable: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (trace.error !== undefined) {
        throw new EngineError(trace.error, 404, `No ${kind} matches "${id}".`, { error: trace.error, code: trace.error, message: `No ${kind} matches "${id}".`, candidates: trace.candidates ?? [] });
      }
      return { ...trace, stats: data.stats, errors: data.errors.slice(0, 20), scope: scopeInfo };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('security-index-failed', 500, error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'pymethod') {
    const model = (params.get('model') ?? '').trim().slice(0, 200);
    const name = (params.get('name') ?? '').trim().slice(0, 200);
    const file = (params.get('file') ?? '').trim().slice(0, 500);
    const lineValue = Number.parseInt(params.get('line') ?? '', 10);
    const stepValue = Number.parseInt(params.get('step') ?? '0', 10);
    if (name.length === 0) {
      throw new EngineError('missing-method', 400, 'A method name is required.');
    }
    if (model.length === 0 && file.length === 0) {
      throw new EngineError('missing-model', 400, 'A model (or a file hint) is required.');
    }
    try {
      const scopeMode = params.get('scope') === 'root' ? 'root' : 'workspace';
      const scope = pythonScopeInfo(state, roots, root, scopeMode);
      const data = await ensurePythonIndex(state, scope.scoped, scope.key, false);
      let payload;
      if (model.length > 0) {
        payload = await methodPayload(state, data, {
          model,
          name,
          file,
          line: Number.isFinite(lineValue) ? lineValue : undefined,
          step: Number.isFinite(stepValue) ? stepValue : 0,
        });
      } else {
        const hint = data.methods.find((method) => method.name === name && method.file === file && (!Number.isFinite(lineValue) || method.line === lineValue));
        payload = hint === undefined ? null : await (async () => {
          const single = { ...data, methods: [hint], byMethod: new Map([[name, [hint]]]) };
          const chain = [{ ...hint }];
          return methodPayload(state, single, { model: hint.model, name, file, line: hint.line, step: 0, single: true }).catch(() => null);
        })();
      }
      if (payload === null) {
        const availableModels = [...new Set((data.byMethod.get(name) ?? []).map((method) => method.model).filter(Boolean))];
        throw new EngineError('unknown-method', 404, 'That method is not defined for the requested model.', { error: 'unknown-method', message: 'That method is not defined for the requested model.', availableModels });
      }
      return { ...payload, scope: { mode: scope.mode, workspace: scope.workspace, roots: scope.labels } };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('python-method-failed', 500, error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'pymodel') {
    const model = (params.get('model') ?? '').trim().slice(0, 200);
    if (model.length === 0) {
      throw new EngineError('missing-model', 400, 'A model name is required.');
    }
    try {
      const scopeMode = params.get('scope') === 'root' ? 'root' : 'workspace';
      const scope = pythonScopeInfo(state, roots, root, scopeMode);
      const data = await ensurePythonIndex(state, scope.scoped, scope.key, false);
      const payload = resolveModel(data, model);
      if (payload === null) {
        throw new EngineError('unknown-model', 404, 'That model is not defined in the indexed Python files.', { error: 'unknown-model', message: 'That model is not defined in the indexed Python files.' });
      }
      return { ...payload, stats: data.stats, approxOrder: true, scope: { mode: scope.mode, workspace: scope.workspace, roots: scope.labels } };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('python-model-failed', 500, error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'fields') {
    const model = (params.get('model') ?? '').trim().slice(0, 200);
    if (model.length === 0) {
      throw new EngineError('missing-model', 400, 'A model name is required.');
    }
    // `module` (+`into`/`depends`) turns the list into a reachability report: the
    // panel can then disable a field the target module cannot use (D7).
    const builderModule = (params.get('module') ?? '').trim().slice(0, 200);
    let closure;
    if (builderModule.length > 0) {
      try {
        const into = params.get('into') ?? '';
        let addonsDir = root.path;
        if (into.trim().length > 0) {
          addonsDir = resolveRelativeDir(root, into.trim()) ?? root.path;
        } else if (/^[a-z][a-z0-9_]{0,63}$/.test(builderModule)) {
          const found = await locateModule([root], builderModule);
          if (found.length === 1) addonsDir = found[0];
        }
        const dependsParam = (params.get('depends') ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .slice(0, 40);
        const spec = { module: builderModule, ...(dependsParam.length > 0 ? { createModule: { depends: dependsParam } } : {}) };
        const existing = await readPlanContext(addonsDir, spec);
        closure = await dependsClosure(roots, spec, existing);
      } catch (error) {
        if (error instanceof ApplyError) {
          throw new EngineError(error.code, applyErrorStatus(error.code), error.message);
        }
        throw error;
      }
    }
    try {
      const scopeMode = params.get('scope') === 'root' ? 'root' : 'workspace';
      const scope = pythonScopeInfo(state, roots, root, scopeMode);
      const data = await ensurePythonIndex(state, scope.scoped, scope.key, false);
      const payload = resolveModel(data, model);
      if (payload === null) {
        throw new EngineError('unknown-model', 404, 'That model is not defined in the indexed Python files.');
      }
      const requested = (params.get('names') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => /^[A-Za-z_]\w*$/.test(entry))
        .slice(0, 240);
      const wanted = new Set(requested);
      const rows = [];
      for (const field of payload.fields) {
        if (wanted.size > 0 && !wanted.has(field.name)) continue;
        rows.push({
          name: field.name,
          fieldType: field.fieldType,
          comodel: field.comodel,
          string: field.string,
          selection: parseSelectionLiteral(field.attrs?.selection),
          ...(builderModule.length > 0 ? { module: field.module ?? '', modules: field.modules ?? [], definitions: field.definitions ?? 1 } : {}),
        });
      }
      const seen = new Set(rows.map((row) => row.name));
      // `classifyFields` is the same reachability test `buildPlan` uses, so the
      // panel and the plan can never disagree about a field.
      const classified = closure === undefined
        ? rows
        : classifyFields(rows.map((row) => ({ ...row, type: row.fieldType })), closure);
      return {
        root: { id: root.id, path: root.path },
        model,
        fieldCount: classified.length,
        fields: classified,
        missing: requested.filter((name) => !seen.has(name)),
        mixins: payload.mixins ?? [],
        builderModule: builderModule.length > 0 ? builderModule : null,
        scope: { mode: scope.mode, workspace: scope.workspace, roots: scope.labels },
      };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('python-model-failed', 500, error instanceof Error ? error.message : String(error));
    }
  }

  if (action === 'search') {
    const query = (params.get('q') ?? '').slice(0, MAX_QUERY_LENGTH).trim();
    if (query.length === 0) {
      throw new EngineError('missing-query', 400, 'A search query is required.');
    }
    const type = (params.get('type') ?? '').trim().toLowerCase();
    const index = await ensureIndex(state, root, false);
    const result = searchIndex(index, query, type, MAX_SEARCH_RESULTS, state.globalTypes);
    return { root: { id: root.id, path: root.path }, ...result };
  }

  if (action === 'compose') {
    const xmlId = (params.get('xmlId') ?? '').trim().slice(0, 300);
    if (xmlId.length === 0) {
      throw new EngineError('missing-xml-id', 400, 'A view xml id is required.');
    }
    const mode = (params.get('mode') ?? 'chain').toLowerCase() === 'all' ? 'all' : 'chain';
    const composition = await cachedComputation(
      state,
      state.composeCache,
      state.composeInflight,
      `${root.path}\u0000${mode}\u0000${xmlId}`,
      COMPOSE_CACHE_TTL_MS,
      () => composeView(host, state, roots, root, xmlId, mode),
    );
    if (composition === null) {
      throw new EngineError('unknown-view', 404, 'That view id is not defined in this addons root.');
    }
    return { root: { id: root.id, path: root.path }, ...composition };
  }

  if (action === 'related') {
    const xmlId = (params.get('xmlId') ?? '').trim().slice(0, 300);
    if (xmlId.length === 0) {
      throw new EngineError('missing-xml-id', 400, 'A view xml id is required.');
    }
    const index = await ensureIndex(state, root, false);
    return { root: { id: root.id, path: root.path }, ...relatedIndex(index, xmlId, state.globalTypes) };
  }

  if (action === 'actions') {
    const index = await ensureIndex(state, root, false);
    const joined = collectIndexActions(index);
    const lookup = buildViewRefLookup(index);
    const rows = joined.actions.map((row) => actionSummary(row, state, lookup, root.id));
    const query = (params.get('q') ?? '').slice(0, MAX_QUERY_LENGTH).trim();
    const modelFilter = (params.get('model') ?? '').trim().slice(0, 200);
    const kind = params.get('kind') === 'windowView' ? 'windowView' : '';
    const limitValue = Number.parseInt(params.get('limit') ?? String(MAX_ACTIONS_RESULTS), 10);
    const limit = Number.isFinite(limitValue) ? Math.min(Math.max(limitValue, 1), 1_000) : MAX_ACTIONS_RESULTS;
    const result = searchActions(rows, query, modelFilter, kind);
    return {
      root: { id: root.id, path: root.path },
      query,
      model: modelFilter,
      kind,
      items: result.items.slice(0, limit),
      total: result.total,
      truncated: result.total > limit,
      actionCount: joined.total,
      linkCount: joined.links.length,
    };
  }

  if (action === 'action') {
    const xmlId = (params.get('xmlId') ?? '').trim().slice(0, 300);
    if (xmlId.length === 0) {
      throw new EngineError('missing-xml-id', 400, 'An action xml id is required.');
    }
    const index = await ensureIndex(state, root, false);
    const joined = collectIndexActions(index);
    const exact = joined.actions.find((row) => row.xmlId === xmlId)
      ?? joined.actions.find((row) => row.id === xmlId)
      ?? joined.actions.find((row) => shortIdOf(row.xmlId) === xmlId);
    if (exact === undefined) {
      throw new EngineError('unknown-action-record', 404, 'That window action is not defined in this addons root.');
    }
    let summary = actionSummary(exact, state, buildViewRefLookup(index), root.id);
    // A custom action that opens a core view needs the core root indexed to
    // resolve `view_id`/act_window.view refs. Index other roots on demand, the
    // same way compose mode=all does (once per root, cached afterwards).
    if (summary.views.some((view) => view.viewRef.length > 0 && view.found !== true)) {
      for (const candidate of roots) {
        if (candidate.path === root.path) continue;
        if (state.indexCache.get(candidate.path)?.data !== undefined) continue;
        try {
          await ensureIndex(state, candidate, false);
        } catch {
          // An unreadable root simply contributes no views.
        }
      }
      summary = actionSummary(exact, state, buildViewRefLookup(index), root.id);
    }
    let fields = {};
    let recordSource = '';
    let recordFields = null;
    const fieldOrigins = {};
    const sources = [];
    const definitions = Array.isArray(exact.definitions) && exact.definitions.length > 0
      ? exact.definitions
      : [{ module: exact.module, file: exact.file }];
    // Patches first, the primary definition last, so the complete record wins.
    const ordered = definitions.filter((definition) => definition.file !== exact.file)
      .concat(definitions.filter((definition) => definition.file === exact.file));
    const seenFiles = new Set();
    for (const definition of ordered.slice(0, 12)) {
      if (seenFiles.has(definition.file)) continue;
      seenFiles.add(definition.file);
      const file = resolveFileUnderRoot(root, definition.file);
      const entry = index.entries.get(definition.file);
      if (file === undefined || entry === undefined) continue;
      try {
        const detail = await readFileDetail(state, root, file, entry);
        const raw = (detail.actions ?? []).find((action) => action.xmlId === exact.xmlId || action.id === exact.id);
        if (raw !== undefined && raw.fields !== null && typeof raw.fields === 'object') {
          fields = { ...fields, ...raw.fields };
          for (const name of Object.keys(raw.fields)) fieldOrigins[name] = `${definition.module}/${definition.file}`;
        }
        if (raw !== undefined && typeof raw.sourceRaw === 'string' && raw.sourceRaw.length > 0) {
          const source = {
            module: definition.module,
            file: definition.file,
            line: definition.line,
            patch: definition.file !== exact.file,
            mtimeMs: typeof detail.mtimeMs === 'number' ? detail.mtimeMs : null,
            size: typeof detail.size === 'number' ? detail.size : null,
            source: raw.sourceRaw,
          };
          sources.push(source);
          if (definition.file === exact.file) {
            recordSource = raw.sourceRaw;
            recordFields = scanRecordFields(raw.sourceRaw);
          }
        }
      } catch {
        // The action summary is still useful when its file cannot be re-read.
      }
    }
    sources.sort((left, right) => Number(left.patch) - Number(right.patch) || left.file.localeCompare(right.file));
    const primaryEntry = index.entries.get(exact.file);
    return {
      root: { id: root.id, path: root.path },
      action: {
        ...summary,
        fields,
        fieldOrigins,
        sources,
        source: recordSource,
        // Exact `<field>` spans of the primary record, so the editor can
        // replace one field value, drop a field, or append a new one without
        // regenerating the whole record.
        recordFields: recordFields === null
          ? null
          : {
            ok: recordFields.ok,
            selfClosing: recordFields.selfClosing,
            openEnd: recordFields.openEnd,
            closeStart: recordFields.closeStart,
            fields: recordFields.fields.map((field) => ({
              name: field.name,
              attrs: field.attrs,
              start: field.start,
              end: field.end,
              innerStart: field.innerStart,
              innerEnd: field.innerEnd,
              selfClosing: field.selfClosing,
              hasChildElements: field.hasChildElements,
            })),
          },
        // Version of the file that owns the primary definition (save guard).
        version: {
          file: exact.file,
          mtimeMs: typeof primaryEntry?.mtimeMs === 'number' ? primaryEntry.mtimeMs : null,
          size: typeof primaryEntry?.size === 'number' ? primaryEntry.size : null,
        },
      },
    };
  }

  if (action === 'xpath') {
    try {
      const payload = await computeXPathPayload(host, state, roots, root, {
        xmlId: params.get('xmlId') ?? '',
        expr: params.get('expr') ?? '',
        mode: params.get('mode') ?? 'base',
        payload: params.get('payload') ?? '',
      });
      return { root: { id: root.id, path: root.path }, ...payload };
    } catch (error) {
      if (error instanceof RequestError) {
        throw new EngineError(error.code, error.status, error.message);
      }
      throw new EngineError('xpath-failed', 500, error instanceof Error ? error.message : 'The locator could not be evaluated.');
    }
  }

  if (action === 'xpathbase') {
    const xmlId = (params.get('xmlId') ?? '').trim().slice(0, 300);
    if (xmlId.length === 0) {
      throw new EngineError('missing-xml-id', 400, 'A view xml id is required.');
    }
    const mode = params.get('mode') === 'own' ? 'own' : 'base';
    const index = await ensureIndex(state, root, false);
    const target = findView(index, xmlId);
    if (target === null) {
      throw new EngineError('unknown-view', 404, 'That view id is not defined in this addons root.');
    }
    const location = { rootPath: root.path, module: target.module, file: target.file, view: target.view };
    const resolved = await resolveXPathTree(state, roots, location, mode);
    return {
      root: { id: root.id, path: root.path },
      target: { ...viewSummary(target.view), file: target.file, module: target.module, rootId: root.id },
      mode,
      scope: resolved.scope,
      baseXmlId: resolved.baseXmlId,
      missingBase: resolved.missingBase,
      complete: resolved.complete,
      tree: resolved.tree,
    };
  }

  throw new EngineError('unknown-action', 404, `Unknown action "${action}".`);
}

/**
 * Create the plugin state shared by every request.
 * @param {{ roots: Array<{ path: string, label: string }>, cacheTtlMs: number, maxFiles: number, maxFileBytes: number }} options - resolved options.
 * @returns {object} plugin state.
 */
export function createState(options) {
  return {
    options,
    rootsCache: { at: 0, roots: null },
    disabledFolders: new Map(),
    indexCache: new Map(),
    fileCache: new Map(),
    globalTypes: { byXmlId: new Map(), byShortId: new Map() },
    viewLocator: new Map(),
    viewShortLocator: new Map(),
    modelLocator: new Map(),
    parseCache: new Map(),
    walkCache: new Map(),
    composeCache: new Map(),
    reportCache: new Map(),
    composeInflight: new Map(),
    reportInflight: new Map(),
    moduleDirCache: new Map(),
    moduleDepsCache: new Map(),
    pyCache: new Map(),
    secCache: new Map(),
    pyFileCache: new Map(),
    saveLocks: new Map(),
  };
}

/**
 * Engine facade for non-HTTP callers (the CLI, scripts). Owns one state, so the
 * caches live as long as the returned object.
 * @param {{ base?: string, roots?: string[], host?: object }} options - `roots` (explicit addons dirs)
 *   wins over discovery; discovery reads `host`, else a host built from `base`.
 * @returns {{ state: object, host: object, read: (action: string, params?: URLSearchParams | string | Record<string, string>) => Promise<object>, roots: () => Array<object> }} engine.
 */
export function createEngine(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : [];
  let host = options.host;
  if (host === undefined) {
    if (typeof options.base === 'string' && options.base.length > 0) host = hostFromBase(resolve(options.base));
    else if (roots.length > 0) host = { workspaces: () => [], defaultDirectory: () => undefined }; // explicit roots never consult the host
    else throw new EngineError('missing-base', 400, 'createEngine needs `roots`, `base` or `host` to find addons roots.');
  }
  const state = createState(resolveConfig(roots.length > 0 ? { roots } : null));
  return {
    state,
    host,
    read: (action, params = '') => readAction(host, state, action, params instanceof URLSearchParams ? params : new URLSearchParams(params)),
    roots: () => rootsFor(host, state),
  };
}

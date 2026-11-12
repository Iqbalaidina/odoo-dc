/**
 * Write a `lib/builder.js` plan to disk, and gather the context a plan needs.
 *
 * Used by the CLI (`odoo-dc model new … --apply`) and, later, the Host `build`
 * action. Safety rules (no VCS on this workspace):
 * - only an addons directory inside a non-core root is writable (`assertWritableTarget`);
 * - every path stays inside that directory (no absolute paths, no `..`);
 * - `create` refuses an existing file, `patch` refuses a file whose text changed since the plan
 *   (`stale-file`); all checks run before the first write;
 * - patched files get a `<file>.bak` of the previous bytes and are replaced by temp-file rename;
 * - if a write fails midway, files created so far are removed and patched files restored
 *   (declared degrade), and the error reports what happened.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { manifestDepends, plannedPaths } from './builder.js';

/** Error with a stable code and the exit code the CLI should use. */
export class ApplyError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.exitCode = 1;
    Object.assign(this, extra);
  }
}

const CORE_PATTERNS = [/[/\\]odoo[/\\]addons([/\\]|$)/, /[/\\]odoo[/\\]odoo[/\\]addons([/\\]|$)/, /(^|[/\\])enterprise([/\\]|$)/];

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Refuse a target that is not inside a discovered, non-core root.
 * @param {string} addonsDir - absolute target addons directory.
 * @param {Array<{ path: string, label?: string }>} roots - discovered roots.
 * @returns {object} the root that contains the target.
 */
export function assertWritableTarget(addonsDir, roots) {
  const target = resolve(addonsDir);
  if (CORE_PATTERNS.some((pattern) => pattern.test(target))) {
    throw new ApplyError('core-root', `${target} is a core/enterprise addons directory; the builder writes only to custom addons`);
  }
  const root = roots.find((candidate) => inside(candidate.path, target));
  if (root === undefined) throw new ApplyError('outside-roots', `${target} is not inside any detected addons root (${roots.map((r) => r.path).join(', ')})`);
  if (CORE_PATTERNS.some((pattern) => pattern.test(root.path))) throw new ApplyError('core-root', `${target} is inside core root ${root.path}`);
  return root;
}

/**
 * Resolve one plan path inside the target directory.
 * @param {string} addonsDir - absolute target directory.
 * @param {string} rel - plan path.
 * @returns {string} absolute path.
 */
function resolvePlanPath(addonsDir, rel) {
  const segments = String(rel).replaceAll('\\', '/').split('/');
  if (isAbsolute(rel) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ApplyError('bad-path', `Plan path "${rel}" is not a plain relative path`);
  }
  const abs = resolve(addonsDir, ...segments);
  if (!inside(addonsDir, abs)) throw new ApplyError('bad-path', `Plan path "${rel}" escapes ${addonsDir}`);
  return abs;
}

/** Read a file or return undefined when it does not exist; other errors propagate. */
async function readIfExists(abs) {
  try {
    return await readFile(abs, 'utf8');
  } catch (error) {
    // ENOTDIR: a parent is a file, so this path cannot exist (the write step will fail and roll back).
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw new ApplyError('read-failed', `${abs}: ${error.message}`);
  }
}

/**
 * Current text of every file the plan may touch.
 * @param {string} addonsDir - target directory.
 * @param {object} spec - builder spec.
 * @returns {Promise<Record<string, string>>} existing files by plan path.
 */
export async function readPlanContext(addonsDir, spec) {
  const existing = {};
  for (const rel of plannedPaths(spec)) {
    const text = await readIfExists(resolvePlanPath(addonsDir, rel));
    if (text !== undefined) existing[rel] = text;
  }
  return existing;
}

/**
 * Every xml id declared in a module's XML files (`id="…"` on records, menus, templates).
 * @param {string} moduleDir - absolute module directory.
 * @param {string} module - module name (to qualify short ids).
 * @returns {Promise<Set<string>>} qualified ids.
 */
export async function moduleXmlIds(moduleDir, module) {
  const ids = new Set();
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new ApplyError('read-failed', `${dir}: ${error.message}`);
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4 && !entry.name.startsWith('.') && entry.name !== 'static') await walk(abs, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.xml')) {
        const text = (await readFile(abs, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
        for (const match of text.matchAll(/<(?:record|menuitem|template|report|act_window)\b[^>]*?\sid\s*=\s*["']([^"']+)["']/g)) {
          ids.add(match[1].includes('.') ? match[1] : `${module}.${match[1]}`);
        }
      }
    }
  };
  await walk(moduleDir, 0);
  return ids;
}

/**
 * Find the addons directory that holds `<module>/__manifest__.py`, searching each root
 * and its first-level collection subfolders.
 * @param {Array<{ path: string, subfolders?: Array<{ name: string }> }>} roots - roots to search.
 * @param {string} module - module name.
 * @returns {Promise<string[]>} candidate addons directories (absolute).
 */
export async function locateModule(roots, module) {
  const found = [];
  for (const root of roots) {
    const dirs = [root.path, ...(root.subfolders ?? []).map((folder) => join(root.path, folder.name))];
    for (const dir of dirs) {
      if ((await readIfExists(join(dir, module, '__manifest__.py'))) !== undefined && !found.includes(dir)) found.push(dir);
    }
  }
  return found;
}

/**
 * The target module plus its transitive `depends`, read from manifests across every root
 * (core included). A dependency that cannot be found is skipped: Odoo reports it at install,
 * and the closure only narrows which fields views may use.
 * @param {Array<{ path: string, subfolders?: Array<{ name: string }> }>} roots - all roots.
 * @param {object} spec - builder spec (`module`, optional `createModule.depends`).
 * @param {Record<string, string>} existing - from `readPlanContext` (holds the target manifest).
 * @returns {Promise<Set<string> | undefined>} closure, or undefined when the depends are unknown.
 */
export async function dependsClosure(roots, spec, existing) {
  const module = spec.module;
  const own = existing[`${module}/__manifest__.py`];
  const start = own !== undefined ? manifestDepends(own) : (spec.createModule?.depends ?? (spec.createModule ? ['base'] : undefined));
  if (start === undefined) return undefined;
  const closure = new Set([module]);
  const queue = [...start];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    const [dir] = await locateModule(roots, name);
    if (dir !== undefined) queue.push(...manifestDepends(await readIfExists(join(dir, name, '__manifest__.py')) ?? ''));
  }
  return closure;
}

/**
 * Write a plan atomically per file, with rollback on a midway failure.
 * @param {string} addonsDir - target directory (already checked with `assertWritableTarget`).
 * @param {{ ok: boolean, files: object[] }} plan - plan from `buildPlan`.
 * @param {{ backup?: boolean }} [options] - `backup` (default true) writes `<file>.bak` before a patch.
 * @returns {Promise<{ created: string[], patched: string[], backups: string[] }>} what was written.
 */
export async function applyPlan(addonsDir, plan, options = {}) {
  if (plan?.ok !== true) throw new ApplyError('plan-not-ok', 'Refusing to apply a plan with errors');
  const backup = options.backup !== false;
  const steps = plan.files.map((file) => ({ ...file, abs: resolvePlanPath(addonsDir, file.path) }));
  for (const step of steps) {
    const current = await readIfExists(step.abs);
    if (step.op === 'create' && current !== undefined) throw new ApplyError('file-exists', `${step.path} appeared after the plan was made`);
    if (step.op === 'patch' && current !== step.before) throw new ApplyError('stale-file', `${step.path} changed after the plan was made; re-run the command`);
    if (step.op !== 'create' && step.op !== 'patch') throw new ApplyError('bad-plan', `${step.path}: unknown op ${step.op}`);
  }
  const done = { created: [], patched: [], backups: [] };
  const undo = [];
  try {
    for (const step of steps) {
      await mkdir(dirname(step.abs), { recursive: true });
      if (step.op === 'create') {
        await writeFile(step.abs, step.after, { encoding: 'utf8', flag: 'wx' });
        undo.push(() => unlink(step.abs));
        done.created.push(step.path);
      } else {
        if (backup) {
          await atomicWrite(`${step.abs}.bak`, step.before);
          done.backups.push(`${step.path}.bak`);
        }
        await atomicWrite(step.abs, step.after);
        undo.push(() => atomicWrite(step.abs, step.before));
        done.patched.push(step.path);
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    throw new ApplyError('write-failed', `Write failed (${error.message}); rolled back ${undo.length} file(s)${rollbackErrors.length > 0 ? `, rollback errors: ${rollbackErrors.join('; ')}` : ''}`, { written: done, rollbackErrors });
  }
  return done;
}

/** Temp file + rename in the same directory. */
async function atomicWrite(abs, text) {
  const temporary = `${abs}.odoo-builder-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, abs);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // dt:escape temp file may not exist; the original error is rethrown below.
    }
    throw error;
  }
}

/**
 * Small line diff (LCS) for patch previews. Files the builder patches are small.
 * @param {string} before - old text.
 * @param {string} after - new text.
 * @returns {string[]} lines prefixed with ' ', '-', '+'.
 */
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push(`-${a[i]}`); i += 1; }
    else { out.push(`+${b[j]}`); j += 1; }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out;
}


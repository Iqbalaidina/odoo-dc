/**
 * Regression checks for the G1…G8 gaps found in the EXPERIENCE-imt-audit-2026-11-14
 * performance/UX audit, against the payload/flag contract of
 * `scratchs/odoo-dc-vs-grep/FIX-PLAN-2026-11-14.md`:
 *
 *   G1 multi-definer fields     G4 One2many inverse sanity
 *   G2 install-state awareness  G5 duplicate-logic clusters
 *   G3 callers (python/XML/server action)   G6/G7 brief grouping, module filter, --db
 *   G8 the odoo-dc shim is discoverable
 *
 * Every fixture is a throwaway addons tree under mkdtemp; the real CLI runs
 * against it, and the G2 cases drive createEngine in-process because they need
 * an `installedModules` list the CLI only passes through.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../lib/engine.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'odoo-dc.mjs');
// The discovery shim (G8) is per-machine: resolve it from $PATH-adjacent
// defaults, or from ODOO_DC_SHIM, and skip the check when it is not installed.
const SHIM = process.env.ODOO_DC_SHIM ?? join(homedir(), '.local', 'bin', 'odoo-dc');

let base;
let cacheDir;
const trees = {};

/** Write one module with a manifest (with `depends`) and the given files. */
function module(root, name, files, depends = []) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const deps = `[${depends.map((dep) => `'${dep}'`).join(', ')}]`;
  writeFileSync(join(dir, '__manifest__.py'), `{'name': '${name}', 'depends': ${deps}}\n`);
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

/** 1-based line of the first line containing `needle`, so line assertions stay absolute. */
function lineOf(text, needle) {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `fixture line not found: ${needle}`);
  return index + 1;
}

/** Env of every CLI run: explicit addons only, no ambient install state, shared cache dir. */
function cliEnv(extra = {}) {
  return {
    ...process.env,
    ODOO_DC_CACHE_DIR: cacheDir,
    ODOO_DC_ADDONS: '',
    ODOO_DC_DB: '',
    ODOO_DC_INSTALLED: '',
    ...extra,
  };
}

/** Run the CLI over several addons roots of one workspace (search scope cases). */
function runWorkspace(roots, ...args) {
  const argv = [CLI];
  for (const root of roots) argv.push('--addons', root);
  argv.push('--base', base, ...args);
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', env: cliEnv() });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { ...result, json };
}

/** Run the CLI against one throwaway root and parse its JSON stdout when it printed any. */
function runIn(root, ...args) {
  const result = spawnSync(process.execPath, [CLI, '--addons', root, '--base', root, ...args], { encoding: 'utf8', env: cliEnv() });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { ...result, json };
}

before(() => {
  base = mkdtempSync(join(tmpdir(), 'odoo-dc-audit-'));
  cacheDir = join(base, 'cache');
  trees.fields = join(base, 'fields-addons');
  trees.relation = join(base, 'relation-addons');
  trees.callers = join(base, 'callers-addons');
  trees.dupes = join(base, 'dupes-addons');
  trees.install = join(base, 'install-addons');
  trees.searchCustom = join(base, 'search-custom');
  trees.searchCore = join(base, 'search-core');

  // G1 + G6/G7: one model across three modules. `amount`/`qty` are declared by
  // acme_a and overridden by acme_b; zeta_mod adds a field only it owns, which is
  // exactly the group `--module acme_*` must leave out.
  module(trees.fields, 'acme_a', {
    'models/thing.py': `from odoo import models, fields


class Thing(models.Model):
    _name = 'acme.thing'
    _description = 'Thing'

    amount = fields.Monetary('acme.thing', string='Amount A')
    alpha = fields.Char(string='Alpha')
    beta = fields.Float(string='Beta')
    gamma = fields.Boolean(string='Gamma')
    qty = fields.Integer(string='Qty A')

    def action_a(self):
        return 1
`,
  }, ['base']);
  module(trees.fields, 'acme_b', {
    'models/thing.py': `from odoo import models, fields


class Thing(models.Model):
    _inherit = 'acme.thing'

    amount = fields.Monetary('acme.thing', string='Amount B', help='second')
    delta = fields.Char(string='Delta')
    epsilon = fields.Char(string='Epsilon')
    qty = fields.Integer(string='Qty B')

    def action_b(self):
        return 2
`,
  }, ['acme_a']);
  module(trees.fields, 'zeta_mod', {
    'models/thing.py': `from odoo import models, fields


class Thing(models.Model):
    _inherit = 'acme.thing'

    zeta = fields.Char(string='Zeta')

    def action_zeta(self):
        return 3
`,
  }, ['acme_a']);

  // G4: a One2many whose declared inverse is a Many2one to another model loads
  // fine but is silently empty at runtime; the four fields cover the four cases.
  module(trees.relation, 'acme_r', {
    'models/rel.py': `from odoo import models, fields


class Thing(models.Model):
    _name = 'acme.thing'

    line_bad_ids = fields.One2many('acme.line', 'thing_id')
    line_ok_ids = fields.One2many('acme.line', 'owner_id')
    line_no_inv_ids = fields.One2many('acme.line')
    line_missing_ids = fields.One2many('acme.line', 'nope_id')


class Line(models.Model):
    _name = 'acme.line'

    thing_id = fields.Many2one('res.currency')
    owner_id = fields.Many2one('acme.thing')
`,
  }, ['base']);

  // G3: every call-site kind in one root — an object button, a <function> in a
  // data-free arch, a type="action" button (never a Python call), a server action
  // whose code calls the method, and two Python callers with different receivers.
  module(trees.callers, 'acme_c', {
    'models/calls.py': `from odoo import models, fields


class Thing(models.Model):
    _name = 'acme.thing'

    def action_go(self):
        return True


class Other(models.Model):
    _name = 'acme.other'

    def _run(self):
        self.env['acme.thing'].action_go()

    def _run_local(self):
        service = self.env['acme.thing']
        service.action_go()
`,
    'views/calls.xml': `<odoo>
  <record id="view_object" model="ir.ui.view">
    <field name="name">thing.object</field>
    <field name="model">acme.thing</field>
    <field name="arch" type="xml"><form><header><button name="action_go" type="object" string="Go"/></header></form></field>
  </record>
  <record id="view_function" model="ir.ui.view">
    <field name="name">thing.function</field>
    <field name="model">acme.thing</field>
    <field name="arch" type="xml"><form><header><function name="action_go"/></header></form></field>
  </record>
  <record id="view_action_type" model="ir.ui.view">
    <field name="name">thing.act</field>
    <field name="model">acme.thing</field>
    <field name="arch" type="xml"><form><button name="action_go" type="action" string="Open"/></form></field>
  </record>
  <record id="sa_go" model="ir.actions.server">
    <field name="name">Go</field>
    <field name="state">code</field>
    <field name="code">record.action_go()</field>
    <field name="model_id" ref="model_acme_thing"/>
  </record>
</odoo>
`,
  }, ['base']);

  // G5: the drill/MRO pair is semantic duplication (a recorded limitation of the
  // token score), so the fixture copies a real near-identical body instead:
  // same tokens after normalisation, different literal, comment and docstring.
  module(trees.dupes, 'acme_d_a', {
    'models/thing.py': `from odoo import models, fields


class Thing(models.Model):
    _name = 'acme.thing'

    def _issue_materials(self):
        """Flush reservations for one work order."""
        result = 0
        for line in self.line_ids:
            if line.qty <= 0:
                continue
            product = line.product_id
            if not product:
                continue
            qty = line.qty + 1
            price = product.standard_price * qty
            total = price + 10
            values = {'product_id': product.id, 'qty': qty}
            self.env['stock.move'].create(values)
            result = result + qty
        self.write({'state': 'done'})
        return result

    def _unrelated(self):
        total = 0
        for record in self:
            name = record.name or 'x'
            if len(name) > 3:
                total = total + len(name)
            else:
                total = total - 1
            for char in name:
                total = total ^ ord(char)
            if total < 0:
                total = -total
        self.env['acme.log'].create({'total': total})
        return total

    def tiny(self):
        return 1
`,
  }, ['base']);
  module(trees.dupes, 'acme_d_b', {
    'models/request.py': `from odoo import models, fields


class Request(models.Model):
    _name = 'acme.mro.request'

    def _issue_materials(self):
        """MRO copy of the drill logic."""
        # Copied by the MRO module; keep the bodies in sync.
        result = 0
        for line in self.line_ids:
            if line.qty <= 0:
                continue
            product = line.product_id
            if not product:
                continue
            qty = line.qty + 1
            price = product.standard_price * qty
            total = price + 10
            values = {'product_id': product.id, 'qty': qty}
            self.env['stock.move'].create(values)
            result = result + qty
        self.write({'state': 'closed'})
        return result
`,
    'models/hidden.py': `from odoo import models, fields


class Hidden(models.Model):
    _name = 'acme.hidden'

    def _copy_one(self):
        result = []
        for row in self.row_ids:
            if row.active:
                value = row.amount * 3
                result.append(value)
        if not result:
            result.append(0)
        self.write({'total': sum(result)})
        return result

    def _copy_two(self):
        result = []
        for row in self.row_ids:
            if row.active:
                value = row.amount * 3
                result.append(value)
        if not result:
            result.append(0)
        self.write({'total': sum(result)})
        return result
`,
  }, ['acme_d_a']);

  // G2: same field and one view per module, so install-state filtering has a
  // definer row and a search hit to drop for acme_b.
  // Search scope: two addons directories of the same workspace, both holding a
  // res.partner form view. The custom one answers first, so a per-root search
  // would return it and stop, hiding the core hit.
  module(trees.searchCustom, 'acme_shop', {
    'views/partner.xml': `<odoo><record id="view_partner_form_shop" model="ir.ui.view">
    <field name="name">res.partner.form.shop</field>
    <field name="model">res.partner</field>
    <field name="arch" type="xml"><form><field name="name"/></form></field>
</record></odoo>
`,
  }, ['base']);
  module(trees.searchCore, 'core_partner', {
    'views/partner.xml': `<odoo><record id="view_partner_form_core" model="ir.ui.view">
    <field name="name">res.partner.form.core</field>
    <field name="model">res.partner</field>
    <field name="arch" type="xml"><form><field name="name"/></form></field>
</record><record id="view_partner_tree_core" model="ir.ui.view">
    <field name="name">res.partner.tree.core</field>
    <field name="model">res.partner</field>
    <field name="arch" type="xml"><tree><field name="name"/></tree></field>
</record></odoo>
`,
  }, ['base']);

  module(trees.install, 'acme_a', {
    'models/m.py': `from odoo import models, fields


class Thing(models.Model):
    _name = 'acme.thing'

    qty = fields.Float(string='Qty A')
`,
    'views/v.xml': `<odoo>
  <record id="view_a" model="ir.ui.view">
    <field name="name">thing.a</field>
    <field name="model">acme.thing</field>
    <field name="arch" type="xml"><form><field name="qty"/></form></field>
  </record>
</odoo>
`,
  }, ['base']);
  module(trees.install, 'acme_b', {
    'models/m.py': `from odoo import models, fields


class Thing(models.Model):
    _inherit = 'acme.thing'

    qty = fields.Float(string='Qty B')
`,
    'views/v.xml': `<odoo>
  <record id="view_b" model="ir.ui.view">
    <field name="name">thing.b</field>
    <field name="model">acme.thing</field>
    <field name="arch" type="xml"><form><field name="qty"/></form></field>
  </record>
</odoo>
`,
  }, ['acme_a']);
});

after(() => rmSync(base, { recursive: true, force: true }));

describe('G1 — every module that defines a field is reported', () => {
  test('field: two definers, one effective, kwargs preserved per row', () => {
    // Gap: definition carried only the effective definer (with a bare count), so
    // who else overrides a field was invisible.
    const result = runIn(trees.fields, 'field', 'acme.thing', 'amount');
    assert.equal(result.status, 0, result.stderr);
    const definition = result.json.definition;
    assert.equal(definition.definitions, 2);
    assert.deepEqual(definition.definers.map((row) => row.module), ['acme_a', 'acme_b']);
    assert.equal(definition.definers.filter((row) => row.effective === true).length, 1);
    assert.equal(definition.definers.find((row) => row.effective === true).module, 'acme_b', 'the higher module rank is effective');
    assert.equal(definition.module, 'acme_b');
    const [start, override] = definition.definers;
    assert.equal(start.attrs.string, 'Amount A');
    assert.equal(start.attrs.help, undefined);
    assert.equal(override.attrs.string, 'Amount B');
    assert.equal(override.attrs.help, 'second');
    // Absolute source positions, so a definer opens at its real declaration.
    const startSource = readFileSync(join(trees.fields, 'acme_a', 'models', 'thing.py'), 'utf8');
    const overrideSource = readFileSync(join(trees.fields, 'acme_b', 'models', 'thing.py'), 'utf8');
    assert.equal(start.file, 'acme_a/models/thing.py');
    assert.equal(start.line, lineOf(startSource, 'amount = fields.Monetary'));
    assert.equal(override.file, 'acme_b/models/thing.py');
    assert.equal(override.line, lineOf(overrideSource, 'amount = fields.Monetary'));
  });

  test('pymodel: the field row carries the same definers with effective', () => {
    // Gap: the model explorer only knew the effective declaration.
    const result = runIn(trees.fields, 'pymodel', 'acme.thing');
    assert.equal(result.status, 0, result.stderr);
    const field = result.json.fields.find((row) => row.name === 'amount');
    assert.equal(field.definitions, 2);
    assert.deepEqual(field.definers.map((row) => row.module), ['acme_a', 'acme_b']);
    assert.equal(field.definers.filter((row) => row.effective === true).length, 1);
    assert.equal(field.definers.find((row) => row.effective === true).module, 'acme_b');
    assert.equal(field.module, 'acme_b');
    assert.equal(field.definers[0].attrs.string, 'Amount A');
    assert.equal(field.definers[1].attrs.string, 'Amount B');
  });
});

describe('G4 — relational sanity checks', () => {
  test('an inverse pointing at another model is inverse-target-mismatch, also in warnings', () => {
    // Gap: `field` printed a silently-empty One2many as if it were healthy.
    const result = runIn(trees.relation, 'field', 'acme.thing', 'line_bad_ids');
    assert.equal(result.status, 0, result.stderr);
    const relation = result.json.relation;
    assert.equal(relation.ok, false);
    assert.equal(relation.comodel.defined, true);
    assert.equal(relation.comodel.model, 'acme.line');
    assert.equal(relation.inverse.name, 'thing_id');
    assert.equal(relation.inverse.found, true);
    assert.equal(relation.inverse.comodel, 'res.currency');
    const issue = relation.issues.find((row) => row.code === 'inverse-target-mismatch');
    assert.ok(issue, JSON.stringify(relation.issues));
    assert.equal(issue.message, 'inverse field acme.line.thing_id targets res.currency, expected acme.thing');
    // Existing CLI consumers read `warnings`, so the issue text must reach them too.
    assert.ok(result.json.warnings.includes(`inverse-target-mismatch: ${issue.message}`), result.json.warnings.join('\n'));
  });

  test('a matching inverse is ok with no issues', () => {
    // Positive control: a correct One2many must stay quiet, never warn.
    const result = runIn(trees.relation, 'field', 'acme.thing', 'line_ok_ids');
    assert.equal(result.status, 0, result.stderr);
    const relation = result.json.relation;
    assert.equal(relation.ok, true);
    assert.deepEqual(relation.issues, []);
    assert.equal(relation.inverse.name, 'owner_id');
    assert.equal(relation.inverse.comodel, 'acme.thing');
  });

  test('missing inverse and a nonexistent inverse field are reported distinctly', () => {
    // Gap: both looked like a healthy field; they now get different issue codes.
    const missing = runIn(trees.relation, 'field', 'acme.thing', 'line_no_inv_ids').json;
    assert.equal(missing.relation.ok, false);
    assert.ok(missing.relation.issues.some((row) => row.code === 'missing-inverse'), JSON.stringify(missing.relation.issues));
    const absent = runIn(trees.relation, 'field', 'acme.thing', 'line_missing_ids').json;
    assert.equal(absent.relation.ok, false);
    assert.ok(absent.relation.issues.some((row) => row.code === 'inverse-field-missing'), JSON.stringify(absent.relation.issues));
  });
});

describe('G3 — callers finds python, view and server-action call sites', () => {
  test('call sites carry their kind, tag and absolute line', () => {
    // Gap: python callers, XML buttons/<function> and server-action code bodies
    // all had to be grepped separately, and arch-relative lines pointed nowhere.
    const result = runIn(trees.callers, 'callers', 'acme.thing', 'action_go');
    assert.equal(result.status, 0, result.stderr);
    const { items, counts, total, truncated } = result.json;
    const xml = readFileSync(join(trees.callers, 'acme_c', 'views', 'calls.xml'), 'utf8');
    const py = readFileSync(join(trees.callers, 'acme_c', 'models', 'calls.py'), 'utf8');

    assert.deepEqual(
      items.filter((row) => row.kind === 'view').map((row) => row.xmlId).sort(),
      ['acme_c.view_function', 'acme_c.view_object'],
    );
    assert.ok(!items.some((row) => row.xmlId === 'acme_c.view_action_type'), 'type="action" is not a Python call');
    const button = items.find((row) => row.kind === 'view' && row.tag === 'button');
    assert.equal(button.line, lineOf(xml, 'type="object"'));
    assert.ok(button.line > lineOf(xml, 'record id="view_object"'), 'line is absolute, not arch-relative');
    const fn = items.find((row) => row.kind === 'view' && row.tag === 'function');
    assert.equal(fn.line, lineOf(xml, '<function name="action_go"/>'));
    assert.ok(fn.line > lineOf(xml, 'record id="view_function"'));

    const server = items.find((row) => row.kind === 'server-action');
    assert.equal(server.xmlId, 'acme_c.sa_go');
    assert.equal(server.module, 'acme_c');
    assert.equal(server.file, 'acme_c/views/calls.xml');

    const named = items.find((row) => row.kind === 'python' && row.receiver === "self.env['acme.thing']");
    assert.equal(named.certain, true, 'the quoted model pins the call');
    assert.equal(named.line, lineOf(py, "self.env['acme.thing'].action_go()"));
    const local = items.find((row) => row.kind === 'python' && row.receiver === 'service');
    assert.equal(local.certain, false, 'a local receiver cannot be resolved, but the call is kept');
    assert.equal(local.line, lineOf(py, 'service.action_go()'));

    assert.equal(counts.python + counts.views + counts.serverActions, items.length);
    assert.equal(total, items.length, 'no truncation under the default limit of 100');
    assert.equal(truncated, false);
  });

  test('brief form exits 0 and lists each kind', () => {
    // Gap: the token-cheap form must cover the new command (and never fail).
    const result = runIn(trees.callers, 'callers', 'acme.thing', 'action_go', '--format', 'brief');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^acme\.thing\.action_go\s+2 python/);
    assert.match(result.stdout, /2 views\s+1 server action/);
    assert.match(result.stdout, /view\tacme_c\.view_object\tbutton\t/);
    assert.match(result.stdout, /action\tacme_c\.sa_go\t/);
  });
});

describe('G5 — duplicate-logic detection', () => {
  test('near-identical bodies in two modules cluster; unrelated and short methods stay out', () => {
    // Gap: no way to find copied method bodies; the score must survive a renamed
    // literal, a comment and a docstring, and must not cluster unrelated code.
    const result = runIn(trees.dupes, 'dupes');
    assert.equal(result.status, 0, result.stderr);
    const { clusters, compared } = result.json;
    const pair = clusters.find((cluster) => cluster.modules.includes('acme_d_a') && cluster.modules.includes('acme_d_b'));
    assert.ok(pair, JSON.stringify(clusters));
    assert.equal(pair.size, 2);
    assert.ok(pair.score >= 0.75, `score ${pair.score}`);
    assert.deepEqual(
      pair.methods.map((method) => `${method.model}.${method.name}`).sort(),
      ['acme.mro.request._issue_materials', 'acme.thing._issue_materials'],
    );
    const names = clusters.flatMap((cluster) => cluster.methods.map((method) => method.name));
    assert.ok(!names.includes('_unrelated'), 'an unrelated body is not a duplicate');
    assert.ok(!names.includes('tiny'), 'a 3-line body is below minLines/minTokens');
    // 2 twins + the unrelated body + the hidden pair = 5 comparable methods; the
    // 3-line `tiny` was dropped before comparison.
    assert.equal(compared, 5);
  });

  test('similar returns the identical twin above the threshold', () => {
    // Gap: `similar` had to report what `dupes` would cluster.
    const result = runIn(trees.dupes, 'similar', 'acme.thing._issue_materials');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.total, 1);
    const match = result.json.matches[0];
    assert.equal(match.model, 'acme.mro.request');
    assert.equal(match.name, '_issue_materials');
    assert.ok(match.score >= 0.75, `score ${match.score}`);
  });

  test('dupes --model keeps a cross-model cluster and warns about the hidden ones', () => {
    // Gap: --model used to hide cross-model copies, which are the interesting
    // ones; it must filter the report only and say what it hid.
    const result = runIn(trees.dupes, 'dupes', '--model', 'acme.thing');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.total, 1);
    assert.equal(result.json.clusters.length, 1);
    assert.deepEqual(result.json.clusters[0].models, ['acme.mro.request', 'acme.thing']);
    assert.ok(
      result.json.warnings.some((warning) => /1 cluster\(s\) without a acme\.thing method were hidden/.test(warning)),
      result.json.warnings.join('\n'),
    );
  });

  test('dupes --format brief exits 0 and prints the cluster', () => {
    // Gap: the new command needs a one-screen form for scripts and humans.
    const result = runIn(trees.dupes, 'dupes', '--format', 'brief');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^dupes\s+1\.00\s+2 methods/m);
    assert.match(result.stdout, /acme\.thing\._issue_materials\t/);
  });
});

describe('G2 — install-state awareness', () => {
  test('a known module list annotates search and modelflows rows true/false', async () => {
    // Gap: the index is built from source, so an uninstalled module looked live.
    const engine = createEngine({ roots: [trees.install], installedModules: ['acme_a'] });
    const search = await engine.read('search', { q: 'acme.thing' });
    const hits = new Map(search.items.map((row) => [row.xmlId, row.installed]));
    assert.equal(hits.get('acme_a.view_a'), true);
    assert.equal(hits.get('acme_b.view_b'), false);
    const flows = await engine.read('modelflows', { model: 'acme.thing', field: 'qty' });
    const definers = new Map(flows.definition.definers.map((row) => [row.module, row.installed]));
    assert.equal(definers.get('acme_a'), true);
    assert.equal(definers.get('acme_b'), false);
    assert.equal(flows.definition.definers.filter((row) => row.effective === true).length, 1);
  });

  test('onlyInstalled=1 drops the uninstalled rows and reports how many', async () => {
    const engine = createEngine({ roots: [trees.install], installedModules: ['acme_a'] });
    const search = await engine.read('search', { q: 'acme.thing', onlyInstalled: '1' });
    assert.deepEqual(search.items.map((row) => row.xmlId), ['acme_a.view_a']);
    assert.ok(search.filtered >= 1, `filtered ${search.filtered}`);
    assert.equal(search.total, 2, 'total stays the unfiltered match count');
    const flows = await engine.read('modelflows', { model: 'acme.thing', field: 'qty', onlyInstalled: '1' });
    assert.deepEqual(flows.definition.definers.map((row) => row.module), ['acme_a']);
    assert.ok(flows.filtered >= 1, `filtered ${flows.filtered}`);
  });

  test('without a module list every row is null and onlyInstalled warns', async () => {
    const engine = createEngine({ roots: [trees.install] });
    const search = await engine.read('search', { q: 'acme.thing' });
    assert.deepEqual([...new Set(search.items.map((row) => row.installed))], [null]);
    const flows = await engine.read('modelflows', { model: 'acme.thing', field: 'qty', onlyInstalled: '1' });
    assert.deepEqual([...new Set(flows.definition.definers.map((row) => row.installed))], [null]);
    assert.deepEqual(flows.definition.definers.map((row) => row.module), ['acme_a', 'acme_b'], 'unknown is not evidence of absence');
    assert.equal(flows.filtered, 0);
    assert.ok(flows.warnings.some((warning) => warning.includes('install state unknown')), flows.warnings.join('\n'));
  });
});

describe('G6/G7 — brief grouping, module filtering and --db', () => {
  test('pymodel brief groups fields/methods by module and says how many rows it cut', () => {
    // Gap: 75 fields in one flat list, truncated with a bare "…", never saying
    // which module adds what.
    const grouped = runIn(trees.fields, 'pymodel', 'acme.thing', '--format', 'brief');
    assert.equal(grouped.status, 0, grouped.stderr);
    assert.match(grouped.stdout, /^acme\.thing\s+8 fields\s+3 methods/m);
    assert.match(grouped.stdout, /fields by module:/);
    assert.match(grouped.stdout, /methods by module:/);
    assert.match(grouped.stdout, /^\s+acme_a \(3\): alpha, beta, gamma$/m);
    assert.match(grouped.stdout, /^\s+acme_b \(4\): amount\*, delta, epsilon, qty\*$/m);
    assert.match(grouped.stdout, /^\* defined in more than one module: amount \(acme_b, acme_a\)/m);

    const limited = runIn(trees.fields, 'pymodel', 'acme.thing', '--format', 'brief', '--limit', '2');
    assert.equal(limited.status, 0, limited.stderr);
    assert.match(limited.stdout, /… \d+ more \(raise --limit or narrow with --module\)/);
    assert.doesNotMatch(limited.stdout, /…\s*$/m, 'never a bare ellipsis');
  });

  test('pymodel --module keeps only matching module groups', () => {
    // Gap: a module could not narrow the list, so one noisy module buried the rest.
    const result = runIn(trees.fields, 'pymodel', 'acme.thing', '--module', 'acme_*', '--format', 'brief');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /module acme_\*/);
    assert.match(result.stdout, /^\s+acme_a \(\d+\): /m);
    assert.match(result.stdout, /^\s+acme_b \(\d+\): /m);
    assert.doesNotMatch(result.stdout, /zeta_mod/, 'a module outside the glob is filtered out');
    assert.doesNotMatch(result.stdout, /action_zeta/);

    const one = runIn(trees.fields, 'pymodel', 'acme.thing', '--module', 'acme_a', '--format', 'brief');
    assert.equal(one.status, 0, one.stderr);
    assert.doesNotMatch(one.stdout, /delta/);
    assert.match(one.stdout, /amount\*/, 'a field defined in the module through any definer is kept');
  });

  test('field brief lists every definer with its effective marker', () => {
    // Gap: `field` brief showed the effective definition only, not the overrides.
    const result = runIn(trees.fields, 'field', 'acme.thing', 'amount', '--format', 'brief');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /definers \(2\):/);
    const rows = result.stdout.split('\n').filter((line) => /^\s+acme_[ab]\t/.test(line));
    assert.equal(rows.length, 2, result.stdout);
    const start = rows.find((line) => /^\s+acme_a\t/.test(line));
    const override = rows.find((line) => /^\s+acme_b\t/.test(line));
    assert.match(start, /string=Amount A/);
    assert.doesNotMatch(start, /effective/);
    assert.match(override, /string=Amount B help=second/);
    assert.match(override, /effective$/);
  });

  test('--installed is the happy path and a failing --db is a warning, never exit 1', () => {
    const installedFile = join(base, 'installed.txt');
    writeFileSync(installedFile, 'acme_a\n# comment\n\nzeta_mod\n');
    const happy = runIn(trees.fields, 'field', 'acme.thing', 'amount', '--installed', installedFile);
    assert.equal(happy.status, 0, happy.stderr);
    assert.equal(happy.json.installed.source, 'file');
    assert.equal(happy.json.installed.db, null);
    assert.equal(happy.json.installed.count, 2, 'comments and blank lines are not modules');
    assert.equal(happy.json.installed.error, null);
    const definers = new Map(happy.json.definition.definers.map((row) => [row.module, row.installed]));
    assert.equal(definers.get('acme_a'), true);
    assert.equal(definers.get('acme_b'), false);

    // psql is replaced by /bin/false: the run still answers from source and
    // reports the failure in `installed.error` + a warning (exit 0, not 1).
    const failing = spawnSync(
      process.execPath,
      [CLI, '--addons', trees.fields, '--base', trees.fields, 'field', 'acme.thing', 'amount', '--db', 'nope'],
      { encoding: 'utf8', env: cliEnv({ ODOO_DC_PSQL: '/bin/false' }) },
    );
    assert.equal(failing.status, 0, failing.stderr);
    const payload = JSON.parse(failing.stdout);
    assert.equal(payload.installed.source, 'db');
    assert.equal(payload.installed.db, 'nope');
    assert.match(payload.installed.error, /psql -d nope failed/);
    assert.ok(payload.warnings.some((warning) => String(warning).includes('install state unavailable')), payload.warnings.join('\n'));
    assert.equal(failing.stderr, '');
  });
});

describe('G8 — the odoo-dc shim is discoverable', () => {
  test('the shim is executable and runs from an empty directory', (t) => {
    // Gap: the binary was not on PATH and no CLAUDE.md named it.
    if (!existsSync(SHIM)) {
      t.skip('shim not installed');
      return;
    }
    assert.notEqual(statSync(SHIM).mode & 0o111, 0, 'the shim is executable');
    const cwd = mkdtempSync(join(tmpdir(), 'odoo-dc-shim-'));
    try {
      const result = spawnSync(SHIM, ['roots', '--format', 'compact'], { encoding: 'utf8', cwd, env: cliEnv() });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Array.isArray(JSON.parse(result.stdout).roots));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('Search — the workspace is the scope, not one addons directory', () => {
  test('a search with no --root merges every root of the workspace and tags each hit', () => {
    // Gap: the browse search sent one root, so a non-empty custom result hid the
    // core hit (the CLI only fell back when the first root returned nothing).
    const result = runWorkspace([trees.searchCustom, trees.searchCore], 'search', 'res.partner form');
    assert.equal(result.status, 0, result.stderr);
    const payload = result.json;
    assert.equal(payload.scope.mode, 'workspace');
    assert.equal(payload.scope.roots.length, 2);
    const xmlIds = payload.items.map((item) => item.xmlId);
    assert.ok(xmlIds.includes('acme_shop.view_partner_form_shop'), xmlIds.join(','));
    assert.ok(xmlIds.includes('core_partner.view_partner_form_core'), xmlIds.join(','));
    for (const item of payload.items) {
      assert.ok(typeof item.rootId === 'string' && item.rootId.length > 0, 'every hit names its root');
      assert.ok(typeof item.rootLabel === 'string' && item.rootLabel.length > 0, 'every hit carries its root label');
    }
    assert.ok(payload.total >= 2, String(payload.total));
  });

  test('--root pins one addons directory and leaves the scope out', () => {
    const pinned = runWorkspace([trees.searchCustom, trees.searchCore], 'search', 'res.partner form', '--root', 'search-custom');
    assert.equal(pinned.status, 0, pinned.stderr);
    const payload = pinned.json;
    assert.equal(payload.scope, undefined);
    assert.deepEqual(payload.items.map((item) => item.xmlId), ['acme_shop.view_partner_form_shop']);
  });

  test('brief rows carry the root badge of the hit', () => {
    const brief = runWorkspace([trees.searchCustom, trees.searchCore], 'search', 'res.partner form', '--format', 'brief');
    assert.equal(brief.status, 0, brief.stderr);
    const lines = brief.stdout.trim().split('\n');
    assert.ok(lines.some((line) => line.includes('acme_shop.view_partner_form_shop') && line.endsWith('\tsearch-custom')), brief.stdout);
    assert.ok(lines.some((line) => line.includes('core_partner.view_partner_form_core') && line.endsWith('\tsearch-core')), brief.stdout);
  });

  test('window actions use the same workspace scope', () => {
    module(trees.searchCustom, 'acme_shop', {
      'views/actions.xml': `<odoo><record id="action_shop_partner" model="ir.actions.act_window">
    <field name="name">Shop Partners</field>
    <field name="res_model">res.partner</field>
    <field name="view_mode">form</field>
</record></odoo>
`,
    }, ['base']);
    const result = runWorkspace([trees.searchCustom, trees.searchCore], 'actions', 'Partners');
    assert.equal(result.status, 0, result.stderr);
    const payload = result.json;
    assert.equal(payload.scope.mode, 'workspace');
    assert.ok(payload.items.some((item) => item.xmlId === 'acme_shop.action_shop_partner'), JSON.stringify(payload.items));
    for (const item of payload.items) assert.ok(typeof item.rootLabel === 'string' && item.rootLabel.length > 0);
  });
});

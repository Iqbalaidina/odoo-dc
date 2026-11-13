/**
 * CLI checks: runs cli/odoo-dc.mjs as a child process against a throwaway
 * addons tree. Covers output shape, exit codes, that lookup commands never write,
 * and that the builder commands write only with --apply.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'odoo-dc.mjs');
let base;
let addons;
let coreAddons;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'odoo-dc-cli-'));
  addons = join(base, 'custom-addons');
  mkdirSync(join(addons, 'acme', 'views'), { recursive: true });
  writeFileSync(join(addons, 'acme', '__manifest__.py'), "{'name': 'Acme', 'depends': []}\n");
  mkdirSync(join(addons, 'acme', 'models'), { recursive: true });
  writeFileSync(join(addons, 'acme', 'models', 'thing.py'), `from odoo import models, fields, api


class Thing(models.Model):
    _name = 'acme.thing'
    _description = 'Thing'

    amount = fields.Float(string='Amount')
    total = fields.Float(compute='_compute_total')

    @api.depends('amount')
    def _compute_total(self):
        for rec in self:
            rec.total = rec.amount * 2

    def action_reset(self):
        self.amount = 0
`);
  writeFileSync(join(addons, 'acme', 'views', 'thing.xml'), `<odoo>
  <record id="thing_form" model="ir.ui.view"><field name="name">thing.form</field><field name="model">acme.thing</field>
    <field name="arch" type="xml"><form><field name="amount"/><field name="total"/></form></field></record>
  <record id="action_thing" model="ir.actions.act_window"><field name="name">Things</field>
    <field name="res_model">acme.thing</field><field name="view_mode">form</field>
    <field name="view_id" ref="acme.thing_form"/></record>
</odoo>\n`);
  coreAddons = join(base, 'core-addons');
  mkdirSync(join(coreAddons, 'coremod', 'views'), { recursive: true });
  writeFileSync(join(coreAddons, 'coremod', '__manifest__.py'), "{'name': 'Core', 'depends': []}\n");
  writeFileSync(join(coreAddons, 'coremod', 'views', 'c.xml'), `<odoo>
  <record id="core_form" model="ir.ui.view"><field name="name">c.form</field><field name="model">res.partner</field>
    <field name="arch" type="xml"><form><sheet><field name="name"/></sheet></form></field></record>
  <record id="core_form_ext" model="ir.ui.view"><field name="name">c.form.ext</field><field name="model">res.partner</field>
    <field name="inherit_id" ref="coremod.core_form"/>
    <field name="arch" type="xml"><xpath expr="//field[@name='name']" position="after"><field name="ref"/></xpath></field></record>
</odoo>\n`);
  writeFileSync(join(addons, 'acme', 'views', 'v.xml'), `<odoo>
  <record id="form" model="ir.ui.view"><field name="name">a.form</field><field name="model">res.partner</field>
    <field name="arch" type="xml"><form><sheet><field name="name"/></sheet></form></field></record>
  <record id="form_x" model="ir.ui.view"><field name="name">a.form.x</field><field name="model">res.partner</field>
    <field name="inherit_id" ref="acme.form"/>
    <field name="arch" type="xml"><xpath expr="//field[@name='name']" position="after"><field name="vat"/></xpath></field></record>
</odoo>\n`);
});
after(() => rmSync(base, { recursive: true, force: true }));

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, '--addons', addons, '--addons', coreAddons, '--base', base, ...args], { encoding: 'utf8', env: { ...process.env, ODOO_DC_CACHE: '0' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('roots lists the explicit addons root', () => {
  const r = run('roots');
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).roots[0].path, addons);
});

test('view returns one slim view with its source', () => {
  const r = run('view', 'acme.form');
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.view.xmlId, 'acme.form');
  assert.match(j.view.source, /<form>/);
  assert.equal(j.view.preview, undefined);
  assert.equal(j.view.arch, undefined);
});

test('compose emits merged XML including the inheritor patch', () => {
  const j = JSON.parse(run('compose', 'acme.form_x').out);
  assert.match(j.composedXml, /<field name="name"\/>\s*<!-- contributed by the selected view -->\s*<field name="vat"\/>/);
  assert.equal(j.composed, undefined);
});

test('errors: unknown view exits 3, bad usage exits 2, both JSON on stderr', () => {
  const missing = run('view', 'acme.nope');
  assert.equal(missing.code, 3);
  assert.equal(JSON.parse(missing.err).error, 'unknown-view');
  const bad = run('bogus');
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.err).error, 'usage');
});

test('read-only: save is not a command and POST-only actions are refused', () => {
  assert.equal(run('save').code, 2);
  const r = run('get', 'action=save');
  assert.notEqual(r.code, 0);
  const before = readFileSync(join(addons, 'acme', 'views', 'v.xml'), 'utf8');
  run('get', 'action=folders');
  assert.equal(readFileSync(join(addons, 'acme', 'views', 'v.xml'), 'utf8'), before);
});

test('root fallback: id from the second root is found without --root, pinned root refuses it', () => {
  const found = JSON.parse(run('view', 'coremod.core_form').out);
  assert.match(found.root, /core-addons/);
  const pinned = run('view', 'coremod.core_form', '--root', 'custom-addons');
  assert.equal(pinned.code, 3);
  assert.equal(JSON.parse(pinned.err).error, 'unknown-view');
  const none = run('view', 'zzz.nope');
  assert.match(JSON.parse(none.err).message, /roots tried: .*custom-addons.*core-addons/);
});

test('a root that matches nothing lists the real roots', () => {
  const r = run('view', 'acme.form', '--root', 'acme');
  assert.equal(r.code, 1);
  const e = JSON.parse(r.err);
  assert.equal(e.error, 'no-root');
  assert.match(e.message, /module folder is not a root/);
});

test('impact: inheritors, actions and fields in one report', () => {
  const j = JSON.parse(run('impact', 'acme.form').out);
  assert.deepEqual(j.directInheritors, ['acme.form_x']);
  assert.deepEqual(j.allInheritors.map((v) => v.xmlId), ['acme.form_x']);
  assert.ok(j.fields.includes('name'));
  const thing = JSON.parse(run('impact', 'acme.thing_form').out);
  assert.deepEqual(thing.actions.map((a) => a.xmlId), ['acme.action_thing']);
});

test('field: definition, views and read/write/depends methods', () => {
  const j = JSON.parse(run('field', 'acme.thing', 'amount').out);
  assert.equal(j.definition.fieldType, 'Float');
  assert.deepEqual(j.views.map((v) => v.xmlId), ['acme.thing_form']);
  const roles = Object.fromEntries(j.methods.map((m) => [m.name, m.roles]));
  assert.ok(roles._compute_total.includes('depends'), 'a @depends field is reported');
  assert.deepEqual(roles.action_reset, ['write']);
  assert.equal(JSON.parse(run('field', 'acme.thing', 'total').out).computeMethod, '_compute_total');
  const bad = run('field', 'acme.thing', 'nope');
  assert.equal(bad.code, 3);
  assert.equal(JSON.parse(bad.err).error, 'unknown-field');
});

test('--format brief gives one line per hit and rejects unknown formats', () => {
  const r = run('search', 'res.partner form', '--format', 'brief');
  assert.equal(r.code, 0);
  assert.ok(r.out.trim().split('\n').every((l) => l.split('\t').length === 4), r.out);
  assert.equal(run('search', 'x', '--format', 'xml').code, 2);
});

test('extension view types resolve across roots when searching one root', () => {
  const j = JSON.parse(run('search', 'coremod.core_form_ext', '--root', 'core-addons').out);
  assert.equal(j.items.find((v) => v.xmlId === 'coremod.core_form_ext').type, 'form');
});

test('get refuses non-read actions with exit 2', () => {
  for (const action of ['save', 'folders', 'bogus']) assert.equal(run('get', `action=${action}`).code, 2);
  assert.equal(run('get', 'action=roots').code, 0);
});

test('access commands: search, group, acl and gate traces (read-only, json and brief)', () => {
  mkdirSync(join(addons, 'acme', 'security'), { recursive: true });
  writeFileSync(join(addons, 'acme', 'security', 'ir.model.access.csv'),
    'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\n'
    + 'a_user,u,model_acme_thing,group_user,1,0,0,0\na_mgr,m,model_acme_thing,group_mgr,1,1,1,1\n');
  writeFileSync(join(addons, 'acme', 'security', 'security.xml'), `<odoo>
  <record id="group_user" model="res.groups"><field name="name">Thing User</field></record>
  <record id="group_mgr" model="res.groups"><field name="name">Thing Manager</field>
    <field name="implied_ids" eval="[(4, ref('group_user'))]"/></record>
  <menuitem id="menu_thing" name="Things" action="action_thing" groups="acme.group_mgr"/>
</odoo>\n`);
  const before = readFileSync(join(addons, 'acme', 'security', 'security.xml'), 'utf8');

  const search = JSON.parse(run('access', 'thing', '--type', 'group').out);
  assert.deepEqual(search.items.map((i) => i.id), ['acme.group_mgr', 'acme.group_user']);

  const group = JSON.parse(run('group', 'group_mgr').out);
  assert.deepEqual(group.includes.map((g) => g.xmlId), ['acme.group_user']);
  assert.ok(group.gates.some((g) => g.owner === 'acme.menu_thing'));

  const acl = JSON.parse(run('acl', 'acme.thing').out);
  assert.equal(acl.groups.length, 2);
  assert.ok(acl.used.some((u) => u.xmlId === 'acme.action_thing'));
  assert.deepEqual(acl.fieldGroups, []);

  const gate = run('gate', 'menu_thing', '--format', 'brief');
  assert.equal(gate.code, 0);
  assert.match(gate.out, /acme\.group_mgr\s+RWCD/);

  const briefGroup = run('group', 'acme.group_user', '--format', 'brief');
  assert.match(briefGroup.out, /included by \(1\): acme\.group_mgr/);
  assert.match(run('acl', 'acme.thing', '--format', 'brief').out, /acme\.group_user\s+R---/);

  const missing = run('group', 'acme.nope');
  assert.equal(missing.code, 3);
  assert.equal(JSON.parse(missing.err).error, 'unknown-group');
  assert.equal(run('group').code, 2);
  assert.equal(readFileSync(join(addons, 'acme', 'security', 'security.xml'), 'utf8'), before, 'read-only');
});

// ---- 2026-11-13 improvement pass: batch projection, external writers, filters, type chains.

test('192. batch: per-item fields, meta:false, schema contract and unknown-key hint', () => {
  const schema = JSON.parse(run('batch', '--schema').out);
  assert.equal(schema.readOnly, true);
  assert.match(schema.itemKeys.xmlId, /view/);
  const file = join(base, 'batch-projection.json');
  writeFileSync(file, JSON.stringify([
    { id: 'f', action: 'field', model: 'acme.thing', field: 'amount', fields: 'methods' },
    { id: 'p', action: 'pymodel', model: 'acme.thing', meta: false },
    { id: 'bad', action: 'view', view: 'acme.form' },
  ]));
  const r = run('batch', '--file', file, '--no-meta');
  assert.equal(r.code, 1, 'one failed item sets exit 1');
  const lines = r.out.trim().split('\n').map((line) => JSON.parse(line));
  const byId = Object.fromEntries(lines.map((line) => [line.id, line]));
  assert.deepEqual(Object.keys(byId.f.result).sort(), ['methods', 'schemaVersion'], 'fields projects the line');
  assert.equal(byId.p.result.stats, undefined, 'meta:false drops the global stats block');
  assert.equal(byId.bad.error.code, 'unknown-item-key');
  assert.match(byId.bad.error.message, /xmlId/);
  assert.deepEqual(JSON.parse(r.err.trim()), { failed: 1, total: 3 });
});

test('193. --fields projects a single command and --no-meta drops global blocks', () => {
  const projected = JSON.parse(run('group', 'group_mgr', '--fields', 'group').out);
  assert.deepEqual(Object.keys(projected).sort(), ['group', 'schemaVersion']);
  const stripped = JSON.parse(run('group', 'group_mgr', '--no-meta').out);
  assert.equal(stripped.stats, undefined);
  assert.ok(stripped.includes.length > 0, 'the answer itself stays');
});

test('194. pymodel --format brief lists fields and methods grouped by module', () => {
  const r = run('pymodel', 'acme.thing', '--format', 'brief');
  assert.equal(r.code, 0);
  assert.match(r.out, /^acme\.thing\s+\d+ fields/);
  // G7: the brief groups by defining module instead of one flat list.
  assert.match(r.out, /fields by module:/);
  assert.match(r.out, /methods by module:/);
  assert.match(r.out, /acme \(\d+\): .*action_reset/);
});

test('195. field reports writers from other models (externalWriters)', () => {
  mkdirSync(join(addons, 'acme', 'models'), { recursive: true });
  writeFileSync(join(addons, 'acme', 'models', 'usage.py'), `from odoo import models, fields


class Usage(models.Model):
    _name = 'acme.usage'
    _description = 'Usage'

    thing_id = fields.Many2one('acme.thing', string='Thing')

    def _bump(self):
        self.thing_id.write({'amount': 1})
`);
  const j = JSON.parse(run('field', 'acme.thing', 'amount').out);
  const external = j.externalWriters.find((row) => row.model === 'acme.usage');
  assert.ok(external, 'writer through the relation field is reported');
  assert.equal(external.method, '_bump');
  assert.ok(external.roles.includes('write'));
  assert.ok(j.warnings.some((warning) => /externalWriters/.test(warning)));
});

test('196. acl filters keep only matching rows', () => {
  const writeOnly = JSON.parse(run('acl', 'acme.thing', '--perm', 'w').out);
  assert.deepEqual(writeOnly.groups.map((g) => g.group), ['acme.group_mgr']);
  assert.deepEqual(writeOnly.filters, { group: null, grantedTo: null, perm: 'w' });
  const granted = JSON.parse(run('acl', 'acme.thing', '--granted-to', 'group_mgr').out);
  assert.deepEqual(granted.groups.map((g) => g.group), ['acme.group_mgr', 'acme.group_user']);
  const one = JSON.parse(run('acl', 'acme.thing', '--group', 'group_user').out);
  assert.deepEqual(one.groups.map((g) => g.group), ['acme.group_user']);
  const brief = run('acl', 'acme.thing', '--group', 'group_user', '--format', 'brief');
  assert.match(brief.out, /also \(1\): acme\.group_mgr/);
});

test('197. group models carry via provenance (direct and implied)', () => {
  const j = JSON.parse(run('group', 'group_mgr').out);
  const thing = j.models.find((row) => row.model === 'acme.thing');
  assert.ok(thing.via.some((entry) => entry.group === 'acme.group_mgr' && entry.direct === true));
  assert.ok(thing.via.some((entry) => entry.group === 'acme.group_user' && entry.direct === false));
  assert.match(run('group', 'group_mgr', '--format', 'brief').out, /via acme\.group_user/);
});

test('198. extension view type resolves through a chain of extensions', () => {
  writeFileSync(join(addons, 'acme', 'views', 'chain.xml'), `<odoo>
  <record id="form_x2" model="ir.ui.view"><field name="name">a.form.x2</field><field name="model">res.partner</field>
    <field name="inherit_id" ref="acme.form_x"/>
    <field name="arch" type="xml"><xpath expr="//field[@name='name']" position="after"><field name="phone"/></xpath></field></record>
</odoo>\n`);
  const j = JSON.parse(run('view', 'acme.form_x2').out);
  assert.equal(j.view.type, 'form');
  assert.equal(j.view.typeResolved, true);
  const impact = JSON.parse(run('impact', 'acme.form').out);
  assert.equal(impact.transitive, true);
  assert.ok(impact.allInheritors.some((v) => v.xmlId === 'acme.form_x2'));
});

// ---- Builder (the only writing commands): dry-run by default, --apply writes, never overwrites.

function runIn(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, '--addons', root, '--base', base, '--odoo-version', '15', ...args], { encoding: 'utf8', env: { ...process.env, ODOO_DC_CACHE: '0' } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

test('builder: module new / model new / view new / access add, dry-run then --apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'odoo-dc-build-'));
  try {
    const dry = runIn(root, 'module', 'new', 'library', '--into', root, '--depends', 'base,mail');
    assert.equal(dry.code, 0, dry.err);
    assert.equal(dry.json().mode, 'dry-run');
    assert.deepEqual(dry.json().files.map((f) => `${f.op} ${f.path}`), ['create library/__init__.py', 'create library/__manifest__.py']);
    assert.throws(() => readFileSync(join(root, 'library', '__manifest__.py')), /ENOENT/, 'dry-run writes nothing');

    assert.equal(runIn(root, 'module', 'new', 'library', '--into', root, '--apply').code, 0);
    assert.match(readFileSync(join(root, 'library', '__manifest__.py'), 'utf8'), /'version': '15\.0\.1\.0\.0'/);
    const again = runIn(root, 'module', 'new', 'library', '--into', root, '--apply');
    assert.equal(again.code, 1);
    assert.equal(JSON.parse(again.err).error, 'plan-failed');
    assert.ok(JSON.parse(again.err).errors.every((e) => e.code === 'file-exists'));

    const model = runIn(root, 'model', 'new', 'library', 'library.book', '--field', 'name:char:required', '--field', 'state:selection:draft=Draft|done=Done',
      '--menu', 'Books', '--access', 'base.group_user:rwc-', '--apply', '--format', 'brief');
    assert.equal(model.code, 0, model.err);
    assert.match(model.out, /^applied {2}library {2}Odoo 15 \(--odoo-version\)/);
    assert.match(model.out, /patch {3}library\/__manifest__\.py/);
    assert.match(readFileSync(join(root, 'library', 'models', 'library_book.py'), 'utf8'), /_name = 'library\.book'/);
    assert.match(readFileSync(join(root, 'library', 'views', 'library_book_views.xml'), 'utf8'), /<tree>[\s\S]*<menuitem id="library_book_menu"/);
    assert.match(readFileSync(join(root, 'library', 'security', 'ir.model.access.csv'), 'utf8'), /model_library_book,base\.group_user,1,1,1,0/);
    assert.match(readFileSync(join(root, 'library', '__manifest__.py.bak'), 'utf8'), /'data': \[\n {4}\],/, '.bak keeps the previous manifest');

    // The module is now found without --into; the model exists in the fresh index, so a second model new refuses.
    const dup = runIn(root, 'model', 'new', 'library', 'library.book', '--field', 'name:char');
    assert.equal(dup.code, 1);
    assert.match(JSON.parse(dup.err).message, /model-exists|file-exists/);

    const view = runIn(root, 'view', 'new', 'library', 'library.book', '--type', 'form');
    assert.equal(view.code, 1, 'form view id already exists');
    assert.match(JSON.parse(view.err).message, /duplicate-xml-id: xml id library\.library_book_view_form/);

    const ext = runIn(root, 'view', 'new', 'library', '--inherit', 'library.library_book_view_form', '--expr', '//form', '--fields', 'name', '--apply');
    assert.equal(ext.code, 0, ext.err);
    const extText = readFileSync(join(root, 'library', 'views', 'library_library_book_view_form_inherit.xml'), 'utf8');
    assert.match(extText, /inherit_id" ref="library\.library_book_view_form"/);
    assert.match(extText, /<xpath expr="\/\/form" position="inside">/);
    assert.match(extText, /<field name="name"\/>/);
    assert.match(readFileSync(join(root, 'library', '__manifest__.py'), 'utf8'), /views\/library_library_book_view_form_inherit\.xml/);

    const acl = runIn(root, 'access', 'add', 'library', 'library.book', '-', 'r---', '--apply');
    assert.equal(acl.code, 0, acl.err);
    assert.match(readFileSync(join(root, 'library', 'security', 'ir.model.access.csv'), 'utf8'), /access_library_book_all,library\.book all,model_library_book,,1,0,0,0\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('builder: refuses core roots, unknown modules, existing models and bad tokens', () => {
  const core = mkdtempSync(join(tmpdir(), 'odoo-dc-core-'));
  const coreRoot = join(core, 'odoo', 'addons');
  mkdirSync(join(coreRoot, 'base_x'), { recursive: true });
  writeFileSync(join(coreRoot, 'base_x', '__manifest__.py'), "{'name': 'x'}\n");
  try {
    const refused = runIn(coreRoot, 'module', 'new', 'zz', '--into', coreRoot);
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.err).error, 'core-root');
    assert.equal(JSON.parse(runIn(coreRoot, 'model', 'new', 'base_x', 'x.y', '--field', 'name:char').err).error, 'unknown-module', 'core modules are not searched');
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
  const exists = run('--odoo-version', '15', 'model', 'new', 'acme', 'acme.thing', '--field', 'name:char');
  assert.equal(exists.code, 1);
  assert.match(JSON.parse(exists.err).message, /model-exists: Model acme\.thing is already defined/);
  assert.equal(run('model', 'new', 'acme').code, 2);
  assert.equal(run('--odoo-version', '15', 'model', 'new', 'acme', 'acme.other', '--field', 'partner_id:many2one').code, 2);
  assert.equal(run('get', 'action=build').code, 2, 'get still refuses non-read actions');
  assert.equal(run('access', 'thing').code, 0, 'access <query> is still the read-only search');
});

test('builder: --preset adds common fields and combines with --field', () => {
  const root = mkdtempSync(join(tmpdir(), 'odoo-dc-preset-'));
  try {
    assert.equal(runIn(root, 'module', 'new', 'shop', '--into', root, '--apply').code, 0);
    const r = runIn(root, 'model', 'new', 'shop', 'shop.order', '--preset', 'name,partner,state', '--field', 'qty:float', '--apply');
    assert.equal(r.code, 0, r.err);
    const py = readFileSync(join(root, 'shop', 'models', 'shop_order.py'), 'utf8');
    for (const line of ["name = fields.Char(string='Name', required=True)", "partner_id = fields.Many2one('res.partner'", "default='draft'", 'qty = fields.Float']) assert.ok(py.includes(line), line);
    assert.equal(runIn(root, 'model', 'new', 'shop', 'shop.x', '--preset', 'bogus').code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

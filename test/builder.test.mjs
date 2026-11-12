import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BuilderError, appendXmlRecords, buildPlan, detectOdooVersion, ensureImport, ensureManifestData,
  parseAccessToken, parseFieldToken, plannedPaths, versionProfile,
} from '../lib/builder.js';

const MANIFEST = `{
    'name': 'Library',
    'depends': ['base'],
    'data': [
        'views/menu.xml',  # root menu
    ],
}
`;

const bookSpec = (extra = {}) => ({
  module: 'library',
  models: [{
    name: 'library.book',
    fields: ['name:char:required', 'partner_id:many2one:res.partner', 'state:selection:draft=Draft|done=Done', 'note:text'],
    menu: { name: 'Books', parent: 'library.menu_root' },
    access: [{ group: 'base.group_user', perms: 'rwc-' }],
    ...extra,
  }],
});

const fileOf = (plan, path) => plan.files.find((file) => file.path === path);

test('detectOdooVersion reads release.py and versionProfile follows it', () => {
  assert.equal(detectOdooVersion("version_info = (15, 0, 0, FINAL, 0, '')"), 15);
  assert.equal(detectOdooVersion("version_info = ('saas~17', 2, 0, 'final', 0, '')"), 17);
  assert.equal(detectOdooVersion('nothing'), undefined);
  assert.equal(versionProfile(15).listTag, 'tree');
  assert.equal(versionProfile(18).viewMode, 'list,form');
  assert.throws(() => versionProfile(undefined), BuilderError);
});

test('field and access tokens', () => {
  assert.deepEqual(parseFieldToken('partner_id:many2one:res.partner:required'), { name: 'partner_id', type: 'many2one', comodel: 'res.partner', required: true });
  assert.deepEqual(parseFieldToken('line_ids:one2many:x.line:order_id'), { name: 'line_ids', type: 'one2many', comodel: 'x.line', inverse: 'order_id' });
  assert.deepEqual(parseFieldToken('state:selection:draft=Draft|done').selection, [['draft', 'Draft'], ['done', 'Done']]);
  assert.throws(() => parseFieldToken('partner_id:many2one'), /comodel/);
  assert.throws(() => parseFieldToken('name:char:bogus'), /unknown flag/);
  assert.deepEqual(parseAccessToken('base.group_user:rwc-'), { group: 'base.group_user', perms: 'rwc-' });
});

test('model in an existing module: model, imports, views, action, menu, ACL, manifest (Odoo 15)', () => {
  const plan = buildPlan(bookSpec(), { version: 15, existing: { 'library/__manifest__.py': MANIFEST, 'library/__init__.py': '' }, models: new Map([['res.partner', { module: 'base' }]]) });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.files.map((file) => `${file.op} ${file.path}`), [
    'patch library/__init__.py',
    'patch library/__manifest__.py',
    'create library/models/__init__.py',
    'create library/models/library_book.py',
    'create library/security/ir.model.access.csv',
    'create library/views/library_book_views.xml',
  ]);
  const model = fileOf(plan, 'library/models/library_book.py').after;
  assert.match(model, /class LibraryBook\(models\.Model\):/);
  assert.match(model, /name = fields\.Char\(string='Name', required=True\)/);
  assert.match(model, /partner_id = fields\.Many2one\('res\.partner', string='Partner'\)/);
  const views = fileOf(plan, 'library/views/library_book_views.xml').after;
  assert.match(views, /id="library_book_view_tree"/);
  assert.match(views, /<tree>/);
  assert.match(views, /<field name="view_mode">tree,form<\/field>/);
  assert.match(views, /<menuitem id="library_book_menu" name="Books" parent="library.menu_root" action="library_book_action"/);
  assert.match(views, /group_by_partner_id/);
  assert.doesNotMatch(views.split('<tree>')[1].split('</tree>')[0], /note/, 'text field is not a list column');
  assert.equal(fileOf(plan, 'library/security/ir.model.access.csv').after.split('\n')[1],
    'access_library_book_group_user,library.book base.group_user,model_library_book,base.group_user,1,1,1,0');
  const manifest = fileOf(plan, 'library/__manifest__.py');
  assert.equal(manifest.before, MANIFEST);
  assert.match(manifest.after, /'data': \[\n {8}'security\/ir\.model\.access\.csv',\n {8}'views\/menu\.xml',  # root menu\n {8}'views\/library_book_views\.xml',\n {4}\],/);
  assert.equal(fileOf(plan, 'library/__init__.py').after, 'from . import models\n');
  assert.equal(fileOf(plan, 'library/models/__init__.py').after, 'from . import library_book\n');
});

test('Odoo 18 uses <list> and list,form', () => {
  const plan = buildPlan(bookSpec(), { version: 18, existing: { 'library/__manifest__.py': MANIFEST }, models: new Map([['res.partner', { module: 'base' }]]) });
  const views = fileOf(plan, 'library/views/library_book_views.xml').after;
  assert.match(views, /id="library_book_view_list"/);
  assert.match(views, /<list>[\s\S]*<\/list>/);
  assert.match(views, /list,form/);
  assert.doesNotMatch(views, /<tree/);
});

test('createModule scaffolds manifest + init and versions the module', () => {
  const plan = buildPlan({ ...bookSpec(), createModule: { depends: ['base', 'mail'], summary: 'Books' } }, { version: 12, existing: {}, models: new Map([['res.partner', { module: 'base' }]]) });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  const manifest = fileOf(plan, 'library/__manifest__.py');
  assert.equal(manifest.op, 'create');
  assert.match(manifest.after, /'version': '12\.0\.1\.0\.0'/);
  assert.match(manifest.after, /'depends': \['base', 'mail'\]/);
  assert.match(manifest.after, /'data': \[\n {8}'security\/ir\.model\.access\.csv',\n {8}'views\/library_book_views\.xml',\n {4}\],/);
  assert.equal(fileOf(plan, 'library/__init__.py').op, 'create');
});

test('fail fast: no files when anything is wrong', () => {
  const ctx = (existing) => ({ version: 15, existing: { 'library/__manifest__.py': MANIFEST, ...existing }, models: new Map([['library.book', { module: 'library' }], ['res.partner', { module: 'base' }]]) });
  const cases = [
    [buildPlan({ module: 'Library' }, ctx()), 'bad-module'],
    [buildPlan({ module: 'nolib', models: [] }, ctx()), 'unknown-module'],
    [buildPlan(bookSpec(), ctx()), 'model-exists'],
    [buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['id:integer'] }] }, ctx()), 'reserved-field'],
    [buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['a:char', 'a:char'] }] }, ctx()), 'duplicate-field'],
    [buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['a:bogus'] }] }, ctx()), 'bad-field-type'],
    [buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['name:char'] }] }, ctx({ 'library/models/x_y.py': 'x' })), 'file-exists'],
    [buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['name:char'] }] }, { ...ctx(), xmlIds: new Set(['library.x_y_action']) }), 'duplicate-xml-id'],
    [buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['name:char'], access: [{ group: 'g', perms: 'rw' }] }] }, ctx()), 'bad-access'],
    [buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['name:char'] }] }, ctx({ 'library/__manifest__.py': '{}' })), 'manifest-unparsable'],
  ];
  for (const [plan, code] of cases) {
    assert.equal(plan.ok, false, code);
    assert.deepEqual(plan.files, [], code);
    assert.ok(plan.errors.some((error) => error.code === code), `${code}: ${JSON.stringify(plan.errors)}`);
  }
});

test('warnings do not block: missing name, unknown comodel, naming', () => {
  const plan = buildPlan({ module: 'library', models: [{ name: 'x.y', fields: ['owner:many2one:z.unknown', 'amount:monetary'] }] }, { version: 15, existing: { 'library/__manifest__.py': MANIFEST } });
  assert.equal(plan.ok, true);
  for (const needle of ['no "name" field', 'z.unknown is not in the index', 'end in _id', 'currency_id']) {
    assert.ok(plan.warnings.some((warning) => warning.includes(needle)), needle);
  }
});

test('views and access for an existing model patch existing files', () => {
  const existing = {
    'library/__manifest__.py': MANIFEST,
    'library/views/res_partner_views.xml': '<?xml version="1.0"?>\n<odoo>\n    <record id="a" model="ir.ui.view"/>\n</odoo>\n',
    'library/security/ir.model.access.csv': 'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink\naccess_x,x,model_x,,1,0,0,0\n',
  };
  const models = new Map([['res.partner', { module: 'base', fields: [{ name: 'name', type: 'char' }, { name: 'parent_id', type: 'many2one' }] }]]);
  const plan = buildPlan({ module: 'library', views: [{ model: 'res.partner', type: 'list' }], access: [{ model: 'res.partner', group: 'library.group_x', perms: 'r---' }] }, { version: 16, existing, models });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  const views = fileOf(plan, 'library/views/res_partner_views.xml');
  assert.equal(views.op, 'patch');
  assert.match(views.after, /<record id="a" model="ir.ui.view"\/>\n\n {4}<record id="res_partner_view_tree"[\s\S]*<\/odoo>\n$/);
  const csv = fileOf(plan, 'library/security/ir.model.access.csv').after.trim().split('\n');
  assert.equal(csv.at(-1), 'access_res_partner_group_x,res.partner library.group_x,base.model_res_partner,library.group_x,1,0,0,0');
  assert.ok(!fileOf(plan, 'library/__manifest__.py').after.includes('res_partner_views.xml'), 'existing views file is assumed listed already');
  const dup = buildPlan({ module: 'library', access: [{ model: 'res.partner', group: 'library.group_x', perms: 'r---' }, { model: 'res.partner', group: 'library.group_x', perms: 'rw--' }] }, { version: 16, existing, models });
  assert.ok(dup.errors.some((error) => error.code === 'duplicate-access'));
});

test('manifest and init patch helpers', () => {
  assert.equal(ensureImport('from . import a\n', 'a'), 'from . import a\n');
  assert.equal(ensureImport('from . import a', 'b'), 'from . import a\nfrom . import b\n');
  assert.equal(ensureImport('from . import models, wizard\n', 'wizard'), 'from . import models, wizard\n');
  assert.equal(ensureManifestData(MANIFEST, ['views/menu.xml']), MANIFEST);
  assert.equal(ensureManifestData("{'depends': ['base']}", ['views/a.xml']), "{'depends': ['base'],\n    'data': [\n        'views/a.xml',\n    ],}");
  assert.equal(ensureManifestData("{'depends': ['base'], 'data': ['a.xml']}", ['b.xml']), "{'depends': ['base'], 'data': ['a.xml',\n        'b.xml',]}");
  // Real-corpus shapes: a commented-out entry is not "present", a trailing comment and a
  // blank line before `]` stay where they are, a `]` inside a comment does not end the list.
  assert.equal(
    ensureManifestData("{\n    'data': [\n        # 'wizard/a.xml',\n        'data/seq.xml',\n\n    ],\n}", ['wizard/a.xml']),
    "{\n    'data': [\n        # 'wizard/a.xml',\n        'data/seq.xml',\n        'wizard/a.xml',\n\n    ],\n}",
  );
  assert.equal(
    ensureManifestData("{'data': [\n    'a.xml'  # see [1]\n]}", ['b.xml']),
    "{'data': [\n    'a.xml',  # see [1]\n    'b.xml',\n]}",
  );
  assert.equal(ensureManifestData("{'data': [x + ['a']]}", ['b.xml']), undefined);
  assert.equal(appendXmlRecords('<odoo/>', ['x']), undefined);
  assert.deepEqual(plannedPaths({ module: 'm', models: [{ name: 'a.b' }] }).sort(), [
    'm/__init__.py', 'm/__manifest__.py', 'm/models/__init__.py', 'm/models/a_b.py', 'm/security/ir.model.access.csv', 'm/views/a_b_views.xml',
  ]);
});

test('generated Python compiles and XML parses (needs python3)', (t) => {
  let python;
  for (const candidate of ['python3', 'python']) {
    try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); python = candidate; break; } catch { /* try next */ }
  }
  if (python === undefined) { t.skip('python3 not available'); return; }
  const plan = buildPlan({ ...bookSpec(), createModule: true }, { version: 15, existing: {}, models: new Map([['res.partner', { module: 'base' }]]) });
  const dir = mkdtempSync(join(tmpdir(), 'odc-builder-'));
  const script = [
    'import ast, sys, xml.dom.minidom as m',
    'for p in sys.argv[1:]:',
    '    s = open(p).read()',
    '    (ast.parse(s) if p.endswith(".py") else m.parseString(s) if p.endswith(".xml") else None)',
  ].join('\n');
  const paths = plan.files.filter((file) => /\.(py|xml)$/.test(file.path)).map((file, i) => {
    const path = join(dir, `${i}-${file.path.split('/').pop()}`);
    writeFileSync(path, file.after);
    return path;
  });
  execFileSync(python, ['-c', script, ...paths]);
});

test('builder_apply: target guard, stale patch refused before any write, rollback, xml ids', async () => {
  const { ApplyError, applyPlan, assertWritableTarget, locateModule, moduleXmlIds } = await import('../lib/builder_apply.js');
  const { mkdirSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'odc-apply-'));
  try {
    assert.throws(() => assertWritableTarget(join(root, 'odoo', 'addons'), [{ path: root }]), /core\/enterprise/);
    assert.throws(() => assertWritableTarget('/nowhere', [{ path: root }]), /not inside any detected/);
    assert.equal(assertWritableTarget(join(root, 'coll'), [{ path: root }]).path, root);

    mkdirSync(join(root, 'coll', 'm', 'views'), { recursive: true });
    writeFileSync(join(root, 'coll', 'm', '__manifest__.py'), "{'data': []}\n");
    writeFileSync(join(root, 'coll', 'm', 'views', 'a.xml'), '<odoo><record id="r1" model="x"/><!-- <record id="ghost" model="x"/> --><menuitem id="other.m2"/></odoo>');
    assert.deepEqual(await locateModule([{ path: root, subfolders: [{ name: 'coll' }] }], 'm'), [join(root, 'coll')]);
    assert.deepEqual([...await moduleXmlIds(join(root, 'coll', 'm'), 'm')].sort(), ['m.r1', 'other.m2']);

    const dir = join(root, 'coll');
    const stale = { ok: true, files: [{ op: 'create', path: 'm/new.py', after: 'x' }, { op: 'patch', path: 'm/__manifest__.py', before: 'old', after: 'new' }] };
    await assert.rejects(applyPlan(dir, stale), (error) => error instanceof ApplyError && error.code === 'stale-file');
    assert.equal(existsSync(join(dir, 'm', 'new.py')), false, 'nothing written when a check fails');
    await assert.rejects(applyPlan(dir, { ok: true, files: [{ op: 'create', path: '../x.py', after: '' }] }), /not a plain relative path/);
    await assert.rejects(applyPlan(dir, { ok: false, files: [] }), /plan with errors/);

    // A path that cannot even be read is refused in the pre-check, before any write.
    mkdirSync(join(dir, 'm', 'blocked.xml'));
    await assert.rejects(applyPlan(dir, { ok: true, files: [{ op: 'create', path: 'm/a_new.py', after: 'x' }, { op: 'create', path: 'm/blocked.xml', after: 'y' }] }),
      (error) => error.code === 'read-failed');
    assert.equal(existsSync(join(dir, 'm', 'a_new.py')), false);
    // A write that fails midway rolls back the earlier create and patch.
    const real = { ok: true, files: [
      { op: 'create', path: 'm/a_new.py', after: 'x' },
      { op: 'patch', path: 'm/__manifest__.py', before: "{'data': []}\n", after: 'patched' },
      { op: 'create', path: 'm/blocked.xml/inner/z.py', after: 'y' },
    ] };
    writeFileSync(join(dir, 'm', 'blocked.xml', 'inner'), 'a file where a directory is needed');
    await assert.rejects(applyPlan(dir, real), (error) => error.code === 'write-failed' && /rolled back 2/.test(error.message));
    assert.equal(existsSync(join(dir, 'm', 'a_new.py')), false, 'created file removed');
    assert.equal(readFileSync(join(dir, 'm', '__manifest__.py'), 'utf8'), "{'data': []}\n", 'patched file restored');

    const ok = await applyPlan(dir, { ok: true, files: [{ op: 'patch', path: 'm/__manifest__.py', before: "{'data': []}\n", after: 'v2' }] });
    assert.deepEqual(ok, { created: [], patched: ['m/__manifest__.py'], backups: ['m/__manifest__.py.bak'] });
    assert.equal(readFileSync(join(dir, 'm', '__manifest__.py.bak'), 'utf8'), "{'data': []}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regressions from the real corpus: commented data key, CSV column order, existing-model views', () => {
  // A real Odoo 15 manifest had `# 'data': [...]` above the real key.
  const commented = "{\n    'depends': ['web'],\n    # 'data': [ 'views/old.xml', ],\n    'data': [\n        'views/a.xml',\n    ],\n}\n";
  assert.equal(ensureManifestData(commented, ['views/b.xml']), "{\n    'depends': ['web'],\n    # 'data': [ 'views/old.xml', ],\n    'data': [\n        'views/a.xml',\n        'views/b.xml',\n    ],\n}\n");
  const onlyCommented = "{\n    'depends': ['web'],\n    # 'data': [ 'views/old.xml', ],\n}\n";
  assert.match(ensureManifestData(onlyCommented, ['views/b.xml']), /'depends': \['web'\],\n {4}'data': \[\n {8}'views\/b\.xml',\n {4}\],\n {4}# 'data'/);

  const manifest = { 'm/__manifest__.py': "{'depends': ['base'], 'data': []}" };
  const swapped = buildPlan({ module: 'm', access: [{ model: 'res.partner', group: 'base.group_user', perms: 'r---' }] }, {
    version: 15, existing: { ...manifest, 'm/security/ir.model.access.csv': 'id,name,group_id:id,model_id:id,perm_read,perm_write,perm_create,perm_unlink\n' }, models: new Map([['res.partner', { module: 'base' }]]),
  });
  assert.ok(swapped.errors.some((error) => error.code === 'csv-unparsable'), 'column order differs');
  const slashId = buildPlan({ module: 'm', access: [{ model: 'res.partner', group: 'base.group_user', perms: 'r---' }] }, {
    version: 15, existing: { ...manifest, 'm/security/ir.model.access.csv': 'id,name,model_id/id,group_id/id,perm_read,perm_write,perm_create,perm_unlink\n' }, models: new Map([['res.partner', { module: 'base' }]]),
  });
  assert.equal(slashId.ok, true, '`/id` headers are accepted');

  // Index types are lowercased by the caller; fields outside the depends closure are dropped or refused.
  const partner = { module: 'base', fields: [
    { name: 'name', type: 'char', module: 'base' }, { name: 'parent_id', type: 'many2one', module: 'base' },
    { name: 'child_ids', type: 'one2many', module: 'base' }, { name: 'sale_order_ids', type: 'one2many', module: 'sale' },
  ] };
  const ctx = { version: 15, existing: manifest, models: new Map([['res.partner', partner]]), dependsClosure: new Set(['m', 'base']) };
  const auto = buildPlan({ module: 'm', views: [{ model: 'res.partner', type: 'form' }] }, ctx);
  const arch = auto.files.find((file) => file.path === 'm/views/res_partner_views.xml').after;
  assert.match(arch, /<group>\n {24}<field name="name"\/>\n {24}<field name="parent_id"\/>\n {20}<\/group>\n {20}<field name="child_ids"\/>/);
  assert.doesNotMatch(arch, /sale_order_ids/, 'field from a module outside depends');
  const picked = buildPlan({ module: 'm', views: [{ model: 'res.partner', type: 'list', fields: ['name', 'sale_order_ids'] }] }, ctx);
  assert.match(picked.errors[0].message, /comes from sale, which m does not depend on/);
  const many = { module: 'base', fields: Array.from({ length: 25 }, (_, i) => ({ name: `f${i}`, type: 'char', module: 'base' })) };
  assert.equal(buildPlan({ module: 'm', views: [{ model: 'res.partner', type: 'form' }] }, { ...ctx, models: new Map([['res.partner', many]]) }).errors[0].code, 'too-many-fields');
});

test('field reachability is exact when the index lists every definer (D5), and dependsClosure walks manifests', async () => {
  const manifest = { 'm/__manifest__.py': "{'depends': ['base'], 'data': []}" };
  const partner = { module: 'base', fields: [
    { name: 'name', type: 'char', module: 'base', modules: ['base'] },
    { name: 'email', type: 'char', module: 'mail', modules: ['mail', 'base'], definitions: 2 },
    { name: 'activity_ids', type: 'one2many', module: 'mail', modules: ['mail', 'other'], definitions: 2 },
  ] };
  const ctx = { version: 15, existing: manifest, models: new Map([['res.partner', partner]]), dependsClosure: new Set(['m', 'base']) };
  const ok = buildPlan({ module: 'm', views: [{ model: 'res.partner', type: 'list', fields: ['name', 'email'] }] }, ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.warnings, [], 'email is defined in base: no warning any more');
  const refused = buildPlan({ module: 'm', views: [{ model: 'res.partner', type: 'list', fields: ['activity_ids'] }] }, ctx);
  assert.match(refused.errors[0].message, /comes from mail, other, which m does not depend on/);

  const { dependsClosure } = await import('../lib/builder_apply.js');
  const { mkdirSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'odc-closure-'));
  try {
    for (const [name, deps] of [['a', ['b']], ['b', ['base']], ['base', []]]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, '__manifest__.py'), `{'depends': [${deps.map((d) => `'${d}'`).join(', ')}],  # 'zzz'\n}`);
    }
    const existing = { 'm/__manifest__.py': "{'depends': ['a', 'missing']}" };
    assert.deepEqual([...await dependsClosure([{ path: root }], { module: 'm' }, existing)].sort(), ['a', 'b', 'base', 'm', 'missing']);
    assert.deepEqual([...await dependsClosure([{ path: root }], { module: 'n', createModule: { depends: ['b'] } }, {})].sort(), ['b', 'base', 'n']);
    assert.equal(await dependsClosure([{ path: root }], { module: 'n' }, {}), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const withMixin = buildPlan({ module: 'm', views: [{ model: 'res.partner', type: 'list', fields: ['name', 'message_ids'] }] },
    { ...ctx, models: new Map([['res.partner', { ...partner, mixins: ['mail.thread'] }]]) });
  assert.equal(withMixin.ok, true);
  assert.match(withMixin.warnings[0], /message_ids: not declared on res\.partner itself; assumed to come from a mixin \(mail\.thread\)/);
});

test('D7: presets, defaults, token round-trip, field classification and builder metadata', async () => {
  const { FIELD_PRESETS, builderMeta, classifyFields, expandPresets, fieldToToken } = await import('../lib/builder.js');
  const fields = expandPresets(['name', 'state', 'amount', 'active', 'sequence']);
  assert.deepEqual(fields.map((field) => field.name), ['name', 'state', 'currency_id', 'amount', 'active', 'sequence']);
  fields[0].name = 'changed';
  assert.equal(FIELD_PRESETS.name[0].name, 'name', 'presets are copied, not shared');
  assert.throws(() => expandPresets(['bogus']), /Unknown preset "bogus"/);

  const plan = buildPlan({ module: 'm', createModule: true, models: [{ name: 'm.doc', fields: expandPresets(['name', 'state', 'amount', 'active', 'sequence']) }] }, { version: 15, existing: {}, models: new Map([['res.currency', { module: 'base' }]]) });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.warnings, [], 'amount brings its currency_id');
  const py = plan.files.find((file) => file.path === 'm/models/m_doc.py').after;
  assert.match(py, /state = fields\.Selection\(\[\('draft', 'Draft'\), .*\], string='State', default='draft'\)/);
  assert.match(py, /active = fields\.Boolean\(string='Active', default=True\)/);
  assert.match(py, /sequence = fields\.Integer\(string='Sequence', default=10\)/);
  for (const [token, ok] of [['flag:boolean:default=yes', false], ['state:selection:a|b:default=c', false], ['n:integer:default=1.5', false], ['n:float:default=1.5', true], ['note:char:default=Hi there', true]]) {
    const result = buildPlan({ module: 'm', createModule: true, models: [{ name: 'm.x', fields: ['name:char', token] }] }, { version: 15, existing: {} });
    assert.equal(result.ok, ok, token);
    if (!ok) assert.equal(result.errors[0].code, 'bad-default', token);
  }

  for (const token of ['partner_id:many2one:res.partner:required', 'line_ids:one2many:x.line:order_id', 'state:selection:draft|done=Finished:default=draft', 'sequence:integer:index:default=10']) {
    assert.equal(fieldToToken(parseFieldToken(token)), token);
  }
  assert.equal(fieldToToken({ name: 's', type: 'selection', selection: [['a', 'A: b']] }), undefined, 'not representable');
  assert.equal(fieldToToken({ name: 'p', type: 'many2one' }), undefined, 'incomplete');

  const classified = classifyFields([{ name: 'a', type: 'Char', modules: ['base'] }, { name: 'b', type: 'Char', modules: ['sale'] }, { name: 'c', type: 'Char', module: 'mail', definitions: 2 }], new Set(['m', 'base']));
  assert.deepEqual(classified.map((field) => `${field.name}:${field.type}:${field.reach}`), ['a:char:yes', 'b:char:no', 'c:char:maybe']);

  const meta = builderMeta();
  assert.deepEqual(meta.fieldTypes.find((entry) => entry.type === 'one2many'), { type: 'one2many', needsComodel: true, needsInverse: true, needsSelection: false, nameSuffix: '_ids', wide: true });
  assert.ok(meta.presets.state[0].selection.length === 4 && meta.flags.includes('required') && new RegExp(meta.namePattern).test('partner_id'));
  assert.doesNotThrow(() => JSON.stringify(meta));
});

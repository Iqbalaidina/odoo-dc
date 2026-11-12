import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSecurityIndex, effectivePerms, groupClosure, modelKey, parseAccessCsv, parseGroupsAttr,
  parseSecurityXml, searchSecurity, traceArtifact, traceGroup, traceModel,
} from '../lib/security.js';

const CSV = `id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink
access_book_user,book user,model_lib_book,group_user,1,0,0,0
access_book_mgr,book mgr,model_lib_book,group_manager,1,1,1,1
access_book_all,book all,model_lib_book,,1,0,0,0
bad_row,x,,,1,0,0,0
`;

const SECURITY_XML = `<odoo>
  <!-- <record id="ghost" model="res.groups"><field name="name">Ghost</field></record> -->
  <record id="group_user" model="res.groups">
    <field name="name">Library User</field>
    <field name="users" eval="[(4, ref('base.user_admin'))]"/>
  </record>
  <record id="group_manager" model="res.groups">
    <field name="name">Library Manager</field>
    <field name="implied_ids" eval="[(4, ref('group_user'))]"/>
  </record>
  <record id="rule_own" model="ir.rule">
    <field name="name">Own books</field>
    <field name="model_id" ref="model_lib_book"/>
    <field name="domain_force">[('owner_id','=',user.id)]</field>
    <field name="groups" eval="[(4, ref('group_user'))]"/>
    <field name="perm_unlink" eval="False"/>
  </record>
  <record id="rule_company" model="ir.rule">
    <field name="name">Company</field>
    <field name="model_id" ref="model_lib_book"/>
    <field name="domain_force">[('company_id','in',company_ids)]</field>
  </record>
</odoo>`;

const VIEW_XML = `<odoo>
  <record id="book_form" model="ir.ui.view">
    <field name="name">book.form</field>
    <field name="model">lib.book</field>
    <field name="arch" type="xml">
      <form>
        <field name="title"/>
        <field name="cost" groups="lib.group_manager"/>
        <button name="x" groups="lib.group_manager,!lib.group_user"/>
      </form>
    </field>
  </record>
  <record id="book_action" model="ir.actions.act_window">
    <field name="name">Books</field>
    <field name="res_model">lib.book</field>
    <field name="groups_id" eval="[(4, ref('lib.group_user'))]"/>
  </record>
  <menuitem id="menu_root" name="Library" groups="lib.group_user"/>
  <menuitem id="menu_books" name="Books" parent="menu_root" action="book_action" groups="lib.group_manager"/>
</odoo>`;

function build() {
  const parsed = [
    { csv: parseAccessCsv(CSV, { module: 'lib', file: 'security/ir.model.access.csv' }) },
    { xml: parseSecurityXml(SECURITY_XML, { module: 'lib', file: 'security/security.xml' }) },
    { xml: parseSecurityXml(VIEW_XML, { module: 'lib', file: 'views/book.xml' }) },
  ];
  return buildSecurityIndex(parsed);
}

test('modelKey folds dots, model_ ids and module prefixes together', () => {
  assert.equal(modelKey('res.partner'), 'res_partner');
  assert.equal(modelKey('model_res_partner'), 'res_partner');
  assert.equal(modelKey('base.model_res_partner'), 'res_partner');
});

test('parseGroupsAttr qualifies, trims and flags negation', () => {
  assert.deepEqual(parseGroupsAttr('a.b, !c', 'm'), [{ xmlId: 'a.b', negated: false }, { xmlId: 'm.c', negated: true }]);
});

test('access csv: rows, qualified groups, reported bad rows', () => {
  const { rows, errors } = parseAccessCsv(CSV, { module: 'lib', file: 'f.csv' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].group, 'lib.group_user');
  assert.equal(rows[2].group, '');
  assert.equal(rows[1].perms.unlink, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'missing-model');
  const broken = parseAccessCsv('a,b\n1,2\n', { module: 'lib', file: 'g.csv' });
  assert.equal(broken.errors[0].code, 'bad-csv-header');
});

test('access csv: model_id/id header variant is accepted', () => {
  const { rows, errors } = parseAccessCsv('id,name,model_id/id,group_id/id,perm_read\na,b,model_x_y,base.group_user,1\n', { module: 'm', file: 'f.csv' });
  assert.equal(errors.length, 0);
  assert.equal(rows[0].modelKey, 'x_y');
});

test('group declared in its own module anchors the trace, extensions only add implied ids', () => {
  const own = parseSecurityXml('<odoo><record id="group_a" model="res.groups"><field name="name">A</field></record></odoo>', { module: 'base', file: 'base/s.xml' });
  const ext = parseSecurityXml('<odoo><record id="base.group_a" model="res.groups"><field name="implied_ids" eval="[(4, ref(\'base.group_b\'))]"/></record></odoo>', { module: 'ext', file: 'ext/s.xml' });
  const index = buildSecurityIndex([{ xml: ext }, { xml: own }]);
  const group = index.groups.get('base.group_a');
  assert.equal(group.file, 'base/s.xml');
  assert.equal(group.name, 'A');
  assert.deepEqual(group.implied, ['base.group_b']);
});

test('xml: groups, rules, comments ignored', () => {
  const out = parseSecurityXml(SECURITY_XML, { module: 'lib', file: 's.xml' });
  assert.deepEqual(out.groups.map((g) => g.xmlId), ['lib.group_user', 'lib.group_manager']);
  assert.deepEqual(out.groups[1].implied, ['lib.group_user']);
  assert.deepEqual(out.groups[0].users, ['base.user_admin']);
  const [own, company] = out.rules;
  assert.equal(own.global, false);
  assert.equal(own.perms.unlink, false);
  assert.equal(own.perms.read, true);
  assert.equal(own.modelKey, 'lib_book');
  assert.equal(company.global, true);
});

test('xml: arch node groups attribute to the enclosing view, menus and actions are owners', () => {
  const out = parseSecurityXml(VIEW_XML, { module: 'lib', file: 'v.xml' });
  const view = out.owners.find((o) => o.xmlId === 'lib.book_form');
  assert.equal(view.model, 'lib.book');
  assert.equal(view.nodes.length, 2);
  assert.equal(view.nodes[1].groups[1].negated, true);
  const action = out.owners.find((o) => o.xmlId === 'lib.book_action');
  assert.equal(action.model, 'lib.book');
  assert.equal(action.groups[0].xmlId, 'lib.group_user');
  const menu = out.owners.find((o) => o.xmlId === 'lib.menu_books');
  assert.equal(menu.parent, 'lib.menu_root');
  assert.equal(menu.action, 'lib.book_action');
});

test('group closure follows implied_ids both ways and survives cycles', () => {
  const index = build();
  assert.deepEqual(groupClosure(index, 'lib.group_manager', 'down'), ['lib.group_user']);
  assert.deepEqual(groupClosure(index, 'lib.group_user', 'up'), ['lib.group_manager']);
  index.groups.get('lib.group_user').implied.push('lib.group_manager');
  index.includesCache.clear();
  assert.deepEqual(groupClosure(index, 'lib.group_manager', 'down').sort(), ['lib.group_user']);
});

test('effective perms: implied groups and ungrouped rows count', () => {
  const index = build();
  const user = effectivePerms(index, 'lib.group_user', 'lib_book');
  assert.equal(user.read, true);
  assert.equal(user.write, false);
  const manager = effectivePerms(index, 'lib.group_manager', 'lib_book');
  assert.equal(manager.write, true);
  assert.equal(manager.unlink, true);
});

test('traceGroup: hierarchy, inherited acl, rules, gates, short id', () => {
  const index = build();
  const trace = traceGroup(index, 'group_user');
  assert.equal(trace.group.xmlId, 'lib.group_user');
  assert.deepEqual(trace.includedBy.map((g) => g.xmlId), ['lib.group_manager']);
  assert.equal(trace.rules.direct.length, 1);
  assert.ok(trace.gates.some((g) => g.owner === 'lib.book_action'));
  assert.ok(trace.gates.some((g) => g.owner === 'lib.book_form' && g.negated));
  const manager = traceGroup(index, 'lib.group_manager');
  assert.equal(manager.acl.inherited.length, 1);
  assert.equal(manager.rules.inherited.length, 1);
  assert.equal(traceGroup(index, 'nope').error, 'unknown-group');
});

test('traceModel: matrix, warnings, usage', () => {
  const index = build();
  const trace = traceModel(index, 'lib.book');
  assert.equal(trace.model, 'lib.book');
  assert.equal(trace.groups[0].global, true);
  assert.deepEqual(trace.groups.find((g) => g.group === 'lib.group_user').grantedAlsoTo, ['lib.group_manager']);
  assert.ok(trace.warnings.some((w) => w.code === 'ungrouped-acl'));
  assert.ok(trace.warnings.some((w) => w.code === 'global-rule'));
  assert.ok(trace.used.some((u) => u.xmlId === 'lib.book_form'));
  assert.ok(traceModel(index, 'other.thing').warnings.some((w) => w.code === 'no-acl'));
});

test('traceArtifact: menu chain, action model, reach and gate-without-read', () => {
  const index = build();
  const menu = traceArtifact(index, 'lib.menu_books');
  assert.equal(menu.artifact.model, 'lib.book');
  assert.deepEqual(menu.menuChain.map((m) => m.xmlId), ['lib.menu_books', 'lib.menu_root']);
  assert.ok(menu.reach.find((r) => r.group === 'lib.group_manager').perms.write);
  assert.equal(menu.nodeReach.length, 0);
  const view = traceArtifact(index, 'lib.book_form');
  assert.equal(view.nodes.length, 2);
  assert.equal(view.reach.length, 0, 'node groups do not drive the owner-level reach');
  assert.equal(view.nodeReach.length, 1);
  assert.equal(traceArtifact(index, 'missing').error, 'unknown-artifact');
  // remove every read ACL: the gate leads nowhere
  index.acl.length = 0;
  assert.ok(traceArtifact(index, 'lib.menu_books').warnings.some((w) => w.code === 'gate-without-read'));
});

test('search: kinds, AND terms, truncation flag', () => {
  const index = build();
  assert.equal(searchSecurity(index, 'manager', 'group', 10).items[0].id, 'lib.group_manager');
  assert.ok(searchSecurity(index, 'lib book', 'model', 10).items.some((i) => i.id === 'lib.book'));
  const all = searchSecurity(index, '', 'all', 2);
  assert.equal(all.items.length, 2);
  assert.equal(all.truncated, true);
});

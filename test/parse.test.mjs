// Tests for the tolerant Odoo view XML parser (lib/parse.js).
//
// Run from the plugin root:
//   node --test test/parse.test.mjs
//
// The corpus tests are opt-in: set ODOO_DC_CORPUS to an Odoo checkout (the folder
// holding `odoo/addons`, optionally `custom-addons`). They are skipped otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseViewFile, indexViewFile, parseArch } from '../lib/parse.js';

const REPO_ROOT = process.env.ODOO_DC_CORPUS ?? '';
const CORE_ADDONS = path.join(REPO_ROOT, 'odoo', 'addons');
const CUSTOM_ADDONS = path.join(REPO_ROOT, 'custom-addons');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// NOTE: line numbers used by the "line" test below are pinned to this fixture.
const FORM_FILE = `<?xml version="1.0"?>
<odoo><data>
    <record id="view_event_form" model="ir.ui.view">
        <field name="name">event.event.form</field>
        <field name="model">event.event</field>
        <field name="priority">16</field>
        <field name="arch" type="xml">
            <form string="Events">
                <header>
                    <button name="action_go" type="object"/>
                </header>
                <sheet>
                    <group>
                        <field name="name"/>
                        <field name="date_begin"/>
                    </group>
                    <notebook>
                        <page string="Tickets">
                            <field name="ticket_ids"/>
                        </page>
                    </notebook>
                </sheet>
            </form>
        </field>
    </record>
    <record id="view_event_list" model="ir.ui.view">
        <field name="name">event.event.list</field>
        <field name="model">event.event</field>
        <field name="arch" type="xml">
            <list string="Events">
                <field name="name"/>
            </list>
        </field>
    </record>
    <record id="some_action" model="ir.actions.act_window">
        <field name="name">Events Action</field>
    </record>
    <template id="tpl_card" name="Card Template">
        <t t-name="tpl_card">
            <div class="card"><t t-out="value"/></div>
        </t>
    </template>
</data></odoo>`;

function findNode(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findNode(child, tag);
    if (found) return found;
  }
  return null;
}

function countNodes(node) {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function treeHeight(node) {
  if (!node.children.length) return 1;
  return 1 + Math.max(...node.children.map(treeHeight));
}

// ---------------------------------------------------------------------------
// parseViewFile: records
// ---------------------------------------------------------------------------

test('parseViewFile: parses a primary form view record', () => {
  const result = parseViewFile(FORM_FILE, {
    moduleName: 'event',
    filePath: 'odoo/addons/event/views/event_event_views.xml',
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.views.length, 3);
  assert.equal(result.otherRecordCount, 1);

  const form = result.views.find((view) => view.id === 'view_event_form');
  assert.ok(form, 'form view found');
  assert.equal(form.xmlId, 'event.view_event_form');
  assert.equal(form.kind, 'view');
  assert.equal(form.name, 'event.event.form');
  assert.equal(form.model, 'event.event');
  assert.equal(form.type, 'form');
  assert.equal(form.rawType, 'form');
  assert.equal(form.inheritId, '');
  assert.equal(form.mode, 'primary');
  assert.equal(form.priority, '16');
  assert.equal(form.line, 3);
  assert.equal(form.archError, undefined);

  // arch: trimmed + dedented XML, root is the form
  assert.ok(form.arch.startsWith('<form string="Events">'), form.arch.slice(0, 40));
  assert.equal(form.arch.split('\n')[1], '    <header>');
  assert.equal(form.arch.split('\n').at(-1), '</form>');
  assert.ok(!form.arch.endsWith('\n'));

  // source: trimmed + dedented record element
  assert.ok(form.source.startsWith('<record id="view_event_form" model="ir.ui.view">'));
  assert.ok(form.source.endsWith('</record>'));
  assert.equal(form.source.split('\n')[1], '    <field name="name">event.event.form</field>');

  // preview tree shape
  assert.equal(form.preview.tag, 'form');
  assert.equal(form.preview.attrs.string, 'Events');
  assert.deepEqual(
    form.preview.children.map((child) => child.tag),
    ['header', 'sheet'],
  );
  const sheet = form.preview.children[1];
  assert.deepEqual(
    sheet.children.map((child) => child.tag),
    ['group', 'notebook'],
  );
  const page = sheet.children[1].children[0];
  assert.equal(page.tag, 'page');
  assert.equal(page.attrs.string, 'Tickets');
  assert.equal(page.children[0].tag, 'field');

  // field metadata follows document order, nested included
  assert.deepEqual(form.fields, ['name', 'date_begin', 'ticket_ids']);
  assert.equal(form.fieldCount, 3);
  assert.equal(form.fieldText, 'name date_begin ticket_ids');
  assert.deepEqual(form.xpaths, []);
});

test('parseViewFile: parses list record and template, ignores other models', () => {
  const { views, otherRecordCount } = parseViewFile(FORM_FILE, { moduleName: 'event' });

  const list = views.find((view) => view.id === 'view_event_list');
  assert.equal(list.type, 'list');
  assert.equal(list.rawType, 'list');
  assert.equal(list.kind, 'view');
  assert.equal(list.line, 26);
  assert.equal(list.preview.tag, 'list');
  assert.equal(list.fieldText, 'name');

  const template = views.find((view) => view.id === 'tpl_card');
  assert.equal(template.kind, 'template');
  assert.equal(template.type, 'qweb');
  assert.equal(template.rawType, 't');
  assert.equal(template.name, 'Card Template');
  assert.equal(template.model, '');
  assert.equal(template.inheritId, '');
  assert.equal(template.mode, 'primary');
  assert.equal(template.priority, '');
  assert.equal(template.line, 38);
  assert.equal(template.preview.tag, 't');
  assert.deepEqual(template.fields, []);
  assert.equal(template.fieldText, '');

  // The ir.actions.act_window record is counted but not returned as a view.
  assert.equal(otherRecordCount, 1);
  assert.ok(views.every((view) => view.id !== 'some_action'));
});

test('parseViewFile: extracts window actions and their view links', () => {
  const xml = `<odoo><data>
    <record id="action_partner" model="ir.actions.act_window">
      <field name="name">Partners</field>
      <field name="res_model">res.partner</field>
      <field name="view_mode">list,form</field>
      <field name="view_id" ref="acme.view_partner_form"/>
      <field name="target">current</field>
      <field name="domain">[]</field>
      <field name="context">{'default_is_company': True}</field>
    </record>
    <record id="action_partner_view_form" model="ir.actions.act_window.view">
      <field name="act_window_id" ref="acme.action_partner"/>
      <field name="view_id" ref="acme.view_partner_form"/>
      <field name="view_mode">form</field>
      <field name="sequence">2</field>
    </record>
    <record id="v1" model="ir.ui.view">
      <field name="name">partner.form</field>
      <field name="model">res.partner</field>
    </record>
  </data></odoo>`;
  const { views, actions, otherRecordCount } = parseViewFile(xml, { moduleName: 'acme' });
  assert.equal(views.length, 1);
  assert.equal(otherRecordCount, 2, 'both action records are still counted as other records');

  const action = actions.find((entry) => entry.kind === 'window');
  assert.ok(action !== undefined);
  assert.equal(action.xmlId, 'acme.action_partner');
  assert.equal(action.model, 'ir.actions.act_window');
  assert.equal(action.name, 'Partners');
  assert.equal(action.resModel, 'res.partner');
  assert.equal(action.viewMode, 'list,form');
  assert.equal(action.viewId, 'acme.view_partner_form');
  assert.equal(action.target, 'current');
  assert.equal(action.domain, '[]');
  assert.match(action.context, /default_is_company/);
  assert.equal(action.fields.res_model, 'res.partner');
  assert.match(action.source, /<record id="action_partner"/);
  assert.match(action.sourceRaw, /<field name="view_mode">list,form<\/field>/);

  const link = actions.find((entry) => entry.kind === 'windowView');
  assert.ok(link !== undefined);
  assert.equal(link.xmlId, 'acme.action_partner_view_form');
  assert.equal(link.actWindowId, 'acme.action_partner');
  assert.equal(link.viewId, 'acme.view_partner_form');
  assert.equal(link.viewMode, 'form');
  assert.equal(link.sequence, '2');

  const indexed = indexViewFile(xml, { moduleName: 'acme' });
  assert.equal(indexed.actions.length, 2);
  assert.equal(indexed.actions[0].xmlId, 'acme.action_partner');
  assert.equal(indexed.actions[0].fields, undefined, 'the index path omits the full field map');
});

test('parseViewFile: model attribute may precede id, single quotes accepted', () => {
  const xml = `<odoo>
    <record model='ir.ui.view' id='view_single_quoted'>
        <field name='name'>single.quoted</field>
        <field name='model'>single.model</field>
        <field name='arch' type='xml'>
            <kanban class='o_kanban'><field name='name'/></kanban>
        </field>
    </record>
</odoo>`;
  const { views } = parseViewFile(xml, { moduleName: 'mod' });
  assert.equal(views.length, 1);
  assert.equal(views[0].id, 'view_single_quoted');
  assert.equal(views[0].xmlId, 'mod.view_single_quoted');
  assert.equal(views[0].type, 'kanban');
  assert.equal(views[0].preview.attrs.class, 'o_kanban');
});

test('parseViewFile: extension view via inherit_id ref', () => {
  const xml = `<odoo>
    <record model='ir.ui.view' id='view_event_form_inherit'>
        <field name='name'>event.event.form.inherit</field>
        <field name='model'>event.event</field>
        <field name='inherit_id' ref='event.view_event_form'/>
        <field name='arch' type='xml'>
            <xpath expr="//field[@name='name']" position='after'>
                <field name='subtitle'/>
            </xpath>
        </field>
    </record>
</odoo>`;
  const { views } = parseViewFile(xml, { moduleName: 'event' });
  const view = views[0];
  assert.equal(view.inheritId, 'event.view_event_form');
  assert.equal(view.mode, 'extension');
  assert.equal(view.type, 'unknown');
  assert.equal(view.rawType, 'xpath');
  assert.deepEqual(view.xpaths, ["//field[@name='name']"]);
  assert.deepEqual(view.fields, ['subtitle']);
  assert.equal(view.preview.tag, 'xpath');
});

test('parseViewFile: > inside quoted attribute values does not end a tag', () => {
  const xml = `<odoo><record id="v" model="ir.ui.view" context="{'a': 1 > 0}">
    <field name="name">V</field>
    <field name="model">m</field>
    <field name="arch" type="xml"><form>
        <field name="x" domain="[('state','>','draft')]"/>
    </form></field>
</record></odoo>`;
  const { views, warnings } = parseViewFile(xml);
  assert.deepEqual(warnings, []);
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].fields, ['x']);
});

test('parseViewFile: extension view via inherit_id text field', () => {
  const xml = `<odoo>
    <record id="v2" model="ir.ui.view">
        <field name="name">x.inherit.text</field>
        <field name="model">x</field>
        <field name="inherit_id">mod.parent_view</field>
        <field name="arch" type="xml"><xpath expr="//div" position="inside"/></field>
    </record>
</odoo>`;
  const { views } = parseViewFile(xml);
  assert.equal(views[0].inheritId, 'mod.parent_view');
  assert.equal(views[0].mode, 'extension');
  // Without a module name the xml id is the raw id attribute.
  assert.equal(views[0].xmlId, 'v2');
});

test('parseViewFile: id containing a dot is kept as xml id, kind stays view', () => {
  const xml = `<odoo>
    <record id="event.view_qualified" model="ir.ui.view">
        <field name="name">qualified</field>
        <field name="model">m</field>
        <field name="arch" type="xml"><form><field name="a"/></form></field>
    </record>
</odoo>`;
  const { views } = parseViewFile(xml, { moduleName: 'event' });
  assert.equal(views[0].xmlId, 'event.view_qualified');
  assert.equal(views[0].kind, 'view');
});

test('parseViewFile: legacy <tree> arch normalizes to list', () => {
  const xml = `<odoo>
    <record id="view_legacy_tree" model="ir.ui.view">
        <field name="name">legacy.tree</field>
        <field name="model">legacy.model</field>
        <field name="arch" type="xml">
            <tree string="Legacy">
                <field name="name"/>
            </tree>
        </field>
    </record>
</odoo>`;
  const { views } = parseViewFile(xml);
  assert.equal(views[0].type, 'list');
  assert.equal(views[0].rawType, 'tree');
  assert.equal(views[0].preview.tag, 'tree');
  assert.equal(views[0].fieldText, 'name');
});

test('parseViewFile: template with inherit_id / priority attributes', () => {
  const xml = `<odoo>
    <template id="base_tpl" name="Base"><t t-name="base_tpl"><div class="base"/></t></template>
    <template id="child_tpl" name="Child" inherit_id="mod.base_tpl" priority="42">
        <xpath expr="//div" position="inside"><span/></xpath>
    </template>
</odoo>`;
  const { views } = parseViewFile(xml);
  assert.equal(views.length, 2);

  const base = views[0];
  assert.equal(base.kind, 'template');
  assert.equal(base.type, 'qweb');
  assert.equal(base.rawType, 't');
  assert.equal(base.mode, 'primary');

  const child = views[1];
  assert.equal(child.kind, 'template');
  assert.equal(child.type, 'qweb');
  assert.equal(child.rawType, 'xpath');
  assert.equal(child.inheritId, 'mod.base_tpl');
  assert.equal(child.mode, 'extension');
  assert.equal(child.priority, '42');
  assert.deepEqual(child.xpaths, ['//div']);
});

test('parseViewFile: self-closing template has empty arch but stays qweb', () => {
  const xml = `<odoo><template id="empty_tpl" name="Empty"/></odoo>`;
  const { views } = parseViewFile(xml);
  const view = views[0];
  assert.equal(view.kind, 'template');
  assert.equal(view.type, 'qweb');
  assert.equal(view.rawType, '');
  assert.equal(view.arch, '');
  assert.equal(view.name, 'Empty');
  assert.equal(view.preview, null);
  assert.equal(view.archError, undefined);
});

test('parseViewFile: self-closing arch field yields empty arch', () => {
  const xml = `<odoo><record id="v_noarch" model="ir.ui.view">
    <field name="name">No Arch</field>
    <field name="model">m</field>
    <field name="arch" type="xml"/>
</record></odoo>`;
  const { views, warnings } = parseViewFile(xml);
  assert.deepEqual(warnings, []);
  const view = views[0];
  assert.equal(view.arch, '');
  assert.equal(view.preview, null);
  assert.equal(view.rawType, '');
  assert.equal(view.type, 'unknown');
  assert.deepEqual(view.fields, []);
  assert.equal(view.fieldText, '');
  assert.equal(view.archError, undefined);
});

test('parseViewFile: entities, CDATA and comments are tolerated', () => {
  const xml = `<odoo>
    <!-- <record id="fake" model="ir.ui.view"><field name="name">Fake</field></record> -->
    <record id="real_view" model="ir.ui.view" name="Fallback Name">
        <field name="name"><![CDATA[Cash & <Carry>]]></field>
        <field name="model">cash &amp; carry</field>
        <field name="arch" type="xml">
            <form>
                <!-- <field name="ghost"/> -->
                <field name="real" string="A &amp; B &#65;&#x42;"/>
            </form>
        </field>
    </record>
</odoo>`;
  const { views, warnings } = parseViewFile(xml);
  assert.deepEqual(warnings, []);
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.id, 'real_view');
  // name field got a CDATA value (preferred over the record's name attribute)
  assert.equal(view.name, 'Cash & <Carry>');
  assert.equal(view.model, 'cash & carry');
  assert.equal(view.preview.tag, 'form');
  assert.equal(view.preview.children.length, 1);
  assert.deepEqual(view.fields, ['real']);
  assert.equal(view.preview.children[0].attrs.string, 'A & B AB');
});

test('parseViewFile: name falls back to the record name attribute', () => {
  const xml = `<odoo><record id="v" model="ir.ui.view" name="Attr Name">
    <field name="model">m</field>
    <field name="arch" type="xml"><form/></field>
</record></odoo>`;
  const { views } = parseViewFile(xml);
  assert.equal(views[0].name, 'Attr Name');
});

test('parseViewFile: malformed unterminated record warns but still parses', () => {
  const xml = `<odoo>
    <record id="broken_view" model="ir.ui.view">
        <field name="name">Broken</field>
        <field name="model">broken.model</field>
        <field name="arch" type="xml">
            <form>
                <field name="a"/>
            </form>
        </field>
</odoo>`;
  const { views, warnings } = parseViewFile(xml, { filePath: 'broken.xml' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unterminated <record> element/);
  assert.match(warnings[0], /broken\.xml/);
  assert.equal(views.length, 1);
  assert.equal(views[0].id, 'broken_view');
  assert.equal(views[0].preview.tag, 'form');
  assert.deepEqual(views[0].fields, ['a']);
});

test('parseViewFile: non-view records are only counted, shorthand tags ignored', () => {
  const xml = `<odoo><data>
    <record id="a1" model="ir.actions.act_window"><field name="name">A</field></record>
    <menuitem id="menu_root" name="Root"/>
    <act_window id="act1" name="Act" res_model="x"/>
    <record id="v1" model="ir.ui.view"><field name="name">V1</field><field name="model">m</field></record>
</data></odoo>`;
  const { views, otherRecordCount } = parseViewFile(xml);
  assert.equal(views.length, 1);
  assert.equal(views[0].id, 'v1');
  assert.equal(otherRecordCount, 1);
});

test('parseViewFile: BOM and <openerp> roots are handled', () => {
  const body = `<data><record id="v" model="ir.ui.view"><field name="name">V</field><field name="model">m</field><field name="arch" type="xml"><form><field name="f"/></form></field></record></data>`;
  const withBom = `\uFEFF<odoo>${body}</odoo>`;
  const openerpNoData = `<openerp><record id="v" model="ir.ui.view"><field name="name">V</field><field name="model">m</field><field name="arch" type="xml"><form><field name="f"/></form></field></record></openerp>`;
  for (const xml of [withBom, openerpNoData]) {
    const { views, warnings } = parseViewFile(xml);
    assert.deepEqual(warnings, []);
    assert.equal(views.length, 1);
    assert.equal(views[0].id, 'v');
  }
});

test('parseViewFile: never throws on garbage input', () => {
  const inputs = [
    '',
    '   ',
    'not xml at all <<<>>> &&&',
    '<odoo><record model="ir.ui.view" id="x">',
    '<odoo><data>',
    '</odoo>',
    null,
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseViewFile(input, { filePath: 'garbage.xml' }));
    assert.doesNotThrow(() => indexViewFile(input));
  }
});

test('parseViewFile: fieldText is ordered, unique and space joined', () => {
  const xml = `<odoo><record id="v" model="ir.ui.view">
    <field name="name">n</field><field name="model">m</field>
    <field name="arch" type="xml"><form>
        <field name="a"/><field name="b"/><field name="c"/><field name="a"/>
        <field name="invisible_one" invisible="1"/>
    </form></field>
</record></odoo>`;
  const { views } = parseViewFile(xml);
  // invisible fields are not excluded
  assert.deepEqual(views[0].fields, ['a', 'b', 'c', 'invisible_one']);
  assert.equal(views[0].fieldText, 'a b c invisible_one');
  assert.equal(views[0].fieldCount, 4);
});

// ---------------------------------------------------------------------------
// parseArch: preview tree
// ---------------------------------------------------------------------------

test('parseArch: nested tree shape and document order', () => {
  const arch = `<form string="F">
  <sheet>
    <group>
      <field name="partner_id"/>
    </group>
    <notebook>
      <page string="P1">
        <field name="line_ids">
          <list><field name="product_id"/></list>
        </field>
      </page>
    </notebook>
  </sheet>
</form>`;
  const { root, fields, xpaths } = parseArch(arch);
  assert.equal(root.tag, 'form');
  assert.equal(root.attrs.string, 'F');
  assert.deepEqual(
    root.children.map((child) => child.tag),
    ['sheet'],
  );
  const sheet = root.children[0];
  assert.deepEqual(
    sheet.children.map((child) => child.tag),
    ['group', 'notebook'],
  );
  const page = sheet.children[1].children[0];
  assert.equal(page.tag, 'page');
  const list = findNode(page, 'list');
  assert.ok(list);
  assert.equal(list.children[0].tag, 'field');
  assert.equal(list.children[0].attrs.name, 'product_id');
  assert.deepEqual(fields, ['partner_id', 'line_ids', 'product_id']);
  assert.deepEqual(xpaths, []);
});

test('parseArch: direct text only, trimmed, children text excluded', () => {
  const { root } = parseArch('<div>Hello <b>world</b> again</div>');
  assert.equal(root.text, 'Hello  again');
  assert.equal(root.children[0].text, 'world');
  assert.equal(parseArch('<div>\n   \n</div>').root.text, '');
  assert.equal(parseArch('<div>Tom &amp; Jerry</div>').root.text, 'Tom & Jerry');
});

test('parseArch: collects field names and xpath exprs in order, deduplicated', () => {
  const arch = `<form>
      <field name="b"/>
      <group><field name="a"/><field name="b"/><field name=""/></group>
      <xpath expr="//x" position="inside"/>
      <xpath expr="//x" position="after"/>
      <xpath expr="//y" position="before"/>
    </form>`;
  const { fields, xpaths } = parseArch(arch);
  assert.deepEqual(fields, ['b', 'a']);
  assert.deepEqual(xpaths, ['//x', '//y']);
});

test('parseArch: locator positions and exact element spans', () => {
  const arch = `<data>
  <xpath expr="//field[@name='email']" position="after">
    <field name="vat"/>
  </xpath>
  <xpath expr="//group" position="inside"><field name="note"/></xpath>
</data>`;
  const { root, locators, xpaths } = parseArch(arch);
  assert.deepEqual(locators.map((entry) => `${entry.expr}:${entry.position}`), [
    "//field[@name='email']:after",
    '//group:inside',
  ]);
  assert.deepEqual(xpaths, ["//field[@name='email']", '//group']);
  assert.equal(locators[1].position, 'inside', 'a missing position defaults to inside');
  const [first, second] = root.children;
  assert.equal(arch.slice(first.loc.start, first.loc.end), `<xpath expr="//field[@name='email']" position="after">\n    <field name="vat"/>\n  </xpath>`);
  assert.equal(arch.slice(second.loc.start, second.loc.end), '<xpath expr="//group" position="inside"><field name="note"/></xpath>');
  assert.equal(arch.slice(second.children[0].loc.start, second.children[0].loc.end), '<field name="note"/>');
  assert.equal(root.loc.start, 0);
  assert.equal(root.loc.end, arch.length);
  assert.equal(parseArch('<form/>').root.loc.end, 7, 'self-closing elements carry their own span');
});

test('parseArch: entity decoding in attributes and text', () => {
  const { root } = parseArch(
    `<div title="a &amp; b &lt; c" data-x='&quot;q&quot;'>x &lt; y &#65; &#x42;</div>`,
  );
  assert.equal(root.attrs.title, 'a & b < c');
  assert.equal(root.attrs['data-x'], '"q"');
  assert.equal(root.text, 'x < y A B');
});

test('parseArch: strips comments and processing instructions', () => {
  const { root, fields } = parseArch(
    '<form><?xml-stylesheet x?><!-- <field name="ghost"/> --><field name="a"/></form>',
  );
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].attrs.name, 'a');
  assert.deepEqual(fields, ['a']);
});

test('parseArch: tolerates malformed markup without throwing', () => {
  // Mismatched close tags, boolean attribute without a value, unescaped '&'.
  const arch = `<form><group><field name="a"><field name="b"/></group>
      <field name="c" required string="a & b"/>
      </bogus></form>`;
  let result;
  assert.doesNotThrow(() => {
    result = parseArch(arch);
  });
  assert.equal(result.root.tag, 'form');
  assert.ok(result.fields.includes('c'));
  const fieldC = result.root.children[1];
  assert.equal(fieldC.tag, 'field');
  assert.equal(fieldC.attrs.required, '');
  assert.equal(fieldC.attrs.string, 'a & b');

  // Stray close tag before the real root.
  assert.equal(parseArch('</bogus><form><field name="x"/></form>').root.tag, 'form');

  // Several top-level elements are kept behind a virtual root (extension
  // arches often hold multiple locators without a wrapper element).
  const multi = parseArch('<form/><list/>').root;
  assert.equal(multi.tag, '#arch');
  assert.equal(multi.virtual, true);
  assert.deepEqual([...multi.children].map((child) => child.tag), ['form', 'list']);

  // '>' inside a quoted attribute value must not terminate the tag.
  const gtAttr = parseArch(
    `<form><field name="a" domain="[('state','>','x')]"/><field name="b"/></form>`,
  );
  assert.deepEqual(gtAttr.fields, ['a', 'b']);

  // Unterminated tag at EOF: whatever came before is still returned.
  assert.doesNotThrow(() => parseArch('<form><field name="x"'));
  assert.equal(parseArch('<form><field name="x"').root.tag, 'form');
});

test('parseArch: QWeb / legacy quirks are tolerated', () => {
  const arch = `<t t-name="x"><div t-if="a &gt; b">{% if x %} hi {% endif %}<t t-out="v"/></div></t>`;
  const { root } = parseArch(arch);
  assert.equal(root.tag, 't');
  assert.equal(root.children[0].tag, 'div');
  assert.equal(root.children[0].text, '{% if x %} hi {% endif %}');

  // Legacy attrs/states attributes are kept verbatim.
  const legacy = parseArch(
    `<form><button attrs="{'invisible': [('state','=','draft')]}" states="draft" name="go"/></form>`,
  );
  assert.equal(legacy.root.children[0].attrs.attrs, "{'invisible': [('state','=','draft')]}");
  assert.equal(legacy.root.children[0].attrs.states, 'draft');
});

test('parseArch: node cap is respected', () => {
  const { root } = parseArch(`<r>${'<x/>'.repeat(7000)}</r>`);
  assert.equal(root.tag, 'r');
  assert.equal(countNodes(root), 6000);
  assert.equal(root.children.length, 5999);
});

test('parseArch: depth cap is respected', () => {
  const { root } = parseArch('<a>'.repeat(100) + '</a>'.repeat(100));
  assert.equal(root.tag, 'a');
  assert.equal(treeHeight(root), 64);
});

test('parseArch: empty input returns null root without error', () => {
  for (const input of ['', '   ', null, undefined]) {
    const result = parseArch(input);
    assert.equal(result.root, null);
    assert.deepEqual(result.fields, []);
    assert.deepEqual(result.xpaths, []);
    assert.equal(result.error, undefined);
  }
  const textOnly = parseArch('just some text');
  assert.equal(textOnly.root, null);
  assert.equal(typeof textOnly.error, 'string');
});

test('parseArch: input is capped at 1 MiB', () => {
  const huge = `<form>${'x'.repeat(1024 * 1024 + 512)}</form>`;
  let result;
  assert.doesNotThrow(() => {
    result = parseArch(huge);
  });
  assert.equal(result.root.tag, 'form');
  assert.ok(result.root.text.length > 0);
  assert.ok(result.root.text.length <= 1024 * 1024);

  // A field that only appears after the cap is not collected.
  const lateField = `<form>${' '.repeat(1024 * 1024)}<field name="late"/></form>`;
  assert.deepEqual(parseArch(lateField).fields, []);
});

// ---------------------------------------------------------------------------
// indexViewFile
// ---------------------------------------------------------------------------

test('indexViewFile: matches parseViewFile summaries and never builds trees', () => {
  const full = parseViewFile(FORM_FILE, { moduleName: 'event' });
  const index = indexViewFile(FORM_FILE, { moduleName: 'event' });

  assert.equal(index.views.length, full.views.length);
  assert.equal(index.otherRecordCount, full.otherRecordCount);

  const summaryKeys = [
    'fieldText',
    'id',
    'inheritId',
    'line',
    'mode',
    'model',
    'name',
    'priority',
    'rawType',
    'type',
    'xmlId',
  ];
  for (let i = 0; i < full.views.length; i++) {
    const fullView = full.views[i];
    const view = index.views[i];
    assert.deepEqual(Object.keys(view).sort(), summaryKeys);
    for (const key of ['id', 'xmlId', 'name', 'model', 'type', 'rawType', 'inheritId', 'mode', 'priority', 'line']) {
      assert.equal(view[key], fullView[key], `${fullView.id}.${key}`);
    }
    assert.equal(view.fieldText, fullView.fields.join(' '), `${fullView.id}.fieldText`);
    assert.ok(!('preview' in view));
    assert.ok(!('arch' in view));
    assert.ok(!('fields' in view));
  }

  const formSummary = index.views.find((view) => view.id === 'view_event_form');
  assert.equal(formSummary.fieldText, 'name date_begin ticket_ids');
});

test('indexViewFile: fieldText from arch with 3 fields is "a b c"', () => {
  const xml = `<odoo><record id="v" model="ir.ui.view">
    <field name="name">n</field><field name="model">m</field>
    <field name="arch" type="xml"><form><field name="a"/><field name="b"/><field name="c"/></form></field>
</record></odoo>`;
  const view = indexViewFile(xml).views[0];
  assert.equal(view.fieldText, 'a b c');
  assert.equal(parseViewFile(xml).views[0].fieldText, 'a b c');
});

test('indexViewFile: fieldText is empty without arch', () => {
  const xml = `<odoo><record id="v" model="ir.ui.view">
    <field name="name">n</field><field name="model">m</field><field name="arch" type="xml"/>
</record></odoo>`;
  assert.equal(indexViewFile(xml).views[0].fieldText, '');
});

// ---------------------------------------------------------------------------
// Corpus smoke tests (skipped when the checkout is not present)
// ---------------------------------------------------------------------------

function collectViewFiles(dir, out = [], limit = Infinity) {
  if (out.length >= limit) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectViewFiles(full, out, limit);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.xml') &&
      full.includes(`${path.sep}views${path.sep}`)
    ) {
      out.push(full);
    }
  }
  return out;
}

const CAN_RUN_CORPUS = REPO_ROOT.length > 0 && (fs.existsSync(CORE_ADDONS) || fs.existsSync(CUSTOM_ADDONS));
const EVENT_FILE = path.join(CORE_ADDONS, 'event', 'views', 'event_event_views.xml');

test('corpus smoke: parses real Odoo view files without throwing', { skip: !CAN_RUN_CORPUS }, () => {
  const files = [];
  for (const required of [EVENT_FILE]) {
    if (fs.existsSync(required)) files.push(required);
  }
  for (const dir of [CORE_ADDONS, CUSTOM_ADDONS]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of collectViewFiles(dir, [], 800)) {
      if (files.length >= 400) break;
      if (!files.includes(file)) files.push(file);
    }
  }
  assert.ok(files.length > 0, 'corpus files found');

  let totalViews = 0;
  let totalOtherRecords = 0;
  const types = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let full;
    let summary;
    assert.doesNotThrow(() => {
      full = parseViewFile(text, { filePath: file });
    }, `parseViewFile threw for ${file}`);
    assert.doesNotThrow(() => {
      summary = indexViewFile(text, { filePath: file });
    }, `indexViewFile threw for ${file}`);
    assert.equal(summary.views.length, full.views.length, `view count mismatch for ${file}`);
    for (let i = 0; i < full.views.length; i++) {
      assert.equal(summary.views[i].fieldText, full.views[i].fields.join(' '), `fieldText mismatch in ${file}`);
    }
    totalViews += full.views.length;
    totalOtherRecords += full.otherRecordCount;
    for (const view of full.views) types.add(view.type);
  }

  assert.ok(totalViews > 0, 'corpus contains views');
  assert.ok(totalOtherRecords > 0, 'corpus contains non-view records');
  assert.ok(
    ['form', 'list', 'kanban', 'search'].some((type) => types.has(type)),
    `expected at least one form/list/kanban/search view, saw: ${[...types].join(', ')}`,
  );
});

// `event/views/event_event_views.xml` is the Odoo 17/18 file name; older checkouts skip this test.
test('corpus smoke: the core event form view is found', { skip: !CAN_RUN_CORPUS || !fs.existsSync(EVENT_FILE) }, () => {
  const event = parseViewFile(fs.readFileSync(EVENT_FILE, 'utf8'), { moduleName: 'event' });
  const eventForm = event.views.find((view) => view.id === 'view_event_form');
  assert.ok(eventForm, 'event form view found');
  assert.equal(eventForm.model, 'event.event');
  assert.equal(eventForm.type, 'form');
  assert.equal(eventForm.kind, 'view');
  assert.equal(eventForm.preview.tag, 'form');
  assert.ok(eventForm.fields.includes('name'));
  assert.ok(event.otherRecordCount > 0, 'event file contains non-view records');
});

test('corpus speed: indexViewFile handles 200 real files quickly', { skip: !CAN_RUN_CORPUS }, () => {
  const files = [];
  for (const dir of [CORE_ADDONS, CUSTOM_ADDONS]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of collectViewFiles(dir, [], 200)) {
      if (files.length >= 200) break;
      files.push(file);
    }
  }
  assert.ok(files.length > 0);

  const texts = files.map((file) => fs.readFileSync(file, 'utf8'));
  const startedAt = performance.now();
  let views = 0;
  for (const text of texts) views += indexViewFile(text).views.length;
  const elapsedMs = performance.now() - startedAt;

  // Measured on an Odoo 18 checkout: ~200 files are
  // indexed in well under 200 ms; the 5 s bound is intentionally generous to
  // avoid flaky assertions on slow machines.
  console.log(
    `# indexViewFile: ${files.length} files, ${views} views, ${elapsedMs.toFixed(1)} ms`,
  );
  assert.ok(views > 0, 'indexed some views');
  assert.ok(elapsedMs < 5000, `indexViewFile took ${elapsedMs.toFixed(1)} ms for ${files.length} files`);
});

test('parseViewFile exposes exact editable spans and raw source', () => {
  const file = [
    '<?xml version="1.0"?>',
    '<odoo>',
    '  <data>',
    '    <record id="view_a" model="ir.ui.view">',
    '      <field name="name">a.form</field>',
    '      <field name="model">a.b</field>',
    '      <field name="arch" type="xml"><form><sheet><field name="x"/></sheet></form></field>',
    '    </record>',
    '    <template id="tpl_a"><t t-name="a.Tpl"><div/></t></template>',
    '  </data>',
    '</odoo>',
    '',
  ].join('\n');
  const { views } = parseViewFile(file, { moduleName: 'mod' });
  const record = views.find((view) => view.id === 'view_a');
  assert.equal(typeof record.sourceStart, 'number');
  assert.equal(typeof record.sourceEnd, 'number');
  assert.equal(record.sourceRaw, file.slice(record.sourceStart, record.sourceEnd));
  assert.match(record.sourceRaw, /^<record id="view_a"/);
  assert.match(record.sourceRaw, /<\/record>$/);
  const template = views.find((view) => view.id === 'tpl_a');
  assert.equal(template.sourceRaw, file.slice(template.sourceStart, template.sourceEnd));
  assert.match(template.sourceRaw, /^<template id="tpl_a">/);
  // A splices edit keeps the rest of the file byte-identical.
  const edited = record.sourceRaw.replace('a.form', 'a.form.edited');
  const next = file.slice(0, record.sourceStart) + edited + file.slice(record.sourceEnd);
  const reparsed = parseViewFile(next, { moduleName: 'mod' });
  assert.equal(reparsed.views.find((view) => view.id === 'view_a').name, 'a.form.edited');
  assert.ok(reparsed.views.find((view) => view.id === 'tpl_a'));
});

test('parseArch: multiple top-level locators keep every part under a virtual root', () => {
  const arch = '<xpath expr="//field[@name=\'a\']" position="after"><field name="b"/></xpath><field name="c" position="before"/>';
  const result = parseArch(arch);
  assert.equal(result.root.virtual, true);
  assert.equal(result.root.tag, '#arch');
  assert.deepEqual([...result.root.children].map((node) => node.tag), ['xpath', 'field']);
  assert.equal(result.root.children[0].attrs.expr, "//field[@name='a']");
  assert.deepEqual([...result.fields], ['b', 'c']);
  assert.deepEqual([...result.xpaths], ["//field[@name='a']"]);
});

test('parseViewFile extracts ir.actions.report and report.paperformat metadata', () => {
  const xml = [
    '<?xml version="1.0"?>',
    '<odoo><data>',
    '  <record id="action_report_card" model="ir.actions.report">',
    '    <field name="name">Partner Card</field>',
    '    <field name="model">acme.partner</field>',
    '    <field name="report_type">qweb-pdf</field>',
    '    <field name="report_name">acme_partner.report_card</field>',
    '    <field name="paperformat_id" ref="acme_partner.paperformat_card"/>',
    '  </record>',
    '  <record id="paperformat_card" model="report.paperformat">',
    '    <field name="format">A4</field>',
    '    <field name="orientation">Landscape</field>',
    '    <field name="margin_top">10</field>',
    '  </record>',
    '  <template id="report_card"><t t-name="acme.ReportCard"><div/></t></template>',
    '</data></odoo>',
  ].join('\n');
  const parsed = parseViewFile(xml, { moduleName: 'acme_partner', filePath: 'x.xml' });
  assert.equal(parsed.reports.length, 1);
  assert.equal(parsed.reports[0].xmlId, 'acme_partner.action_report_card');
  assert.equal(parsed.reports[0].model, 'ir.actions.report');
  assert.equal(parsed.reports[0].fields.report_name, 'acme_partner.report_card');
  assert.equal(parsed.reports[0].fields.report_type, 'qweb-pdf');
  assert.equal(parsed.reports[0].fields.paperformat_id, 'acme_partner.paperformat_card');
  assert.equal(parsed.paperformats.length, 1);
  assert.equal(parsed.paperformats[0].fields.format, 'A4');
  assert.equal(parsed.paperformats[0].fields.orientation, 'Landscape');
  assert.equal(parsed.views.length, 1);
  assert.equal(parsed.views[0].type, 'qweb');
});

// Engine API tests: createEngine, readAction and EngineError, without HTTP or the CLI.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { EngineError, createEngine } from '../lib/engine.js';

let base;
let addons;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'odoo-dc-engine-'));
  addons = join(base, 'custom-addons');
  mkdirSync(join(addons, 'acme', 'views'), { recursive: true });
  mkdirSync(join(addons, 'acme', 'models'), { recursive: true });
  writeFileSync(join(addons, 'acme', '__manifest__.py'), "{'name': 'Acme', 'depends': []}\n");
  writeFileSync(join(addons, 'acme', 'models', 'thing.py'), "from odoo import fields, models\n\n\nclass Thing(models.Model):\n    _name = 'acme.thing'\n\n    amount = fields.Float()\n");
  writeFileSync(join(addons, 'acme', 'views', 'thing.xml'), `<odoo>
  <record id="thing_form" model="ir.ui.view"><field name="name">thing.form</field><field name="model">acme.thing</field>
    <field name="arch" type="xml"><form><field name="amount"/></form></field></record>
</odoo>\n`);
});
after(() => rmSync(base, { recursive: true, force: true }));

test('createEngine discovers roots from base and serves read actions', async () => {
  const engine = createEngine({ base });
  const roots = await engine.read('roots');
  assert.equal(roots.roots.length, 1);
  assert.match(roots.roots[0].path, /custom-addons$/);

  const search = await engine.read('search', { q: 'acme.thing' });
  assert.ok(search.items.some((hit) => hit.xmlId === 'acme.thing_form' || hit.id === 'thing_form'), JSON.stringify(search.items));

  const model = await engine.read('pymodel', new URLSearchParams('model=acme.thing'));
  assert.ok(model.fields.some((field) => field.name === 'amount'));
});

test('createEngine with explicit roots needs no base', async () => {
  const engine = createEngine({ roots: [addons] });
  assert.equal(engine.roots().length, 1);
});

test('engine failures are EngineError values with code and status', async () => {
  assert.throws(() => createEngine({}), (error) => error instanceof EngineError && error.code === 'missing-base');
  const engine = createEngine({ roots: [addons] });
  await assert.rejects(engine.read('nope'), (error) => error instanceof EngineError && error.code === 'unknown-action' && error.status === 404);
  await assert.rejects(engine.read('search', { q: '' }), (error) => error.code === 'missing-query' && error.status === 400);
  await assert.rejects(engine.read('pymodel', { model: 'no.such' }), (error) => error.code === 'unknown-model' && error.status === 404);
});

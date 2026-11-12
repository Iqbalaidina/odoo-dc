import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePythonFile } from '../lib/python.js';
import {
  buildPythonIndex, computeModuleOrder, resolveMethodChain, findCallers, findCallees, searchPython, resolveModel,
} from '../lib/python_index.js';

const SOURCE = `from odoo import api, models


class Partner(models.Model):
    _name = 'acme.partner'
    _inherit = ['mail.thread']
    _description = 'Partner Model'

    name = fields.Char(string='Name', required=True)
    parent_id = fields.Many2one('res.partner', string='Parent')

    @api.depends('name')
    def _compute_label(self):
        for record in self:
            record.label = record.name or ''

    @property
    def display_name(self):
        return self.name

    def write(self, vals):
        res = super().write(vals)
        self.message_post(body='changed')
        return res

    def helper(self):
        self.write({'name': 'x'})


def module_helper(record):
    return record.write({})


class Other(models.Model):
    _inherit = 'acme.partner'

    def write(self, vals):
        return super(Partner, self).write(vals)
`;

test('python parser: classes, attrs, methods, decorators, super and calls', () => {
  const parsed = parsePythonFile(SOURCE, { moduleName: 'acme', filePath: 'acme/models/partner.py' });
  assert.equal(parsed.classes.length, 2);
  const partner = parsed.classes[0];
  assert.equal(partner.name, 'Partner');
  assert.equal(partner.model, 'acme.partner');
  assert.deepEqual(partner.inherits, ['mail.thread']);
  assert.deepEqual(partner.bases, ['models.Model']);
  assert.equal(partner.description, 'Partner Model');
  assert.equal(partner.fields.length, 2);
  assert.equal(partner.fields[0].name, 'name');
  assert.equal(partner.fields[0].fieldType, 'Char');
  assert.equal(partner.fields[1].comodel, 'res.partner');
  assert.deepEqual(partner.methods.map((method) => method.name), ['_compute_label', 'display_name', 'write', 'helper']);
  const write = partner.methods.find((method) => method.name === 'write');
  assert.equal(write.line, 21);
  assert.equal(write.decorators.length, 0);
  assert.equal(write.args, 'self, vals');
  assert.ok(write.superCalls.some((call) => call.name === 'write'));
  assert.ok(write.calls.some((call) => call.name === 'message_post'));
  assert.equal(write.calls.find((call) => call.name === 'message_post').text.includes('message_post'), true);
  const compute = partner.methods.find((method) => method.name === '_compute_label');
  assert.deepEqual(compute.decorators, ["@api.depends('name')"]);
  const other = parsed.classes[1];
  assert.equal(other.model, 'acme.partner');
  assert.equal(other.methods[0].superCalls[0].cls, 'Partner');
  assert.equal(parsed.functions.length, 1);
  assert.equal(parsed.functions[0].name, 'module_helper');
  assert.equal(parsed.functions[0].args, 'record');
});

test('python index: module order follows manifest dependencies', () => {
  const order = computeModuleOrder(new Map([
    ['acme_ext', ['acme_core']],
    ['acme_core', []],
  ]));
  assert.ok(order.get('acme_core') < order.get('acme_ext'));
});

test('python index: chain, callers, callees, search and model payload', () => {
  const core = parsePythonFile(`class P(models.Model):
    _name = 'acme.p'

    name = fields.Char(string='Name')
    partner_id = fields.Many2one('res.partner')

    def write(self, vals):
        return super().write(vals)

    def action(self):
        self.write({})
`, { moduleName: 'acme_core', filePath: 'acme_core/models/p.py' });
  const ext = parsePythonFile(`class P(models.Model):
    _inherit = 'acme.p'

    def write(self, vals):
        return super().write(vals)
`, { moduleName: 'acme_ext', filePath: 'acme_ext/models/p.py' });
  const manifests = new Map([
    ['acme_core', { depends: [] }],
    ['acme_ext', { depends: ['acme_core'] }],
  ]);
  const data = buildPythonIndex([
    { rootPath: '/tmp', module: 'acme_core', file: 'acme_core/models/p.py', parsed: core },
    { rootPath: '/tmp', module: 'acme_ext', file: 'acme_ext/models/p.py', parsed: ext },
  ], manifests);
  assert.equal(data.stats.methods, 3);
  assert.equal(data.models.length, 1);

  const chain = resolveMethodChain(data, 'acme.p', 'write');
  assert.equal(chain.length, 2);
  assert.equal(chain[0].module, 'acme_core');
  assert.equal(chain[1].module, 'acme_ext');
  assert.equal(chain[0].hasSuper, true);
  assert.equal(chain[1].isLast, true);

  const callers = findCallers(data, 'write');
  assert.ok(callers.some((caller) => caller.method === 'action'));

  const callees = findCallees(data, chain[0].calls);
  assert.ok(callees.some((callee) => callee.name === 'write'));

  const search = searchPython(data, 'action', 'method');
  assert.ok(search.items.some((item) => item.name === 'action'));
  const defSearch = searchPython(data, 'def action()', 'method');
  assert.ok(defSearch.items.some((item) => item.name === 'action'), 'def/parentheses are normalized');
  const fieldSearch = searchPython(data, 'partner_id', 'model');
  assert.ok(fieldSearch.items.some((item) => item.name === 'acme.p'), 'field names find their model');

  const model = resolveModel(data, 'acme.p');
  assert.equal(model.classCount, 2);
  assert.ok(model.methods.some((entry) => entry.name === 'write'));
});

test('python parser keeps multi-line statements, comments and triple-quoted strings intact', () => {
  const parsed = parsePythonFile(`class A(models.Model):
    _name = 'a'

    def f(self):
        self.write({
'x': 1,
})
        # comment with def fake(self):
        return True

    def g(self):
        """Doc.
        def fake(self):
        """
        return 2
`);
  assert.deepEqual([...parsed.classes[0].methods.map((method) => method.name)], ['f', 'g']);
  const f = parsed.classes[0].methods[0];
  const g = parsed.classes[0].methods[1];
  assert.ok(f.sourceLines.some((line) => line.includes('return True')), 'multi-line call did not cut the method');
  assert.ok(f.sourceLines.some((line) => line.includes('# comment with def fake')), 'comment kept in the method source');
  assert.ok(!parsed.classes[0].methods.some((method) => method.name === 'fake'), 'triple-quoted def is not a method');
  assert.ok(g.sourceLines.some((line) => line.includes('return 2')), 'next method still parses');
});

test('python parser captures multi-line decorators completely', () => {
  const parsed = parsePythonFile(`class AccountMove(models.Model):
    _name = 'account.move'

    def _helper(self):
        return 1

    @api.depends(
        'line_ids.balance',
        'line_ids.amount_currency',
        'state',
    )
    def _compute_amount(self):
        return True
`);
  const compute = parsed.classes[0].methods.find((method) => method.name === '_compute_amount');
  assert.ok(compute !== undefined);
  assert.equal(compute.decorators.length, 1);
  assert.ok(compute.decorators[0].includes("'line_ids.balance'") && compute.decorators[0].includes("'state'"));
});

test('python index: every defining module of a field is kept (D5 request from the builder)', () => {
  const core = parsePythonFile(`class P(models.Model):
    _name = 'acme.p'

    name = fields.Char()
    email = fields.Char()
`, { moduleName: 'acme_core', filePath: 'acme_core/models/p.py' });
  const mail = parsePythonFile(`class P(models.Model):
    _inherit = 'acme.p'

    email = fields.Char(string='Email')
`, { moduleName: 'mail', filePath: 'mail/models/p.py' });
  const data = buildPythonIndex([
    { rootPath: '/tmp', module: 'acme_core', file: 'acme_core/models/p.py', parsed: core },
    { rootPath: '/tmp', module: 'mail', file: 'mail/models/p.py', parsed: mail },
  ], new Map([['acme_core', { depends: [] }], ['mail', { depends: [] }]]));

  const model = resolveModel(data, 'acme.p');
  assert.deepEqual(model.fields.find((field) => field.name === 'name').modules, ['acme_core'], 'a single definer stays a one-element list');
  const email = model.fields.find((field) => field.name === 'email');
  assert.equal(email.definitions, 2);
  assert.deepEqual([...email.modules].sort(), ['acme_core', 'mail'], 'both definers are reported, not only the last one');
  assert.deepEqual([...data.modelFields.get('acme.p').get('email').modules].sort(), ['acme_core', 'mail'], 'the raw field map carries them too');
});

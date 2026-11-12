import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMethodFlow, parseArgumentNames } from '../lib/python_flow.js';

const SOURCE = `@api.depends('partner_id', 'line_ids.price')
def _compute_total(self):
    for record in self:
        total = 0.0
        if record.partner_id:
            total += record.amount
        record.total = total
    return True

def action_done(self, vals):
    self.ensure_one()
    res = super().action_done(vals)
    if 'note' not in vals:
        raise UserError(_("Note is required"))
    self.write({'state': 'done', 'note': vals.get('note')})
    self.env['res.partner'].search([])
    return res
`;

test('argument parsing removes defaults and annotations', () => {
  assert.deepEqual([...parseArgumentNames('self, vals, records: list, force=False')], ['self', 'vals', 'records', 'force']);
});

test('flow exposes decorator inputs, read fields, writes, returns and raises', () => {
  const lines = SOURCE.split('\n');
  const compute = buildMethodFlow(lines.slice(1, 8), {
    line: 2,
    args: 'self',
    decorators: ["@api.depends('partner_id', 'line_ids.price')"],
    model: 'sale.order',
    name: '_compute_total',
    superCalls: [],
  });
  assert.deepEqual(compute.params, ['self']);
  assert.deepEqual(compute.decoratorInputs.map((entry) => entry.name), ['partner_id', 'line_ids.price']);
  assert.ok(compute.fields.some((field) => field.name === 'partner_id'));
  assert.ok(compute.fields.some((field) => field.name === 'amount'));
  assert.ok(compute.outputs.writes.some((write) => write.name === 'total' && write.kind === 'assignment'));
  assert.equal(compute.control[0].kind, 'loop', 'control tree starts with the for loop');
  assert.equal(compute.control[0].loopType, 'for');
  const inner = compute.control[0].body.find((node) => node.kind === 'if');
  assert.ok(inner !== undefined, 'loop body contains the if');
  assert.ok(inner.branches.length >= 1, 'if node carries branches');

  const action = buildMethodFlow(lines.slice(9), {
    line: 10,
    args: 'self, vals',
    decorators: [],
    model: 'sale.order',
    name: 'action_done',
    superCalls: [{ name: 'action_done', line: 13 }],
  });
  assert.ok(action.steps.some((step) => step.kind === 'super' && step.label === 'super().action_done()'));
  assert.ok(action.steps.some((step) => step.kind === 'env' && step.label.includes('res.partner')));
  assert.ok(action.fields.some((field) => field.name === 'note' && field.source === 'vals'));
  assert.ok(action.outputs.writes.some((write) => write.name === 'state'));
  assert.ok(action.outputs.writes.some((write) => write.name === 'note'));
  assert.ok(action.outputs.raises.some((entry) => entry.error === 'UserError'));
  assert.ok(action.outputs.returns.some((entry) => entry.expr === 'res'));
});

test('control tree keeps a multi-line call and comments as one statement', () => {
  const flow = buildMethodFlow([
    'def f(self):',
    '    self.write({',
    "        'state': 'done',",
    "        'note': 'x',",
    '    })',
    '    # a comment',
    '    return True',
  ], {
    line: 10,
    args: 'self',
    decorators: [],
    model: 'sale.order',
    name: 'f',
    superCalls: [],
  });
  assert.deepEqual([...flow.control.map((node) => node.kind)], ['write', 'return']);
  assert.equal(flow.control[0].line, 11, 'node points at the first line of the statement');
  assert.ok(flow.control[0].text.includes("'state': 'done'"), 'multi-line text is joined');
  assert.ok(flow.control[0].text.includes("'note': 'x'"));
});

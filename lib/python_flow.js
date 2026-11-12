import { maskPythonSource } from './python.js';

/**
 * Static data-flow analysis for one Python method: parameters, fields read,
 * decorator inputs, calls, field writes, returns and raises. It is a source-text
 * model, not an interpreter: branches are not evaluated and dynamic access is
 * not resolved.
 */

const READ_SKIP = new Set([
  'env', 'sudo', 'with_context', 'with_user', 'with_company', 'filtered', 'filtered_domain',
  'mapped', 'sorted', 'sorted_reversed', 'exists', 'ensure_one', 'browse', 'search', 'search_count',
  'search_read', 'read', 'read_group', 'write', 'create', 'update', 'unlink', 'copy', 'default_get',
  'name_get', 'name_search', 'get', 'set', 'append', 'extend', 'format', 'join', 'strip', 'lower',
  'upper', 'split', 'replace', 'items', 'keys', 'values', 'getattr', 'super', 'record', 'records',
]);

const KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'return', 'yield', 'assert', 'with', 'lambda', 'and', 'or',
  'not', 'in', 'is', 'None', 'True', 'False', 'del', 'raise', 'try', 'except', 'finally', 'pass',
  'break', 'continue', 'class', 'def', 'import', 'from', 'global', 'nonlocal', 'await', 'async',
  'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'range', 'enumerate',
  'zip', 'map', 'filter', 'sorted', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr',
  'super', 'type', 'any', 'all', 'min', 'max', 'sum', 'abs', 'round', 'open', 'repr', 'format', 'next',
  'iter', 'vars', 'dir', 'id', 'hash', 'callable', 'property',
]);

const FIELD_CAP = 80;
const STEP_CAP = 140;
const RETURN_CAP = 24;
const RAISE_CAP = 16;
const WRITE_CAP = 80;

/** Strip a trailing comment, keeping quotes intact. */
function stripComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== '') {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * Parse a Python argument list into parameter names.
 * @param {string} args - argument text (for example `self, vals, force=False`).
 * @returns {string[]} parameter names without defaults or annotations.
 */
export function parseArgumentNames(args) {
  if (typeof args !== 'string' || args.trim().length === 0) return ['self'];
  const out = [];
  let depth = 0;
  let current = '';
  const push = () => {
    let name = current.trim();
    current = '';
    if (name.length === 0) return;
    name = name.split('=')[0].trim();
    const annotation = name.indexOf(':');
    if (annotation !== -1) name = name.slice(0, annotation).trim();
    name = name.replace(/^[*]+/, '').trim();
    if (name.length > 0) out.push(name);
  };
  for (const char of args) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) push();
    else current += char;
  }
  push();
  return out.length > 0 ? out : ['self'];
}

/** Find dict keys with a colon in an accumulated write/create payload. */
function quotedKeys(text) {
  const out = [];
  const pattern = /(['"])([A-Za-z_][\w.]*)\1\s*:/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!out.includes(match[2])) out.push(match[2]);
  }
  return out;
}

/** Count indentation with four-space tabs. */
function indentOf(line) {
  let indent = 0;
  for (const char of line) {
    if (char === ' ') indent += 1;
    else if (char === '\t') indent += 4;
    else break;
  }
  return indent;
}

/** Classify a simple statement for the control-flow chart. */
function simpleKind(text) {
  if (/^\s*return\b/.test(text)) return 'return';
  if (/^\s*raise\b/.test(text)) return 'raise';
  if (/\.(write|create|update|unlink)\s*\(/.test(text)) return 'write';
  if (/=/.test(text) && !/[=!<>]=/.test(text)) return 'assign';
  if (/\(/.test(text)) return 'call';
  return 'stmt';
}

/**
 * Fold physical source lines into logical statements: bracket continuations,
 * backslash continuations and triple-quoted strings stay in one statement.
 * @param {string[]} lines - physical lines.
 * @param {number} startLine - absolute line of the first line.
 * @returns {Array<object>} logical statements with raw text, masked code and line.
 */
function foldStatements(lines, startLine) {
  const { masked, continuation } = maskPythonSource(lines);
  const groups = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index === 0 || continuation[index] !== true || groups.length === 0) {
      groups.push({ start: index, end: index, lines: [lines[index]] });
    } else {
      const group = groups[groups.length - 1];
      group.end = index;
      group.lines.push(lines[index]);
    }
  }
  return groups.map((group) => ({
    start: group.start,
    end: group.end,
    indent: indentOf(lines[group.start]),
    line: startLine + group.start,
    text: group.lines.join('\n').trim(),
    code: masked.slice(group.start, group.end + 1).join('\n'),
  }));
}

/**
 * Build a small control-flow tree (if/elif/else, for, while, try/with) from the
 * method body lines. Branches and loop bodies become children so the UI can draw
 * a branched/looping diagram.
 * @param {string[]} lines - method lines, starting at the `def` line.
 * @param {number} startLine - absolute line number of the `def` line.
 * @returns {Array<object>} control-flow nodes.
 */
function buildControlTree(lines, startLine) {
  const budget = { count: 0 };
  const MAX_NODES = 400;
  const MAX_DEPTH = 10;
  const statements = foldStatements(lines, startLine);
  const codeOf = (statement) => statement.code.replace(/\s+/g, ' ').trim();
  const rawOf = (statement) => statement.text.replace(/\s+/g, ' ').trim();

  const findBody = (index, parentIndent) => {
    let cursor = index + 1;
    let bodyIndent = null;
    while (cursor < statements.length) {
      const statement = statements[cursor];
      if (codeOf(statement).length === 0) {
        cursor += 1;
        continue;
      }
      if (statement.indent <= parentIndent) break;
      if (bodyIndent === null) bodyIndent = statement.indent;
      cursor += 1;
    }
    return bodyIndent === null ? null : { start: index + 1, end: cursor, indent: bodyIndent };
  };

  const parseBlock = (start, end, baseIndent, depth) => {
    const nodes = [];
    if (depth > MAX_DEPTH) return nodes;
    let index = start;
    while (index < end && budget.count < MAX_NODES) {
      const statement = statements[index];
      const code = codeOf(statement);
      if (code.length === 0) {
        index += 1;
        continue;
      }
      if (statement.indent < baseIndent) break;
      if (statement.indent > baseIndent) {
        index += 1;
        continue;
      }
      const compound = /^(if|elif|else|for|while|try|except|finally|with)\b(.*):$/.exec(code);
      if (compound !== null) {
        const keyword = compound[1];
        if (keyword === 'elif' || keyword === 'else' || keyword === 'except' || keyword === 'finally') break;
        const body = findBody(index, statement.indent);
        if (body === null) {
          nodes.push({ kind: simpleKind(code), line: statement.line, text: rawOf(statement).slice(0, 160) });
          index += 1;
          continue;
        }
        budget.count += 1;
        const condition = compound[2].trim().slice(0, 160);
        const children = parseBlock(body.start, body.end, body.indent, depth + 1);
        if (keyword === 'if') {
          const branches = [{ label: 'then', condition, body: children }];
          let cursor = body.end;
          while (cursor < statements.length && budget.count < MAX_NODES) {
            const branchStatement = statements[cursor];
            const branchCode = codeOf(branchStatement);
            if (branchCode.length === 0) {
              cursor += 1;
              continue;
            }
            if (branchStatement.indent !== statement.indent) break;
            const branch = /^(elif|else)\b(.*):$/.exec(branchCode);
            if (branch === null) break;
            const branchBody = findBody(cursor, statement.indent);
            if (branchBody === null) break;
            budget.count += 1;
            const isElse = branch[1] === 'else';
            branches.push({
              label: isElse ? 'else' : 'elif',
              condition: isElse ? '' : branch[2].trim().slice(0, 160),
              body: parseBlock(branchBody.start, branchBody.end, branchBody.indent, depth + 1),
            });
            cursor = branchBody.end;
          }
          nodes.push({ kind: 'if', line: statement.line, condition, branches });
          index = cursor;
          continue;
        }
        if (keyword === 'for' || keyword === 'while') {
          nodes.push({ kind: 'loop', loopType: keyword, line: statement.line, condition, body: children });
          index = body.end;
          continue;
        }
        nodes.push({
          kind: keyword === 'with' ? 'with' : 'block',
          line: statement.line,
          text: rawOf(statement).slice(0, 160),
          body: children,
        });
        index = body.end;
        continue;
      }
      budget.count += 1;
      nodes.push({ kind: simpleKind(code), line: statement.line, text: rawOf(statement).slice(0, 160) });
      index += 1;
    }
    return nodes;
  };

  const defIndent = statements.length > 0 ? statements[0].indent : 0;
  const firstBody = findBody(0, defIndent);
  if (firstBody === null) return [];
  return parseBlock(firstBody.start, firstBody.end, firstBody.indent, 0);
}

/** Advance brace depth for one line. */
function braceDelta(line) {
  let depth = 0;
  for (const char of line) {
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
  }
  return depth;
}

/**
 * Build the static data flow of one method definition.
 * @param {string[]} lines - method source lines, starting at the `def` line.
 * @param {{ line: number, args: string, decorators: string[], model: string, name: string, superCalls: Array<object> }} method - method metadata.
 * @returns {object} flow description.
 */
export function buildMethodFlow(lines, method) {
  const source = Array.isArray(lines) ? lines : [];
  const startLine = method.line;
  const params = parseArgumentNames(method.args);
  const receivers = new Set(params);
  receivers.add('self');
  const fields = new Map();
  const decoratorInputs = [];
  const writes = new Map();
  const returns = [];
  const raises = [];
  const steps = [];
  const warnings = [];

  const addField = (name, line, sourceKind) => {
    if (typeof name !== 'string' || name.length === 0 || fields.size >= FIELD_CAP) return;
    if (fields.has(name)) return;
    fields.set(name, { name, line, source: sourceKind });
  };
  const addStep = (kind, label, line) => {
    if (steps.length >= STEP_CAP) return;
    if (label.length === 0) return;
    const key = `${kind}:${line}:${label}`;
    if (steps.some((step) => step.key === key)) return;
    steps.push({ key, kind, label: label.slice(0, 160), line });
  };
  const addWrite = (name, line, kind) => {
    if (typeof name !== 'string' || name.length === 0 || writes.size >= WRITE_CAP) return;
    if (!writes.has(name)) writes.set(name, { name, line, kind });
  };

  // Decorator-declared inputs.
  for (const decorator of Array.isArray(method.decorators) ? method.decorators : []) {
    const match = /(depends|onchange|constrains)\s*\(([\s\S]*?)\)/.exec(decorator);
    if (match === null) continue;
    const kind = match[1];
    for (const field of [...match[2].matchAll(/['"]([\w.]+)['"]/g)].map((entry) => entry[1])) {
      decoratorInputs.push({ name: field, source: kind, line: 0 });
      addField(field, 0, kind);
    }
  }

  // Loop and comprehension variables become record aliases.
  for (const raw of source) {
    const line = stripComment(raw);
    for (const loop of line.matchAll(/\bfor\s+([A-Za-z_][\w\s,]*?)\s+in\b/g)) {
      for (const name of loop[1].split(',').map((entry) => entry.trim()).filter(Boolean)) receivers.add(name);
    }
  }

  let writeAccumulator = null;
  for (let index = 0; index < source.length; index += 1) {
    const absolute = startLine + index;
    const raw = source[index];
    const line = stripComment(raw);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Write/create/update payloads (can span lines).
    const writeMatch = /\.(write|create|update)\s*\(\s*(\{|\n|\s*$)/.exec(line);
    if (writeMatch !== null) {
      let payload = line.slice(line.indexOf(writeMatch[0]) + writeMatch[0].length);
      let depth = braceDelta(writeMatch[0] + payload);
      let cursor = index;
      while (depth > 0 && cursor + 1 < source.length && cursor - index < 30) {
        cursor += 1;
        payload += `\n${stripComment(source[cursor])}`;
        depth += braceDelta(source[cursor]);
      }
      for (const key of quotedKeys(payload)) addWrite(key, absolute, 'write');
      addStep('write', `${writeMatch[1]}(...)`, absolute);
    }

    // Assignments to record fields.
    const assignment = /^\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*(\+?=)(?!=)/.exec(line);
    if (assignment !== null && receivers.has(assignment[1]) && assignment[2].length > 0) {
      addWrite(assignment[2], absolute, 'assignment');
    }

    // vals/value inputs.
    for (const match of line.matchAll(/\b(?:vals|values)\.(?:get|pop|setdefault)\(\s*['"]([\w.]+)['"]/g)) addField(match[1], absolute, 'vals');
    for (const match of line.matchAll(/\b(?:vals|values)\[\s*['"]([\w.]+)['"]\s*\]/g)) addField(match[1], absolute, 'vals');
    for (const match of line.matchAll(/['"]([\w.]+)['"]\s+(?:not\s+)?in\s+(?:vals|values)\b/g)) addField(match[1], absolute, 'vals');
    for (const match of line.matchAll(/self\.env\.context\.get\(\s*['"]([\w.]+)['"]/g)) addField(match[1], absolute, 'context');

    // Fields read from records.
    for (const match of line.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*(\()?/g)) {
      const receiver = match[1];
      if (!receivers.has(receiver)) continue;
      const field = match[2];
      if (match[3] === '(') continue;
      if (field.startsWith('_') || field.length === 0) continue;
      if (READ_SKIP.has(field)) continue;
      if (assignment !== null && assignment[1] === receiver && assignment[2] === field) continue;
      addField(field, absolute, receiver === 'self' ? 'self' : 'record');
    }

    // env model calls.
    for (const match of line.matchAll(/self\.env\[\s*['"]([\w.]+)['"]\s*\]\.([A-Za-z_]\w*)/g)) {
      addStep('env', `env["${match[1]}"].${match[2]}()`, absolute);
    }

    // Record method calls (write/create/update already treated as writes).
    for (const match of line.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g)) {
      if (!receivers.has(match[1])) continue;
      if (match[2] === 'env') continue;
      if (['write', 'create', 'update', 'unlink'].includes(match[2])) continue;
      if (['get', 'pop', 'setdefault', 'append', 'update', 'keys', 'values', 'items'].includes(match[2])) continue;
      addStep('call', `${match[1]}.${match[2]}()`, absolute);
    }

    // Conditions and loops, as process notes.
    const logic = /^\s*(if|elif|while|for)\b\s*(.*?):\s*$/.exec(line);
    if (logic !== null) addStep('logic', `${logic[1]} ${logic[2]}`.slice(0, 120), absolute);

    // Returns and raises.
    const returned = /^\s*return\b\s*(.*)$/.exec(line);
    if (returned !== null) {
      if (returns.length < RETURN_CAP) returns.push({ line: absolute, expr: returned[1].trim().slice(0, 160) });
    }
    const thrown = /^\s*raise\s+([A-Za-z_][\w.]*)/.exec(line);
    if (thrown !== null && raises.length < RAISE_CAP) raises.push({ line: absolute, error: thrown[1] });

    writeAccumulator = null;
  }

  // super() calls from the parser (line-exact).
  for (const call of Array.isArray(method.superCalls) ? method.superCalls : []) {
    addStep('super', `super().${call.name}()`, call.line);
  }
  // Other bare calls from the parser that were not attributed to a receiver.
  for (const call of Array.isArray(method.calls) ? method.calls : []) {
    if (KEYWORDS.has(call.name) || READ_SKIP.has(call.name)) continue;
    addStep('function', `${call.name}()`, call.line);
  }

  steps.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
  for (const output of writes.values()) {
    if (!steps.some((step) => step.kind === 'write' && step.line === output.line)) {
      // Assignment-only writes are still part of the process list.
      addStep('assign', `write ${output.name}`, output.line);
    }
  }
  steps.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
  warnings.push('Static text analysis: branches are not evaluated and dynamic attribute access is not resolved.');

  return {
    params,
    fields: [...fields.values()],
    decoratorInputs,
    steps,
    outputs: {
      writes: [...writes.values()].sort((left, right) => left.line - right.line),
      returns,
      raises,
    },
    control: buildControlTree(source, startLine),
    warnings,
  };
}

export default { buildMethodFlow, parseArgumentNames };

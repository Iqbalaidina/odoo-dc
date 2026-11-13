/**
 * Dependency-free, tolerant Python scanner for Odoo model classes.
 *
 * It is not a Python parser. It reads indentation-structured source and extracts
 * the pieces the method explorer needs: classes (`_name`, `_inherit`, `_inherits`,
 * bases), methods (decorators, arguments, line span), explicit/zero-arg `super()`
 * calls and textual call sites. Everything is best-effort and bounded.
 */

const KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'return', 'yield', 'assert', 'with', 'lambda',
  'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'del', 'raise', 'try',
  'except', 'finally', 'pass', 'break', 'continue', 'class', 'def', 'import', 'from',
  'global', 'nonlocal', 'await', 'async', 'match', 'case', 'print', 'len', 'str', 'int',
  'float', 'bool', 'list', 'dict', 'set', 'tuple', 'range', 'enumerate', 'zip', 'map',
  'filter', 'sorted', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr',
  'super', 'type', 'any', 'all', 'min', 'max', 'sum', 'abs', 'round', 'open', 'repr',
  'format', 'next', 'iter', 'vars', 'dir', 'id', 'hash', 'callable', 'property',
]);

const METHOD_CAP_PER_CLASS = 1_000;
const CALL_CAP_PER_METHOD = 200;
const LINE_CAP = 60_000;

// Similarity signature shape. 5-grams of normalised tokens, bottom-48 hashes:
// enough resolution for a Jaccard score, small enough to persist per method.
const SHINGLE_SIZE = 5;
const SHINGLE_LIMIT = 48;
const SHINGLE_MIN_TOKENS = 12;

/** Count leading whitespace with four-space tabs. */
function indentOf(line) {
  let indent = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === ' ') indent += 1;
    else if (char === '\t') indent += 4;
    else break;
  }
  return indent;
}

/** Strip a trailing comment, keeping '#' inside quotes. */
function stripComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== '') {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = '';
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * Mask comments and string bodies while preserving line count, indentation and
 * bracket depth. The parser uses this structural view so a line inside a
 * multi-line string or a continuation cannot be mistaken for a class/method
 * boundary. `continuation[i]` marks a line that starts inside brackets, a
 * triple-quoted string or a backslash continuation.
 * @param {string[]} lines - raw source lines.
 * @returns {{ masked: string[], continuation: boolean[] }} structural view.
 */
export function maskPythonSource(lines) {
  const masked = [];
  const continuation = [];
  let depth = 0;
  let triple = null;
  let pendingBackslash = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = String(lines[index] ?? '');
    continuation.push(triple !== null || depth > 0 || pendingBackslash);
    let out = '';
    let quote = '';
    let currentTriple = triple;
    for (let cursor = 0; cursor < raw.length; cursor += 1) {
      const char = raw[cursor];
      if (currentTriple !== null) {
        if (raw.startsWith(currentTriple, cursor)) {
          out += '   ';
          cursor += 2;
          currentTriple = null;
        } else {
          out += ' ';
        }
        continue;
      }
      if (quote !== '') {
        out += ' ';
        if (char === '\\') {
          out += ' ';
          cursor += 1;
        } else if (char === quote) {
          quote = '';
        }
        continue;
      }
      if (char === '#') {
        out += ' '.repeat(raw.length - cursor);
        break;
      }
      if (char === "'" || char === '"') {
        const candidate = raw.slice(cursor, cursor + 3);
        if (candidate === '\"\"\"' || candidate === "'''") {
          currentTriple = candidate;
          out += '   ';
          cursor += 2;
          continue;
        }
        quote = char;
        out += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
      out += char;
    }
    triple = currentTriple;
    pendingBackslash = triple === null && depth === 0 && /\\\s*$/.test(out);
    masked.push(out);
  }
  return { masked, continuation };
}

/**
 * FNV-1a 32-bit hash. Pure integer arithmetic, so the same body yields the same
 * signature on every run and platform — the persisted index depends on that.
 * @param {string} text - text to hash.
 * @returns {number} unsigned 32-bit hash.
 */
function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const IDENTIFIER_RE = /[A-Za-z_]\w*/y;
const NUMBER_RE = /(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/y;
const OPERATOR_CHARS = new Set('=+-*/%<>!&|^~@.,:;()[]{}');

/**
 * Normalise Python source to the token stream a similarity signature is built
 * from: comments and docstrings dropped, string literals -> `S`, numbers -> `N`,
 * identifiers lowercased, operators kept one token per character. Re-indenting,
 * renaming a literal, a comment or a docstring therefore does not hide a copy.
 * @param {string} source - raw Python source.
 * @returns {string[]} normalised tokens.
 */
function bodyTokens(source) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\\') {
      index += 1;
      continue;
    }
    if (char === '#') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char + char + char, index);
      const quote = triple ? char + char + char : char;
      let cursor = index + quote.length;
      while (cursor < text.length) {
        if (text[cursor] === '\\') cursor += 2;
        else if (text.startsWith(quote, cursor)) {
          cursor += quote.length;
          break;
        } else cursor += 1;
      }
      // A string that opens a statement and ends its line is a docstring: it
      // documents the code, so it must not make two copies look different.
      let before = index - 1;
      while (before >= 0 && (text[before] === ' ' || text[before] === '\t')) before -= 1;
      const newline = text.indexOf('\n', cursor);
      const tail = text.slice(cursor, newline === -1 ? text.length : newline).trim();
      const opensStatement = before < 0 || text[before] === '\n';
      if (opensStatement && (tail.length === 0 || tail.startsWith('#'))) {
        index = cursor;
        continue;
      }
      tokens.push('S');
      index = cursor;
      continue;
    }
    NUMBER_RE.lastIndex = index;
    const number = NUMBER_RE.exec(text);
    if (number !== null) {
      tokens.push('N');
      index = NUMBER_RE.lastIndex;
      continue;
    }
    IDENTIFIER_RE.lastIndex = index;
    const identifier = IDENTIFIER_RE.exec(text);
    if (identifier !== null) {
      tokens.push(identifier[0].toLowerCase());
      index = IDENTIFIER_RE.lastIndex;
      continue;
    }
    if (OPERATOR_CHARS.has(char)) tokens.push(char);
    index += 1;
  }
  return tokens;
}

/**
 * Build the similarity signature of one Python body: the normalised token count
 * plus the bottom-48 5-gram MinHash sketch that `dupes`/`similar` compare with a
 * Jaccard score. Fewer than 12 tokens cannot produce a stable sketch, so the
 * shingles stay empty and the body never clusters with anything.
 * @param {string} text - Python source (a method body, or any fragment).
 * @returns {{ tokens: number, shingles: number[] }} token count and ascending 5-gram hashes.
 */
export function shingleSignature(text) {
  const tokens = bodyTokens(text);
  if (tokens.length < SHINGLE_MIN_TOKENS) return { tokens: tokens.length, shingles: [] };
  const hashes = new Set();
  for (let index = 0; index + SHINGLE_SIZE <= tokens.length; index += 1) {
    let key = tokens[index];
    for (let offset = 1; offset < SHINGLE_SIZE; offset += 1) key += `\u0001${tokens[index + offset]}`;
    hashes.add(fnv1a32(key));
  }
  const shingles = [...hashes].sort((left, right) => left - right).slice(0, SHINGLE_LIMIT);
  return { tokens: tokens.length, shingles };
}

/** Extract quoted strings from a text fragment. */
function stringsOf(text) {
  const out = [];
  const pattern = /['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) out.push(match[1]);
  return out;
}

/** Read one class-level assignment value, including bracketed continuations. */
function assignmentValue(bodyLines, attribute) {
  const start = bodyLines.findIndex((line) => new RegExp(`^\\s*${attribute}\\s*=`).test(line));
  if (start === -1) return '';
  const collected = [];
  let depth = 0;
  for (let index = start; index < bodyLines.length && index < start + 40; index += 1) {
    const line = stripComment(bodyLines[index]);
    collected.push(line);
    for (const char of line) {
      if (char === '[' || char === '{' || char === '(') depth += 1;
      else if (char === ']' || char === '}' || char === ')') depth -= 1;
    }
    if (depth <= 0 && index > start) break;
    if (depth <= 0 && index === start) break;
  }
  return collected.join('\n');
}

/** Split a class base list on top-level commas. */
function splitBases(text) {
  const bases = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '[' || char === '(' || char === '{') depth += 1;
    else if (char === ']' || char === ')' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      bases.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) bases.push(current.trim());
  return bases.filter((base) => base.length > 0);
}

/**
 * Extract the argument list of a method from its definition lines (including
 * multi-line signatures). Returns text without the surrounding parentheses.
 * @param {string[]} lines - method lines starting at the `def` line.
 * @returns {string} normalized arguments.
 */
function signatureOf(lines) {
  let full = '';
  for (const raw of lines) {
    full += `${full.length > 0 ? ' ' : ''}${stripComment(raw)}`;
    const open = full.indexOf('(');
    if (open === -1) continue;
    let depth = 0;
    let closed = -1;
    for (let index = open; index < full.length; index += 1) {
      const char = full[index];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          closed = index;
          break;
        }
      }
    }
    if (closed !== -1) return full.slice(open + 1, closed).replace(/\s+/g, ' ').trim();
    if (!full.includes('def') || full.length > 2_000) break;
  }
  return '';
}

/** Extract `super()` targets with their source line. */
function superCallsOf(lines, startLine) {
  const out = [];
  const pattern = /super\s*\(\s*(?:([A-Za-z_][\w.]*)\s*,\s*self\s*)?\)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
  for (let index = 0; index < lines.length; index += 1) {
    const code = stripComment(lines[index]);
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(code)) !== null) {
      out.push({
        name: match[2],
        cls: match[1] ?? '',
        line: startLine + index,
      });
    }
  }
  return out;
}

/** Extract textual call sites (name + line) from method body lines. */
function callsOf(lines, startLine) {
  const out = [];
  const seen = new Set();
  const pattern = /(?:\.\s*|(?<![\w.]))([A-Za-z_]\w*)\s*\(/g;
  for (let index = 0; index < lines.length; index += 1) {
    const code = stripComment(lines[index]);
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(code)) !== null) {
      const name = match[1];
      if (KEYWORDS.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, line: startLine + index, text: code.trim().slice(0, 160) });
      if (out.length >= CALL_CAP_PER_METHOD) return out;
    }
  }
  return out;
}

/** Split a text fragment at top-level commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== '') {
      current += char;
      if (char === '\\') {
        index += 1;
        if (index < text.length) current += text[index];
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/** Convert one Python literal fragment to a compact display value. */
function literalValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.length === 0) return '';
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}

/** Collect a parenthesized argument list starting at one class-body line. */
function collectArguments(lines, startIndex) {
  let text = '';
  let depth = 0;
  let opened = false;
  for (let index = startIndex; index < lines.length && index < startIndex + 80; index += 1) {
    const line = stripComment(lines[index]);
    text += `${text.length > 0 ? '\n' : ''}${line}`;
    let quote = '';
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      const char = line[cursor];
      if (quote !== '') {
        if (char === '\\') cursor += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === "'" || char === '"') quote = char;
      else if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        opened = true;
      } else if (char === ')' || char === ']' || char === '}') depth -= 1;
    }
    if (opened && depth <= 0) return { text, endIndex: index };
  }
  return { text, endIndex: lines.length - 1 };
}

/**
 * Parse one declared Selection literal (`[('draft', 'Draft'), ('done', 'Done')]`)
 * into [value, label] pairs, so a preview can print the label a record would
 * actually show. Function-backed selections (`selection=_compute_selection`)
 * are not literals and yield null.
 * @param {unknown} raw - attribute text as the Python parser stored it.
 * @returns {Array<[string, string]> | null} pairs, or null when not a literal.
 */
export function parseSelectionLiteral(raw) {
  const source = String(raw ?? '').trim();
  if (!source.startsWith('[') || !source.endsWith(']')) return null;
  const pairs = [];
  const pattern = /\(\s*(['"])([\s\S]*?)\1\s*,\s*(['"])([\s\S]*?)\3\s*\)/g;
  let match = pattern.exec(source);
  while (match !== null && pairs.length < 60) {
    pairs.push([match[2], match[4]]);
    match = pattern.exec(source);
  }
  return pairs.length > 0 ? pairs : null;
}

/** Parse one `fields.X(...)` field declaration into metadata. */
function parseFieldDeclaration(name, type, keywordText, line) {
  const attrs = Object.create(null);
  const positional = [];
  for (const part of splitTopLevel(keywordText)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const equals = /^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(trimmed);
    if (equals !== null) attrs[equals[1]] = literalValue(equals[2]);
    else positional.push(literalValue(trimmed));
  }
  const comodel = attrs.comodel_name ?? (['Many2one', 'One2many', 'Many2many', 'Many2oneReference'].includes(type) ? positional[0] ?? '' : '');
  const selected = ['string', 'help', 'compute', 'related', 'default', 'selection', 'domain', 'groups', 'ondelete', 'inverse', 'search', 'tracking', 'index', 'required', 'readonly', 'store', 'company_dependent', 'delegate', 'precompute'];
  const clean = Object.create(null);
  for (const key of selected) {
    if (attrs[key] !== undefined) clean[key] = attrs[key];
  }
  // `fields.Selection([('a', 'A')])` passes its list positionally; keep it so
  // the same selection labels are available as with `selection=[...]`.
  if (type === 'Selection' && clean.selection === undefined) {
    const positionalSelection = positional.find((entry) => entry.trim().startsWith('['));
    if (positionalSelection !== undefined) clean.selection = positionalSelection;
  }
  return {
    name,
    fieldType: type,
    line,
    comodel,
    // `One2many('comodel', 'inverse_id')` passes the reverse field positionally;
    // that second argument was dropped before and relation checks now need it.
    inverse: attrs.inverse_name ?? (type === 'One2many' ? positional[1] ?? '' : ''),
    attrs: clean,
    string: clean.string ?? '',
  };
}

/**
 * Parse one Python file into classes, module functions, methods and call sites.
 * @param {string} text - file source.
 * @param {{ moduleName?: string, filePath?: string }} [options] - labels.
 * @returns {{ classes: Array<object>, functions: Array<object>, warnings: Array<string> }} parsed file.
 */
export function parsePythonFile(text, options = {}) {
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = src.split(/\r?\n/);
  const bounded = lines.length > LINE_CAP ? lines.slice(0, LINE_CAP) : lines;
  const structural = maskPythonSource(bounded);
  const codeLines = structural.masked;
  const continuation = structural.continuation;
  const classes = [];
  const functions = [];
  const warnings = [];
  const moduleName = typeof options.moduleName === 'string' ? options.moduleName : '';
  const filePath = typeof options.filePath === 'string' ? options.filePath : '';

  const classMatches = (line) => /^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/.exec(line);
  const defMatches = (line) => /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);

  /** Close one class block and extract its attributes and immediate methods. */
  const finalizeClass = (entry) => {
    const baseLine = entry.line + 1;
    const body = entry.bodyLines;
    const nameValue = assignmentValue(body, '_name');
    const inheritValue = assignmentValue(body, '_inherit');
    const inheritsValue = assignmentValue(body, '_inherits');
    const nameModel = stringsOf(nameValue)[0] ?? '';
    const inherits = stringsOf(inheritValue);
    const inheritedMap = {};
    const pairPattern = /['"]([\w.]+)['"]\s*:\s*['"]([\w.]+)['"]/g;
    let pair;
    while ((pair = pairPattern.exec(inheritsValue)) !== null) inheritedMap[pair[1]] = pair[2];
    const model = nameModel || inherits[0] || '';
    const fields = [];
    const description = stringsOf(assignmentValue(body, '_description'))[0] ?? '';
    const order = stringsOf(assignmentValue(body, '_order'))[0] ?? '';
    const recName = stringsOf(assignmentValue(body, '_rec_name'))[0] ?? '';
    const table = stringsOf(assignmentValue(body, '_table'))[0] ?? '';
    const parentName = stringsOf(assignmentValue(body, '_parent_name'))[0] ?? '';
    const methods = [];
    let methodIndent = -1;
    let current = null;
    let lastContentLine = entry.line;
    let pendingDecorators = [];

    const closeMethod = (endLine) => {
      if (current === null) return;
      current.endLine = endLine;
      current.args = signatureOf(current.rawAll);
      const bodyLines = current.rawBody.filter((line) => line.trim().length > 0);
      if (bodyLines.length === 0) {
        const emptySource = current.rawAll.filter((line) => line.trim().length > 0);
        current.sourceLines = emptySource;
      } else {
        current.sourceLines = current.rawAll;
      }
      current.superCalls = superCallsOf(current.rawAll.slice(1), current.line + 1);
      current.calls = callsOf(current.rawBody, current.bodyLine);
      // Similarity is compared on the body only: two overrides that share logic
      // under different method names are exactly what `dupes` must surface.
      const bodySignature = shingleSignature(current.rawBody.join('\n'));
      current.tokens = bodySignature.tokens;
      current.shingles = bodySignature.shingles;
      current.decorators = current.decorators.filter((line) => line.trim().length > 0);
      delete current.rawBody;
      delete current.rawAll;
      delete current.bodyLine;
      methods.push(current);
      current = null;
    };

    for (let index = 0; index < body.length; index += 1) {
      const line = body[index];
      const absolute = baseLine + index;
      const code = codeLines[absolute - 1] ?? line;
      const trimmed = code.trim();
      if (trimmed.length === 0) {
        if (current !== null) {
          current.rawAll.push(line);
          current.rawBody.push(line);
        }
        continue;
      }
      const indent = indentOf(code);
      const isContinuation = continuation[absolute - 1] === true;
      if (current !== null && isContinuation) {
        current.rawAll.push(line);
        current.rawBody.push(line);
        lastContentLine = absolute;
        continue;
      }
      if (current === null && isContinuation) continue;
      if (current === null) {
        if (methodIndent >= 0 && indent < methodIndent) {
          // A class-level statement after methods (field, SQL constraint, ...).
          pendingDecorators = [];
          continue;
        }
        const fieldMatch = /^([A-Za-z_]\w*)\s*=\s*fields\.([A-Za-z_]\w*)\s*\(/.exec(trimmed);
        if (fieldMatch !== null && indent > entry.indent && (methodIndent === -1 || indent === methodIndent)) {
          const collected = collectArguments(body, index);
          const openIndex = collected.text.indexOf('(');
          const keywordText = openIndex === -1 ? '' : collected.text.slice(openIndex + 1, Math.max(collected.text.lastIndexOf(')'), openIndex + 1));
          fields.push(parseFieldDeclaration(fieldMatch[1], fieldMatch[2], keywordText, absolute));
          index = collected.endIndex;
          continue;
        }
        const def = defMatches(trimmed);
        if (def !== null && indent > entry.indent) {
          if (methodIndent === -1) methodIndent = indent;
          if (indent !== methodIndent) continue;
          if (methods.length >= METHOD_CAP_PER_CLASS) {
            warnings.push(`${filePath}:${absolute}: method cap reached`);
            break;
          }
          current = {
            name: def[1],
            line: absolute,
            endLine: absolute,
            decorators: pendingDecorators,
            args: '',
            rawAll: [line],
            rawBody: [],
            bodyLine: absolute + 1,
            class: entry.name,
            model,
            module: moduleName,
            file: filePath,
          };
          pendingDecorators = [];
          lastContentLine = absolute;
          continue;
        }
        if (trimmed.startsWith('@')) {
          if (code.includes('(')) {
            const collected = collectArguments(body, index);
            pendingDecorators.push(collected.text.replace(/\s+/g, ' ').trim());
            index = collected.endIndex;
          } else {
            pendingDecorators.push(line.trim());
          }
          continue;
        }
        pendingDecorators = [];
        continue;
      }
      // Inside a method: collect signature continuation and body.
      if (indent <= methodIndent) {
        const def = defMatches(trimmed);
        if (def !== null) {
          current.endLine = lastContentLine;
          closeMethod(lastContentLine);
          methodIndent = indent;
          current = {
            name: def[1],
            line: absolute,
            endLine: absolute,
            decorators: pendingDecorators,
            args: '',
            rawAll: [line],
            rawBody: [],
            bodyLine: absolute + 1,
            class: entry.name,
            model,
            module: moduleName,
            file: filePath,
          };
          pendingDecorators = [];
          lastContentLine = absolute;
          continue;
        }
        // Class-level statement (indent <= method indent, not a def): method ends.
        current.endLine = lastContentLine;
        closeMethod(lastContentLine);
        const lateField = /^([A-Za-z_]\w*)\s*=\s*fields\.([A-Za-z_]\w*)\s*\(/.exec(trimmed);
        if (lateField !== null && indent > entry.indent) {
          const collected = collectArguments(body, index);
          const openIndex = collected.text.indexOf('(');
          const keywordText = openIndex === -1 ? '' : collected.text.slice(openIndex + 1, Math.max(collected.text.lastIndexOf(')'), openIndex + 1));
          fields.push(parseFieldDeclaration(lateField[1], lateField[2], keywordText, absolute));
          index = collected.endIndex;
          continue;
        }
        if (trimmed.startsWith('@')) {
          if (code.includes('(')) {
            const collected = collectArguments(body, index);
            pendingDecorators.push(collected.text.replace(/\s+/g, ' ').trim());
            index = collected.endIndex;
          } else {
            pendingDecorators.push(line.trim());
          }
        }
        continue;
      }
      current.rawAll.push(line);
      current.rawBody.push(line);
      lastContentLine = absolute;
    }
    if (current !== null) closeMethod(lastContentLine);

    classes.push({
      name: entry.name,
      bases: entry.bases,
      line: entry.line,
      model,
      nameModel,
      inherits,
      inheritedMap,
      description,
      order,
      recName,
      table,
      parentName,
      module: moduleName,
      file: filePath,
      fields,
      methods,
      decorators: entry.decorators,
    });
  };

  let currentClass = null;
  let pendingDecorators = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const line = bounded[index];
    const code = codeLines[index] ?? line;
    const trimmed = code.trim();
    const isContinuation = continuation[index] === true;
    if (trimmed.length === 0) {
      if (currentClass !== null) currentClass.bodyLines.push(line);
      continue;
    }
    if (currentClass !== null && isContinuation) {
      currentClass.bodyLines.push(line);
      continue;
    }
    const indent = indentOf(code);
    if (currentClass !== null && indent <= currentClass.indent) {
      finalizeClass(currentClass);
      currentClass = null;
    }
    const classMatch = classMatches(trimmed);
    if (classMatch !== null) {
      if (currentClass !== null) finalizeClass(currentClass);
      currentClass = {
        name: classMatch[1],
        bases: splitBases(classMatch[2] ?? ''),
        line: index + 1,
        indent,
        bodyLines: [],
        decorators: pendingDecorators,
      };
      pendingDecorators = [];
      continue;
    }
    if (currentClass !== null) {
      currentClass.bodyLines.push(line);
      continue;
    }
    if (trimmed.startsWith('@')) {
      pendingDecorators.push(line.trim());
      continue;
    }
    const def = defMatches(trimmed);
    if (def !== null) {
      let lastContent = index;
      for (let next = index + 1; next < bounded.length; next += 1) {
        const nextTrimmed = bounded[next].trim();
        if (nextTrimmed.length === 0 || nextTrimmed.startsWith('#')) continue;
        if (indentOf(bounded[next]) <= indent) break;
        lastContent = next;
      }
      const fnLines = bounded.slice(index, lastContent + 1);
      const fnSignature = shingleSignature(fnLines.slice(1).join('\n'));
      functions.push({
        name: def[1],
        line: index + 1,
        endLine: lastContent + 1,
        args: signatureOf(fnLines),
        decorators: pendingDecorators,
        class: '',
        model: '',
        module: moduleName,
        file: filePath,
        tokens: fnSignature.tokens,
        shingles: fnSignature.shingles,
        calls: callsOf(fnLines.slice(1), index + 2),
        superCalls: superCallsOf(fnLines.slice(1), index + 2),
      });
      pendingDecorators = [];
      index = lastContent;
      continue;
    }
    pendingDecorators = [];
  }
  if (currentClass !== null) finalizeClass(currentClass);
  if (src.length === 0) warnings.push(`${filePath}: empty file`);
  return { classes, functions, warnings };
}

export default { parsePythonFile, parseSelectionLiteral, shingleSignature };

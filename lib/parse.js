/**
 * Tolerant, dependency-free parser for Odoo view XML files.
 *
 * Public API (keep exactly these three exports):
 *   parseViewFile(text, options) -> { views, otherRecordCount, warnings }
 *   indexViewFile(text, options) -> { views, otherRecordCount }
 *   parseArch(archText)          -> { root, fields, xpaths, error? }
 *
 * Design notes:
 *  - Plain ESM, zero dependencies, Node >= 22.
 *  - A hand-written scanner is used instead of a DOM parser because the real
 *    corpus contains quirks that strict XML parsers reject: unescaped '&' in
 *    attribute values, boolean-like attributes without values, QWeb `{% %}`,
 *    CDATA sections, comments containing markup, and (rarely) malformed files.
 *  - Nothing here throws on malformed input: the parsers return whatever could
 *    be recovered, plus warnings where a warning channel exists.
 *  - indexViewFile never builds preview trees; it only needs the arch root tag
 *    so that it stays fast across the whole addons corpus.
 */

/** Maximum number of characters of an arch string that parseArch will look at. */
const MAX_ARCH_CHARS = 1024 * 1024; // 1 MiB
/** Maximum number of preview nodes per parseArch call (root included). */
const MAX_PREVIEW_NODES = 6000;
/** Maximum preview tree depth, root = depth 0 (so at most 64 nested levels). */
const MAX_PREVIEW_DEPTH = 64;
/** Maximum characters kept for one record field value (domain, context, help). */
const MAX_RECORD_FIELD_CHARS = 8_000;
/** Maximum number of action records reported per file (both parse paths). */
const MAX_ACTIONS_PER_FILE = 200;
/** Maximum number of xpath locators reported per arch. */
const MAX_LOCATORS = 400;
/** Maximum call sites kept per view; a form with more is not a usable call report. */
const MAX_VIEW_CALLS = 200;
/** Maximum identifiers kept for one server-action code body. */
const MAX_ACTION_CALLS = 60;

/** A python name, the only button/function names that can be a method. */
const CALL_NAME_RE = /^[A-Za-z_]\w*$/;

/** Python keywords, so `if (x)` never looks like a call to `if`. */
const PY_KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'return', 'and', 'or', 'not', 'in', 'is',
  'lambda', 'with', 'assert', 'raise', 'yield', 'except', 'finally', 'try', 'def',
  'class', 'from', 'import', 'as', 'del', 'global', 'nonlocal', 'pass', 'break',
  'continue', 'await', 'async',
]);

/**
 * Window-action record models this parser understands. The key is the Odoo
 * model, the value is the stable kind reported to the index/UI.
 */
const ACTION_MODEL_KINDS = new Map([
  ['ir.actions.act_window', 'window'],
  ['ir.actions.act_window.view', 'windowView'],
  // Server actions carry an inline Python body, the only call site that exists
  // in neither a Python file nor a view arch. They are indexed separately so the
  // Actions panel keeps listing window actions only.
  ['ir.actions.server', 'server'],
]);

/** arch root tag -> normalized view type. `tree` is the legacy `list` spelling. */
const VIEW_TYPE_BY_ROOT_TAG = new Map([
  ['form', 'form'],
  ['list', 'list'],
  ['tree', 'list'],
  ['kanban', 'kanban'],
  ['search', 'search'],
  ['graph', 'graph'],
  ['pivot', 'pivot'],
  ['calendar', 'calendar'],
  ['activity', 'activity'],
  ['qweb', 'qweb'],
  ['map', 'map'],
  ['cohort', 'cohort'],
  ['gantt', 'gantt'],
  ['hierarchy', 'hierarchy'],
  ['ranking', 'ranking'],
]);

// ---------------------------------------------------------------------------
// Character / entity helpers
// ---------------------------------------------------------------------------

function isWhitespaceCode(code) {
  // space, \t, \n, \r, \f
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isNameStartCode(code) {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 58 // :
  );
}

function isNameCode(code) {
  return (
    isNameStartCode(code) ||
    (code >= 48 && code <= 57) || // 0-9
    code === 45 || // -
    code === 46 // .
  );
}

/** XML entities: the five predefined ones plus decimal/hex character refs. */
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#X[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;

function decodeEntities(value) {
  if (value.indexOf('&') === -1) return value;
  return value.replace(ENTITY_RE, (match, body) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const hex = body[1] === 'x' || body[1] === 'X';
    const codePoint = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeNewlines(text) {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// Low level tag scanning
// ---------------------------------------------------------------------------

/**
 * Given the index of a '<', find the index of the closing '>' of that tag while
 * skipping over quoted attribute values (which may legitimately contain '>').
 * Returns -1 when the tag is unterminated.
 */
function skipToTagEnd(src, lt) {
  const n = src.length;
  let quote = 0;
  for (let i = lt + 1; i < n; i++) {
    const code = src.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      continue;
    }
    if (code === 62) return i; // '>'
  }
  return -1;
}

/**
 * Skip a comment, CDATA section, processing instruction or <!...> declaration.
 * `src[lt]` must be '<' and `src[lt + 1]` must be '!' or '?'.
 * Always returns an index greater than `lt` (src.length when unterminated).
 */
function skipMarkup(src, lt) {
  const n = src.length;
  const code = src.charCodeAt(lt + 1);
  if (code === 33) {
    // '!'
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      return end === -1 ? n : end + 3;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      return end === -1 ? n : end + 3;
    }
    const end = src.indexOf('>', lt + 2);
    return end === -1 ? n : end + 1;
  }
  // '?'
  const end = src.indexOf('?>', lt + 2);
  return end === -1 ? n : end + 2;
}

/**
 * Tolerant attribute parser. Accepts single/double quoted values, unquoted
 * values, and boolean-like attributes without a value (stored as '').
 * Attribute values are entity-decoded.
 */
function parseAttrs(raw) {
  const attrs = {};
  const n = raw.length;
  let i = 0;
  while (i < n) {
    while (i < n && isWhitespaceCode(raw.charCodeAt(i))) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n) {
      const code = raw.charCodeAt(i);
      if (isWhitespaceCode(code) || code === 61 || code === 47) break;
      i++;
    }
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = raw.slice(nameStart, i);
    while (i < n && isWhitespaceCode(raw.charCodeAt(i))) i++;
    let value = '';
    if (i < n && raw.charCodeAt(i) === 61) {
      // '='
      i++;
      while (i < n && isWhitespaceCode(raw.charCodeAt(i))) i++;
      if (i < n) {
        const quote = raw.charCodeAt(i);
        if (quote === 34 || quote === 39) {
          const valueStart = ++i;
          while (i < n && raw.charCodeAt(i) !== quote) i++;
          value = raw.slice(valueStart, i);
          if (i < n) i++;
        } else {
          const valueStart = i;
          while (i < n && !isWhitespaceCode(raw.charCodeAt(i)) && raw.charCodeAt(i) !== 47) i++;
          value = raw.slice(valueStart, i);
        }
      }
    }
    if (name !== '__proto__' && !Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Read an opening tag starting at '<'.
 * `nameEnd`/`attrsEnd` delimit the raw attribute region, which lets callers
 * parse attributes lazily (the fast index path only needs it for <field> tags).
 * @returns {{name: string, selfClosing: boolean, end: number, nameEnd: number,
 *            attrsEnd: number, attrs?: object}|null}
 */
function readTag(src, lt, withAttrs) {
  const n = src.length;
  let i = lt + 1;
  while (i < n && isWhitespaceCode(src.charCodeAt(i))) i++;
  const nameStart = i;
  while (i < n && isNameCode(src.charCodeAt(i))) i++;
  if (i === nameStart) return null;
  const name = src.slice(nameStart, i);

  const nameEnd = i;
  let quote = 0;
  let end = -1;
  for (let j = i; j < n; j++) {
    const code = src.charCodeAt(j);
    if (quote) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      continue;
    }
    if (code === 62) {
      end = j;
      break;
    }
  }
  if (end === -1) return null;

  let last = end - 1;
  while (last > i && isWhitespaceCode(src.charCodeAt(last))) last--;
  const selfClosing = last >= i && src.charCodeAt(last) === 47;
  const attrsEnd = selfClosing ? last : end;
  const tag = { name, selfClosing, end: end + 1, nameEnd, attrsEnd };
  if (withAttrs) tag.attrs = parseAttrs(src.slice(nameEnd, attrsEnd));
  return tag;
}

/**
 * Read a closing tag starting at '<' (i.e. src[lt + 1] === '/').
 * @returns {{name: string, end: number}|null}
 */
function readCloseTag(src, lt) {
  const n = src.length;
  let i = lt + 2;
  while (i < n && isWhitespaceCode(src.charCodeAt(i))) i++;
  const nameStart = i;
  while (i < n && isNameCode(src.charCodeAt(i))) i++;
  if (i === nameStart) return null;
  const gt = skipToTagEnd(src, lt);
  if (gt === -1) return null;
  return { name: src.slice(nameStart, i), end: gt + 1 };
}

/**
 * Find where an element ends, using name-based depth counting. Comments, CDATA
 * sections, processing instructions and self-closing tags are respected, so
 * markup that merely *looks* like the element's close tag cannot end it.
 *
 * @param {string} src
 * @param {number} from index right after the opening tag's '>'
 * @param {string} nameLower lowercased tag name of the element being matched
 * @returns {{innerEnd: number, end: number, closed: boolean}}
 */
function scanElementEnd(src, from, nameLower) {
  const n = src.length;
  let depth = 1;
  let i = from;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      // '!' or '?'
      i = skipMarkup(src, lt);
      continue;
    }
    if (code === 47) {
      // '/'
      const close = readCloseTag(src, lt);
      if (!close) {
        i = lt + 2;
        continue;
      }
      if (close.name.toLowerCase() === nameLower) {
        depth--;
        if (depth === 0) return { innerEnd: lt, end: close.end, closed: true };
      }
      i = close.end;
      continue;
    }
    const tag = readTag(src, lt, false);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    if (!tag.selfClosing && tag.name.toLowerCase() === nameLower) depth++;
    i = tag.end;
  }
  return { innerEnd: n, end: n, closed: false };
}

// ---------------------------------------------------------------------------
// Text / indentation helpers
// ---------------------------------------------------------------------------

function lineAt(src, pos) {
  let line = 1;
  for (let i = 0; i < pos; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/** Number of characters between the start of the line and `pos`. */
function indentAt(src, pos) {
  let i = pos;
  while (i > 0 && src.charCodeAt(i - 1) !== 10) i--;
  return pos - i;
}

/**
 * Extract the text value of a small data field (name, model, inherit_id, ...).
 * Comments are removed, CDATA is unwrapped verbatim, stray tags are dropped and
 * entities are decoded. This is *not* used for arch bodies.
 */
function simpleText(raw) {
  if (!raw) return '';
  let text = raw;
  if (text.indexOf('<!--') !== -1) text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  let cdata = null;
  if (text.indexOf('<![CDATA[') !== -1) {
    const parts = [];
    text = text.replace(/<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g, (_match, body) => {
      parts.push(body);
      return `\u0000${parts.length - 1}\u0000`;
    });
    cdata = parts;
  }
  if (text.indexOf('<') !== -1) text = text.replace(/<[^>]*>/g, '');
  if (cdata) text = text.replace(/\u0000(\d+)\u0000/g, (_match, index) => cdata[Number(index)] ?? '');
  return decodeEntities(text).trim();
}

/**
 * Dedent an inner XML block (arch body / template body): drop leading and
 * trailing blank lines, then remove the common indentation of the content.
 */
function dedentBlock(raw) {
  if (!raw) return '';
  let text = normalizeNewlines(raw);
  let lines = text.split('\n');
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && !lines[first].trim()) first++;
  while (last >= first && !lines[last].trim()) last--;
  if (first > last) return '';
  lines = lines.slice(first, last + 1);

  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)[0].length;
    if (indent < min) min = indent;
  }
  if (!Number.isFinite(min)) return '';

  // When the block starts on the same line as the opening tag, the first line
  // has no indentation; in that case dedent the remaining lines by their own
  // common indentation so nested markup keeps its relative shape.
  let base = min;
  if (base === 0 && lines.length > 1 && lines[0].trim()) {
    let nested = Infinity;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const indent = /^[ \t]*/.exec(lines[i])[0].length;
      if (indent < nested) nested = indent;
    }
    if (Number.isFinite(nested) && nested > 0) base = nested;
  }

  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      out[i] = '';
      continue;
    }
    const indent = /^[ \t]*/.exec(line)[0].length;
    out[i] = line.slice(Math.min(base, indent));
  }
  return out.join('\n').trimEnd();
}

/**
 * Dedent the raw source of an element. The first line already starts at the
 * element's '<' so only the following lines need the document indentation
 * (`base`, the column of the opener) removed.
 */
function dedentSource(raw, base) {
  if (!raw) return '';
  const lines = normalizeNewlines(raw).split('\n');
  const out = new Array(lines.length);
  out[0] = lines[0].replace(/^[ \t]+/, '');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      out[i] = '';
      continue;
    }
    const indent = /^[ \t]*/.exec(line)[0].length;
    out[i] = line.slice(Math.min(base, indent));
  }
  while (out.length > 1 && !out[out.length - 1]) out.pop();
  return out.join('\n').trimEnd();
}

/**
 * Find the lowercased name of the first element tag inside a region, skipping
 * whitespace, comments, CDATA, processing instructions and close tags.
 * Returns '' when the region has no element.
 */
function firstTagName(src, start, end) {
  let i = start;
  while (i < end) {
    const lt = src.indexOf('<', i);
    if (lt === -1 || lt >= end) return '';
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      const next = skipMarkup(src, lt);
      if (next <= lt) return '';
      i = next;
      continue;
    }
    if (code === 47) {
      const close = readCloseTag(src, lt);
      i = close ? close.end : lt + 2;
      continue;
    }
    const tag = readTag(src, lt, false);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    return tag.name.toLowerCase();
  }
  return '';
}

/**
 * Ordered unique <field name="..."> names inside a region. This mirrors the
 * field collection done by parseArch (same ordering/dedupe rules) without
 * building a preview tree, so the index path stays fast. Only <field> tags get
 * their attributes parsed.
 */
function collectFieldNames(src, start, end) {
  const names = [];
  const seen = new Set();
  const limit = Math.min(end, start + MAX_ARCH_CHARS);
  let i = start;
  while (i < limit) {
    const lt = src.indexOf('<', i);
    if (lt === -1 || lt >= limit) break;
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      i = skipMarkup(src, lt);
      continue;
    }
    if (code === 47) {
      const close = readCloseTag(src, lt);
      i = close ? close.end : lt + 2;
      continue;
    }
    const tag = readTag(src, lt, false);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    if (tag.name.toLowerCase() === 'field') {
      const attrs = parseAttrs(src.slice(tag.nameEnd, tag.attrsEnd));
      const fieldName = attrs.name;
      if (fieldName && !seen.has(fieldName)) {
        seen.add(fieldName);
        names.push(fieldName);
      }
    }
    i = tag.end;
  }
  return names;
}

function normalizeViewType(rawType) {
  if (!rawType) return 'unknown';
  return VIEW_TYPE_BY_ROOT_TAG.get(rawType) || 'unknown';
}

/**
 * Collect the Python methods one view arch calls: `<button name="…">` with no
 * type or `type="object"`, plus `<function name="…"/>`.
 *
 * A call site is invisible to a Python-only scan, which is exactly why
 * "who calls this method" had to be grepped across XML. The scan walks the arch
 * once (never tags × tags) and reports absolute file lines, so a hit opens at
 * its real position instead of an arch-relative one.
 * @param {string} src - whole file text.
 * @param {number} start - absolute offset where the arch body starts.
 * @param {number} end - absolute offset where the arch body ends.
 * @returns {Array<{ name: string, tag: string, type: string, line: number }>} call sites in document order.
 */
function collectViewCalls(src, start, end) {
  const calls = [];
  const limit = Math.min(end, start + MAX_ARCH_CHARS);
  let i = start;
  while (i < limit && calls.length < MAX_VIEW_CALLS) {
    const lt = src.indexOf('<', i);
    if (lt === -1 || lt >= limit) break;
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      i = skipMarkup(src, lt);
      continue;
    }
    if (code === 47) {
      const close = readCloseTag(src, lt);
      i = close ? close.end : lt + 2;
      continue;
    }
    const tag = readTag(src, lt, false);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    const tagName = tag.name.toLowerCase();
    if (tagName === 'button' || tagName === 'function') {
      const attrs = parseAttrs(src.slice(tag.nameEnd, tag.attrsEnd));
      const name = typeof attrs.name === 'string' ? attrs.name : '';
      const type = typeof attrs.type === 'string' ? attrs.type.trim() : '';
      // `type="action"|"edit"|"delete"|"workflow"|"set"` runs no record method,
      // so only an absent or `object` type is a Python call site.
      const objectButton = tagName === 'function' || type.length === 0 || type === 'object';
      if (objectButton && name.length > 0 && (tagName === 'function' || CALL_NAME_RE.test(name))) {
        calls.push({ name, tag: tagName, type, line: lineAt(src, lt) });
      }
    }
    i = tag.end;
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Top level record scan
// ---------------------------------------------------------------------------

/**
 * Scan a whole data file for <record> / <template> elements. When one is found
 * its matching close tag is located and scanning continues after it, so nested
 * markup is never reported twice.
 *
 * @returns {{items: Array<object>, problems: Array<{line: number, message: string}>}}
 */
function scanTopLevelRecords(src) {
  const items = [];
  const problems = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let linePos = 0;

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      // '!' or '?'
      i = skipMarkup(src, lt);
      continue;
    }
    if (code === 47) {
      // '/' — a close tag at file level (or a stray one): skip it
      const close = readCloseTag(src, lt);
      i = close ? close.end : lt + 2;
      continue;
    }
    const tag = readTag(src, lt, true);
    if (!tag) {
      if (skipToTagEnd(src, lt) === -1) {
        problems.push({ line: lineAt(src, lt), message: 'unterminated XML tag' });
        break;
      }
      i = lt + 1;
      continue;
    }
    const nameLower = tag.name.toLowerCase();
    if (nameLower !== 'record' && nameLower !== 'template') {
      i = tag.end;
      continue;
    }

    // Track the opener line incrementally (cheap: one pass over the file).
    for (let k = linePos; k < lt; k++) if (src.charCodeAt(k) === 10) line++;
    linePos = lt;

    let innerStart;
    let innerEnd;
    let end;
    let closed = true;
    if (tag.selfClosing) {
      innerStart = tag.end;
      innerEnd = tag.end;
      end = tag.end;
    } else {
      const bounds = scanElementEnd(src, tag.end, nameLower);
      innerStart = tag.end;
      innerEnd = bounds.innerEnd;
      end = bounds.end;
      closed = bounds.closed;
    }
    items.push({ tag, start: lt, line, innerStart, innerEnd, end, closed });
    i = end;
  }

  return { items, problems };
}

/**
 * Extract the data fields of an <record model="ir.ui.view"> element.
 * Only direct <field> children are inspected; their subtrees are skipped so
 * nested markup can never be mistaken for a record-level field.
 */
function extractRecordMeta(src, item) {
  const attrs = item.tag.attrs || {};
  const meta = {
    id: attrs.id || '',
    name: attrs.name || '',
    model: '',
    inheritId: attrs.inherit_id || '',
    priority: attrs.priority || '',
    // An explicit `<field name="mode">primary</field>` turns an inheriting
    // record into a new primary view instead of an extension of its parent
    // (Odoo keeps it out of the parent's rendered inheritor list).
    mode: '',
    archStart: -1,
    archEnd: -1,
  };
  if (item.tag.selfClosing) return meta;

  let i = item.innerStart;
  const end = item.innerEnd;
  while (i < end) {
    const lt = src.indexOf('<', i);
    if (lt === -1 || lt >= end) break;
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      i = skipMarkup(src, lt);
      continue;
    }
    if (code === 47) {
      const close = readCloseTag(src, lt);
      i = close ? close.end : lt + 2;
      continue;
    }
    const tag = readTag(src, lt, true);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    const nameLower = tag.name.toLowerCase();
    const tagAttrs = tag.attrs || {};
    if (tag.selfClosing) {
      if (nameLower === 'field') {
        const fieldName = tagAttrs.name || '';
        if (fieldName === 'arch') {
          meta.archStart = tag.end;
          meta.archEnd = tag.end;
        } else if (fieldName === 'inherit_id' && tagAttrs.ref) {
          meta.inheritId = tagAttrs.ref;
        } else if (fieldName === 'priority' && tagAttrs.eval) {
          meta.priority = tagAttrs.eval;
        } else if (fieldName === 'mode' && tagAttrs.eval) {
          meta.mode = tagAttrs.eval;
        }
      }
      i = tag.end;
      continue;
    }
    const bounds = scanElementEnd(src, tag.end, nameLower);
    if (nameLower === 'field') {
      const fieldName = tagAttrs.name || '';
      const inner = bounds.innerEnd > tag.end ? src.slice(tag.end, bounds.innerEnd) : '';
      if (fieldName === 'name') {
        const value = simpleText(inner);
        if (value) meta.name = value;
      } else if (fieldName === 'model') {
        meta.model = simpleText(inner);
      } else if (fieldName === 'inherit_id') {
        meta.inheritId = tagAttrs.ref || simpleText(inner) || meta.inheritId;
      } else if (fieldName === 'arch') {
        meta.archStart = tag.end;
        meta.archEnd = bounds.innerEnd;
      } else if (fieldName === 'priority') {
        meta.priority = simpleText(inner) || tagAttrs.eval || meta.priority;
      } else if (fieldName === 'mode') {
        meta.mode = simpleText(inner) || tagAttrs.eval || meta.mode;
      }
    }
    i = bounds.end;
  }
  return meta;
}

/**
 * Shared summary extraction used by both parseViewFile and indexViewFile.
 * Does not build arch strings or preview trees.
 */
function summarizeElement(src, item, options) {
  const isTemplate = item.tag.name.toLowerCase() === 'template';
  const attrs = item.tag.attrs || {};
  const moduleName = typeof options.moduleName === 'string' ? options.moduleName : '';

  let id;
  let name;
  let model;
  let inheritId;
  let priority;
  let declaredMode;
  let archStart;
  let archEnd;

  if (isTemplate) {
    id = attrs.id || '';
    name = attrs.name || '';
    model = '';
    inheritId = attrs.inherit_id || '';
    priority = attrs.priority || '';
    declaredMode = '';
    archStart = item.innerStart;
    archEnd = item.innerEnd;
  } else {
    const meta = extractRecordMeta(src, item);
    id = meta.id;
    name = meta.name || attrs.name || '';
    model = meta.model;
    inheritId = meta.inheritId;
    priority = meta.priority;
    declaredMode = meta.mode;
    archStart = meta.archStart;
    archEnd = meta.archEnd;
  }

  const xmlId = id && moduleName && !id.includes('.') ? `${moduleName}.${id}` : id;
  return {
    isTemplate,
    attrs,
    id,
    xmlId,
    name,
    model,
    inheritId,
    priority,
    mode: declaredMode === 'primary' || declaredMode === 'extension'
      ? declaredMode
      : (inheritId ? 'extension' : 'primary'),
    line: item.line,
    archStart,
    archEnd,
  };
}

function warningMessage(options, line, message) {
  const filePath = options && typeof options.filePath === 'string' ? options.filePath : '';
  return filePath ? `${filePath}:${line}: ${message}` : `line ${line}: ${message}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the direct `<field>` children of one non-view record into a flat map.
 * Used for report actions and paper formats, whose metadata the report preview
 * shows without needing a full model layer.
 * @param {string} src - file text.
 * @param {object} item - scanned top-level item.
 * @returns {Record<string, string>} field name -> value (ref/eval/text).
 */
function recordFieldMap(src, item) {
  const fields = {};
  let index = item.innerStart;
  const end = item.innerEnd;
  while (index < end) {
    const lt = src.indexOf('<', index);
    if (lt === -1 || lt >= end) break;
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      index = skipMarkup(src, lt);
      continue;
    }
    if (code === 47) {
      const close = readCloseTag(src, lt);
      index = close ? close.end : lt + 2;
      continue;
    }
    const tag = readTag(src, lt, true);
    if (!tag) {
      index = lt + 1;
      continue;
    }
    const nameLower = tag.name.toLowerCase();
    if (nameLower !== 'field') {
      index = tag.selfClosing ? tag.end : scanElementEnd(src, tag.end, nameLower).end;
      continue;
    }
    const name = tag.attrs && typeof tag.attrs.name === 'string' ? tag.attrs.name : '';
    if (name.length === 0) {
      index = tag.end;
      continue;
    }
    if (tag.selfClosing) {
      fields[name] = String(tag.attrs.ref ?? tag.attrs.eval ?? '');
      index = tag.end;
      continue;
    }
    const bounds = scanElementEnd(src, tag.end, 'field');
    const inner = bounds.innerEnd > tag.end ? src.slice(tag.end, bounds.innerEnd) : '';
    const value = String(tag.attrs.ref ?? tag.attrs.eval ?? simpleText(inner) ?? '');
    fields[name] = value.length > MAX_RECORD_FIELD_CHARS ? value.slice(0, MAX_RECORD_FIELD_CHARS) : value;
    index = bounds.end;
  }
  return fields;
}

/**
 * Locate the direct `<field>` children of one `<record>` source text, with the
 * exact character spans an editor needs to replace, remove or append a field.
 * Only direct children are reported; nested markup is never mistaken for a
 * record-level field.
 * @param {string} recordText - the record's exact source (`<record ...>...</record>`).
 * @returns {{ ok: boolean, openEnd: number, closeStart: number, selfClosing: boolean, fields: Array<object> } | null}
 *   field spans relative to `recordText`, or null when it holds no record element.
 */
export function scanRecordFields(recordText) {
  const src = typeof recordText === 'string' ? recordText : '';
  const { items } = scanTopLevelRecords(src);
  const item = items.find((entry) => entry.tag.name.toLowerCase() === 'record');
  if (item === undefined) return null;
  const result = {
    ok: item.closed,
    openEnd: item.tag.end,
    closeStart: item.innerEnd,
    selfClosing: item.tag.selfClosing === true,
    start: item.start,
    end: item.end,
    attrs: item.tag.attrs || {},
    fields: [],
  };
  if (result.selfClosing) return result;
  let index = item.innerStart;
  const end = item.innerEnd;
  while (index < end) {
    const lt = src.indexOf('<', index);
    if (lt === -1 || lt >= end) break;
    const code = src.charCodeAt(lt + 1);
    if (code === 33 || code === 63) {
      index = skipMarkup(src, lt);
      continue;
    }
    if (code === 47) {
      const close = readCloseTag(src, lt);
      index = close ? close.end : lt + 2;
      continue;
    }
    const tag = readTag(src, lt, true);
    if (!tag) {
      index = lt + 1;
      continue;
    }
    const nameLower = tag.name.toLowerCase();
    if (nameLower !== 'field') {
      index = tag.selfClosing ? tag.end : scanElementEnd(src, tag.end, nameLower).end;
      continue;
    }
    const name = tag.attrs && typeof tag.attrs.name === 'string' ? tag.attrs.name : '';
    if (tag.selfClosing) {
      if (name.length > 0) {
        result.fields.push({ name, attrs: tag.attrs, start: lt, end: tag.end, innerStart: tag.end, innerEnd: tag.end, selfClosing: true, hasChildElements: false });
      }
      index = tag.end;
      continue;
    }
    const bounds = scanElementEnd(src, tag.end, 'field');
    if (name.length > 0) {
      const inner = bounds.innerEnd > tag.end ? src.slice(tag.end, bounds.innerEnd) : '';
      result.fields.push({
        name,
        attrs: tag.attrs,
        start: lt,
        end: bounds.end,
        innerStart: tag.end,
        innerEnd: bounds.innerEnd,
        selfClosing: false,
        hasChildElements: /<[A-Za-z_]/.test(inner.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')),
      });
    }
    index = bounds.end;
  }
  return result;
}

/**
 * Normalize the direct fields of one window-action record into the flat shape
 * the index and the Actions panel consume. Raw reference values are kept
 * (`base.view_partner_form`); the Host resolves them against the view index.
 * @param {Record<string, string>} fields - raw field map from recordFieldMap.
 * @returns {object} normalized action fields.
 */
function normalizeActionFields(fields) {
  const pick = (name) => (typeof fields[name] === 'string' ? fields[name] : '');
  return {
    name: pick('name'),
    resModel: pick('res_model'),
    viewMode: pick('view_mode'),
    viewId: pick('view_id'),
    target: pick('target'),
    usage: pick('usage'),
    domain: pick('domain'),
    context: pick('context'),
    bindingModel: pick('binding_model_id'),
    actWindowId: pick('act_window_id'),
    sequence: pick('sequence'),
  };
}

/**
 * Identifiers followed by `(` in one server-action `code` body.
 *
 * A server action can call a model method without any Python file mentioning the
 * call site (`model.action_mark_issued()`), so these names are caller evidence.
 * @param {string} code - the record's `code` field.
 * @returns {string[]} deduped identifiers in body order.
 */
function collectActionCalls(code) {
  const calls = [];
  const seen = new Set();
  for (const match of code.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1];
    if (seen.has(name) || PY_KEYWORDS.has(name)) continue;
    seen.add(name);
    calls.push(name);
    // One record can inline a whole workflow; the cap keeps the index bounded.
    if (calls.length >= MAX_ACTION_CALLS) break;
  }
  return calls;
}

/**
 * Extract one `ir.actions.act_window` / `ir.actions.act_window.view` record from
 * a scanned top-level item.
 * @param {string} src - file text.
 * @param {object} item - scanned top-level record item.
 * @param {string} moduleName - module that owns the file.
 * @returns {object | null} action record, or null for another model.
 */
function extractActionRecord(src, item, moduleName) {
  const attrs = item.tag.attrs || {};
  const model = typeof attrs.model === 'string' ? attrs.model.trim() : '';
  const kind = ACTION_MODEL_KINDS.get(model);
  if (kind === undefined) return null;
  const id = typeof attrs.id === 'string' ? attrs.id : '';
  if (id.length === 0) return null;
  const xmlId = moduleName && !id.includes('.') ? `${moduleName}.${id}` : id;
  const fields = item.tag.selfClosing ? {} : recordFieldMap(src, item);
  return {
    id,
    xmlId,
    model,
    kind,
    line: item.line,
    ...normalizeActionFields(fields),
    fields,
    // Only a `state = code` server action has an inline Python body to scan.
    calls: fields.state === 'code' && typeof fields.code === 'string' ? collectActionCalls(fields.code) : [],
    // Exact record source for the read-only XML view of the action panel. The
    // fast index path drops these fields (no code needs them there).
    source: dedentSource(src.slice(item.start, item.end), indentAt(src, item.start)),
    sourceRaw: src.slice(item.start, item.end),
    sourceStart: item.start,
    sourceEnd: item.end,
  };
}

/**
 * Full parse of one Odoo XML file for the detail view.
 * Never throws: malformed markup yields whatever could be recovered plus
 * warnings.
 *
 * @param {string} text raw file contents
 * @param {{moduleName?: string, filePath?: string}} [options]
 * @returns {{views: Array<object>, otherRecordCount: number, warnings: string[], reports: Array<object>, paperformats: Array<object>, actions: Array<object>}}
 */
export function parseViewFile(text, options = {}) {
  const opts = options || {};
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  const src = stripBom(raw);
  const views = [];
  const warnings = [];
  const reports = [];
  const paperformats = [];
  const actions = [];
  let otherRecordCount = 0;
  const moduleName = typeof opts.moduleName === 'string' ? opts.moduleName : '';

  const { items, problems } = scanTopLevelRecords(src);
  for (const problem of problems) warnings.push(warningMessage(opts, problem.line, problem.message));

  for (const item of items) {
    const isTemplate = item.tag.name.toLowerCase() === 'template';
    if (!isTemplate) {
      const model = (item.tag.attrs || {}).model;
      if (typeof model !== 'string' || model.trim() !== 'ir.ui.view') {
        otherRecordCount++;
        const recordModel = typeof model === 'string' ? model.trim() : '';
        if (recordModel === 'ir.actions.report' || recordModel === 'report.paperformat') {
          const attrs = item.tag.attrs || {};
          const id = typeof attrs.id === 'string' ? attrs.id : '';
          const xmlId = id && moduleName && !id.includes('.') ? `${moduleName}.${id}` : id;
          if (id.length > 0 && reports.length + paperformats.length < 100) {
            const entry = { id, xmlId, model: recordModel, fields: recordFieldMap(src, item) };
            if (recordModel === 'ir.actions.report') reports.push(entry);
            else paperformats.push(entry);
          }
        }
        if (actions.length < MAX_ACTIONS_PER_FILE) {
          const action = extractActionRecord(src, item, moduleName);
          // The detail payload lists window actions; server actions have no
          // window to open. `indexViewFile` keeps them for `callers` instead.
          if (action !== null && action.kind !== 'server') actions.push(action);
        }
        continue;
      }
    }
    if (!item.closed) {
      warnings.push(
        warningMessage(opts, item.line, `unterminated <${isTemplate ? 'template' : 'record'}> element`),
      );
    }

    const summary = summarizeElement(src, item, opts);
    const archRaw =
      summary.archStart >= 0 && summary.archEnd > summary.archStart
        ? src.slice(summary.archStart, summary.archEnd)
        : '';
    const arch = dedentBlock(archRaw);
    const parsed = arch ? parseArch(arch, { moduleName }) : { root: null, fields: [], xpaths: [] };
    const previewRoot = parsed.root !== undefined ? parsed.root : null;
    const rootTag = previewRoot === null ? '' : previewRoot.virtual === true ? previewRoot.children[0]?.tag ?? '' : previewRoot.tag;
    const rawType = rootTag;
    const type = isTemplate ? 'qweb' : normalizeViewType(rawType);

    const view = {
      id: summary.id,
      xmlId: summary.xmlId,
      kind: isTemplate ? 'template' : 'view',
      name: summary.name,
      model: summary.model,
      type,
      rawType,
      inheritId: summary.inheritId,
      mode: summary.mode,
      priority: summary.priority,
      line: summary.line,
      source: dedentSource(src.slice(item.start, item.end), indentAt(src, item.start)),
      // Exact span of the record/template in the BOM-stripped file text, plus
      // the untouched source. The editor splices this span back on save.
      sourceStart: item.start,
      sourceEnd: item.end,
      sourceRaw: src.slice(item.start, item.end),
      // Absolute span of the arch body in the BOM-stripped file text, used by
      // the visual builder to splice a regenerated arch back in place.
      archStart: summary.archStart,
      archEnd: summary.archEnd,
      arch,
      fields: parsed.fields,
      fieldCount: parsed.fields.length,
      fieldText: parsed.fields.join(' '),
      xpaths: parsed.xpaths,
      preview: parsed.root,
    };
    if (arch && !parsed.root) {
      view.archError = parsed.error || 'unable to parse arch';
    }
    views.push(view);
  }

  return { views, otherRecordCount, warnings, reports, paperformats, actions };
}

/**
 * Fast summary-only parse used to build the cross-file index. Builds no preview
 * trees and no dedented arch strings.
 *
 * @param {string} text raw file contents
 * @param {{moduleName?: string, filePath?: string}} [options]
 * @returns {{views: Array<object>, otherRecordCount: number, actions: Array<object>, serverActions: Array<object>}}
 */
export function indexViewFile(text, options = {}) {
  const opts = options || {};
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  const src = stripBom(raw);
  const views = [];
  const actions = [];
  const serverActions = [];
  let otherRecordCount = 0;
  const moduleName = typeof opts.moduleName === 'string' ? opts.moduleName : '';

  const { items } = scanTopLevelRecords(src);
  for (const item of items) {
    const isTemplate = item.tag.name.toLowerCase() === 'template';
    if (!isTemplate) {
      const model = (item.tag.attrs || {}).model;
      if (typeof model !== 'string' || model.trim() !== 'ir.ui.view') {
        otherRecordCount++;
        if (actions.length + serverActions.length < MAX_ACTIONS_PER_FILE) {
          const action = extractActionRecord(src, item, moduleName);
          if (action !== null) {
            // The index keeps the normalized action only; the full field map is
            // added by the file-detail parse when an action is opened.
            const { fields, source, sourceRaw, sourceStart, sourceEnd, ...summary } = action;
            // Server actions are kept apart: the Actions panel lists window
            // actions, while `callers` reads the inline code body.
            if (summary.kind === 'server') serverActions.push(summary);
            else actions.push(summary);
          }
        }
        continue;
      }
    }

    const summary = summarizeElement(src, item, opts);
    const hasArch = summary.archStart >= 0 && summary.archEnd > summary.archStart;
    const rawType = hasArch ? firstTagName(src, summary.archStart, summary.archEnd) : '';
    const type = isTemplate ? 'qweb' : normalizeViewType(rawType);

    views.push({
      id: summary.id,
      xmlId: summary.xmlId,
      name: summary.name,
      model: summary.model,
      type,
      rawType,
      inheritId: summary.inheritId,
      mode: summary.mode,
      priority: summary.priority,
      line: summary.line,
      fieldText: hasArch ? collectFieldNames(src, summary.archStart, summary.archEnd).join(' ') : '',
      // Method call sites of this view (buttons, <function>), so `callers` can
      // answer "which forms trigger this method" without re-reading every file.
      calls: hasArch ? collectViewCalls(src, summary.archStart, summary.archEnd) : [],
    });
  }

  return { views, otherRecordCount, actions, serverActions };
}

/**
 * Qualify and canonicalise `%(xml_id)d` / `%(xml_id)s` references in one value.
 *
 * Odoo resolves those references to the target record id when it loads a view,
 * so both a base arch and an inheriting locator end up holding the same number.
 * The file corpus has no ids, so the qualified xml id is the canonical form:
 * an unqualified reference belongs to the module of the view that declares it
 * (`view_xml_id.split('.')[0]` in Odoo) and `s`/`d` are equivalent.
 * @param {string} value - attribute value or xpath expression.
 * @param {string} moduleName - module that owns the arch, '' when unknown.
 * @returns {string} value with canonical references.
 */
export function qualifyXmlIdRefs(value, moduleName) {
  if (typeof value !== 'string' || !value.includes('%(')) return value;
  return value.replace(/%\(([\w.]+)\)[ds]/g, (match, xmlId) => {
    const qualified = moduleName && !xmlId.includes('.') ? `${moduleName}.${xmlId}` : xmlId;
    return `%(${qualified})d`;
  });
}

/**
 * Parse one view arch string into a tolerant preview tree.
 *
 * @param {string} archText
 * @param {{moduleName?: string}} [options] - module that owns the arch; used to
 *   qualify unqualified `%(xml_id)d` references the way Odoo resolves them.
 * @returns {{root: object|null, fields: string[], xpaths: string[], locators: Array<{expr: string, position: string}>, error?: string}}
 */
export function parseArch(archText, options = {}) {
  const result = { root: null, fields: [], xpaths: [], locators: [] };
  let src = typeof archText === 'string' ? archText : archText == null ? '' : String(archText);
  src = stripBom(src);
  if (src.length > MAX_ARCH_CHARS) src = src.slice(0, MAX_ARCH_CHARS);
  if (!src.trim()) return result;
  const moduleName = typeof options.moduleName === 'string' ? options.moduleName : '';

  const fields = result.fields;
  const xpaths = result.xpaths;
  const locators = result.locators;
  const seenFields = new Set();
  const seenXpaths = new Set();
  /** @type {Array<{nameLower: string, node: object|null, text: string}>} */
  const stack = [];
  const topNodes = [];
  let nodeCount = 0;

  const appendText = (chunk) => {
    if (stack.length === 0 || !chunk) return;
    stack[stack.length - 1].text += chunk;
  };

  const makeNode = (tag, attrs, start, end) => {
    const depth = stack.length;
    if (depth >= MAX_PREVIEW_DEPTH || nodeCount >= MAX_PREVIEW_NODES) return null;
    const parent = depth > 0 ? stack[depth - 1].node : null;
    if (depth > 0 && !parent) return null; // ancestor was dropped by the cap
    const node = { tag, attrs, children: [], text: '', loc: { start, end } };
    nodeCount++;
    if (parent) parent.children.push(node);
    else topNodes.push(node);
    return node;
  };

  const finalize = (entry, end) => {
    if (entry.node) {
      entry.node.text = decodeEntities(entry.text).trim();
      if (Number.isFinite(end)) entry.node.loc.end = end;
    }
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      appendText(src.slice(i));
      break;
    }
    if (lt > i) appendText(src.slice(i, lt));
    const code = src.charCodeAt(lt + 1);

    if (code === 33) {
      // '!'
      if (src.startsWith('<!--', lt)) {
        const end = src.indexOf('-->', lt + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        const end = src.indexOf(']]>', lt + 9);
        appendText(src.slice(lt + 9, end === -1 ? n : end));
        i = end === -1 ? n : end + 3;
        continue;
      }
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    if (code === 63) {
      // '?'
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    if (code === 47) {
      // '/'
      const close = readCloseTag(src, lt);
      if (!close) {
        i = lt + 2;
        continue;
      }
      const nameLower = close.name.toLowerCase();
      let match = stack.length - 1;
      while (match >= 0 && stack[match].nameLower !== nameLower) match--;
      if (match >= 0) {
        while (stack.length > match) finalize(stack.pop(), close.end);
      }
      i = close.end;
      continue;
    }

    const tag = readTag(src, lt, true);
    if (!tag) {
      appendText('<');
      i = lt + 1;
      continue;
    }
    const nameLower = tag.name.toLowerCase();
    const attrs = tag.attrs || {};
    for (const key of Object.keys(attrs)) {
      if (typeof attrs[key] === 'string' && attrs[key].includes('%(')) attrs[key] = qualifyXmlIdRefs(attrs[key], moduleName);
    }

    // Metadata is collected independently of the preview node cap.
    if (nameLower === 'field') {
      const fieldName = attrs.name;
      if (fieldName && !seenFields.has(fieldName)) {
        seenFields.add(fieldName);
        fields.push(fieldName);
      }
    } else if (nameLower === 'xpath' && attrs.expr !== undefined) {
      if (!seenXpaths.has(attrs.expr)) {
        seenXpaths.add(attrs.expr);
        xpaths.push(attrs.expr);
      }
      if (locators.length < MAX_LOCATORS) {
        locators.push({
          expr: attrs.expr,
          position: typeof attrs.position === 'string' && attrs.position.length > 0 ? attrs.position : 'inside',
        });
      }
    }

    if (tag.selfClosing) {
      makeNode(nameLower, attrs, lt, tag.end);
      i = tag.end;
      continue;
    }

    const node = makeNode(nameLower, attrs, lt, tag.end);
    stack.push({ nameLower, node, text: '' });
    i = tag.end;
  }

  while (stack.length) finalize(stack.pop(), n);

  if (topNodes.length === 1) {
    result.root = topNodes[0];
  } else if (topNodes.length > 1) {
    // Extension arches often hold several top-level locators (<xpath/>, <field
    // position=.../>) with no wrapping element. A virtual root keeps every part
    // in the tree; serializers must emit its children without a wrapper tag.
    result.root = { tag: '#arch', attrs: {}, children: topNodes, text: '', virtual: true };
  } else {
    result.root = null;
  }
  if (result.root === null) result.error = 'no XML elements found in arch';
  return result;
}

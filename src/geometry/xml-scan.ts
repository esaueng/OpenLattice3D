// A small, purpose-built XML tag scanner for 3MF parts.
//
// Workers have no DOMParser, and a 3MF model is millions of tiny elements, so
// this scans UTF-8 bytes directly (no whole-file string decode) and reports
// only start and end tags with namespace-resolved names. Text content,
// comments, processing instructions and CDATA are skipped. Entities are never
// expanded beyond the five predefined ones and numeric references, and a DTD
// is refused outright (3MF forbids one), so there is no entity-expansion
// attack surface.

export interface XmlAttribute {
  /** Local name, without prefix. */
  local: string;
  /** Namespace URI; undefined for unprefixed attributes. */
  ns: string | undefined;
  value: string;
}

export interface XmlElement {
  local: string;
  /** Resolved namespace URI, or undefined when none is in scope. */
  ns: string | undefined;
  attributes: XmlAttribute[];
  depth: number;
}

export interface XmlHandlers {
  start(element: XmlElement): void;
  end?(local: string, ns: string | undefined, depth: number): void;
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const utf8 = new TextDecoder('utf-8', { fatal: false });

/** First attribute with this local name and namespace (undefined = unprefixed). */
export function xmlAttribute(element: XmlElement, local: string, ns?: string): string | undefined {
  for (const attribute of element.attributes) {
    if (attribute.local === local && attribute.ns === ns) return attribute.value;
  }
  return undefined;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function decodeEntities(text: string, fail: (message: string) => never): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) fail(`invalid character reference &${body};`);
      return String.fromCodePoint(code);
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return '\'';
      default: return fail(`undefined entity &${body};`);
    }
  });
}

/**
 * Scan XML bytes, calling `start` for every start (or empty-element) tag and
 * `end` for every end tag (empty elements get both). Throws on malformed or
 * truncated markup, mismatched end tags, or a DTD.
 */
export function scanXml(bytes: Uint8Array, handlers: XmlHandlers, label: string): void {
  const fail = (message: string): never => { throw new Error(`${label} is not well-formed XML: ${message}`); };
  const length = bytes.length;
  if (length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    fail('UTF-16 is not supported; 3MF parts are UTF-8');
  }
  let i = length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

  const text = (start: number, end: number): string => {
    let ascii = true;
    for (let k = start; k < end; k++) if (bytes[k] >= 0x80) { ascii = false; break; }
    if (!ascii) return utf8.decode(bytes.subarray(start, end));
    let out = '';
    // Chunked so a long attribute value cannot overflow the argument limit.
    for (let k = start; k < end; k += 8192) {
      out += String.fromCharCode.apply(null, bytes.subarray(k, Math.min(end, k + 8192)) as unknown as number[]);
    }
    return out;
  };
  const indexOf = (needle: string, from: number): number => {
    const first = needle.charCodeAt(0);
    outer: for (let k = from; k <= length - needle.length; k++) {
      if (bytes[k] !== first) continue;
      for (let m = 1; m < needle.length; m++) if (bytes[k + m] !== needle.charCodeAt(m)) continue outer;
      return k;
    }
    return -1;
  };
  const startsWith = (needle: string, at: number): boolean => {
    if (at + needle.length > length) return false;
    for (let m = 0; m < needle.length; m++) if (bytes[at + m] !== needle.charCodeAt(m)) return false;
    return true;
  };
  const readName = (): string => {
    const start = i;
    while (i < length) {
      const c = bytes[i];
      if (isSpace(c) || c === 0x2f /* / */ || c === 0x3e /* > */ || c === 0x3d /* = */) break;
      i++;
    }
    if (i === start) fail(`expected a name at byte ${start}`);
    return text(start, i);
  };
  const splitName = (qualified: string): [string, string] => {
    const colon = qualified.indexOf(':');
    return colon < 0 ? ['', qualified] : [qualified.slice(0, colon), qualified.slice(colon + 1)];
  };

  // Namespace scopes: one entry per open element; shared until an element
  // declares something new.
  const scopes: Map<string, string>[] = [new Map([['xml', XML_NAMESPACE]])];
  const open: string[] = [];
  let sawRoot = false;

  while (i < length) {
    const lt = bytes.indexOf(0x3c /* < */, i);
    if (lt < 0) break;
    i = lt + 1;
    if (i >= length) fail('truncated at end of file');
    const c = bytes[i];
    if (c === 0x3f /* ? */) {
      const close = indexOf('?>', i);
      if (close < 0) fail('unterminated processing instruction');
      i = close + 2;
      continue;
    }
    if (c === 0x21 /* ! */) {
      if (startsWith('!--', i)) {
        const close = indexOf('-->', i + 3);
        if (close < 0) fail('unterminated comment');
        i = close + 3;
      } else if (startsWith('![CDATA[', i)) {
        const close = indexOf(']]>', i + 8);
        if (close < 0) fail('unterminated CDATA section');
        i = close + 3;
      } else if (startsWith('!DOCTYPE', i)) {
        fail('a document type declaration (DTD) is not allowed');
      } else {
        fail(`unexpected markup at byte ${lt}`);
      }
      continue;
    }
    if (c === 0x2f /* / */) {
      i++;
      const qualified = readName();
      while (i < length && isSpace(bytes[i])) i++;
      if (bytes[i] !== 0x3e) fail(`unterminated end tag </${qualified}>`);
      i++;
      const expected = open.pop();
      if (expected !== qualified) fail(expected === undefined ? `unexpected end tag </${qualified}>` : `expected </${expected}> but found </${qualified}>`);
      const scope = scopes[scopes.length - 1];
      scopes.pop();
      const [prefix, local] = splitName(qualified);
      handlers.end?.(local, scope.get(prefix), open.length);
      continue;
    }

    if (sawRoot && open.length === 0) fail('content after the root element');
    const qualified = readName();
    const raw: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      while (i < length && isSpace(bytes[i])) i++;
      if (i >= length) fail(`unterminated start tag <${qualified}>`);
      if (bytes[i] === 0x3e) { i++; break; }
      if (bytes[i] === 0x2f) {
        if (bytes[i + 1] !== 0x3e) fail(`malformed empty-element tag <${qualified}>`);
        i += 2;
        selfClosing = true;
        break;
      }
      const name = readName();
      while (i < length && isSpace(bytes[i])) i++;
      if (bytes[i] !== 0x3d) fail(`attribute ${name} on <${qualified}> has no value`);
      i++;
      while (i < length && isSpace(bytes[i])) i++;
      const quote = bytes[i];
      if (quote !== 0x22 && quote !== 0x27) fail(`attribute ${name} on <${qualified}> is not quoted`);
      const close = bytes.indexOf(quote, i + 1);
      if (close < 0) fail(`unterminated attribute ${name} on <${qualified}>`);
      let value = text(i + 1, close);
      if (value.includes('<')) fail(`attribute ${name} on <${qualified}> contains "<"`);
      if (value.includes('&')) value = decodeEntities(value, fail);
      raw.push([name, value]);
      i = close + 1;
    }

    let scope = scopes[scopes.length - 1];
    for (const [name, value] of raw) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        if (scope === scopes[scopes.length - 1]) scope = new Map(scope);
        scope.set(name === 'xmlns' ? '' : name.slice(6), value);
      }
    }
    const attributes: XmlAttribute[] = [];
    for (const [name, value] of raw) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const [prefix, local] = splitName(name);
      attributes.push({ local, ns: prefix ? scope.get(prefix) ?? `unbound:${prefix}` : undefined, value });
    }
    const [prefix, local] = splitName(qualified);
    const ns = scope.get(prefix);
    sawRoot = true;
    handlers.start({ local, ns, attributes, depth: open.length });
    if (selfClosing) {
      handlers.end?.(local, ns, open.length);
    } else {
      open.push(qualified);
      scopes.push(scope);
    }
  }
  if (!sawRoot) fail('no root element');
  if (open.length > 0) fail(`truncated inside <${open[open.length - 1]}>`);
}

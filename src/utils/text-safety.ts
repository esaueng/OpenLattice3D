export function escapeControlCharacters(value: string): string {
  let escaped = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029;
    if (!isControl) {
      escaped += character;
      continue;
    }
    if (character === '\n') escaped += '\\n';
    else if (character === '\r') escaped += '\\r';
    else if (character === '\t') escaped += '\\t';
    else escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }
  return escaped;
}

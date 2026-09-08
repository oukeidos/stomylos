import { AppFailure } from './errors';

// Tokens retain numeric syntax so a score of 1.0 cannot masquerade as integer 1.
export interface ParsedJson { value: unknown; integerPaths: Set<string> }
export function parseStrict(source: string): ParsedJson {
  let offset = 0;
  const integerPaths = new Set<string>();
  const fail = (): never => { throw new AppFailure('response_invalid_json'); };
  if (source.length > 2 * 1024 * 1024) fail();
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[offset] ?? '\0')) offset++; };
  const take = (c: string) => { whitespace(); if (source[offset] !== c) return false; offset++; return true; };
  function string(): string {
    whitespace(); const start = offset;
    if (source[offset++] !== '"') fail();
    while (offset < source.length) {
      const c = source.charCodeAt(offset++);
      if (c < 32) fail();
      if (c === 34) { try { return JSON.parse(source.slice(start, offset)); } catch { return fail(); } }
      if (c === 92) offset++;
    }
    return fail();
  }
  function value(depth: number, path: string): unknown {
    if (depth > 64) fail();
    whitespace();
    if (take('{')) {
      const result: Record<string, unknown> = Object.create(null);
      if (take('}')) return result;
      do {
        const key = string();
        if (Object.hasOwn(result, key) || !take(':')) fail();
        result[key] = value(depth + 1, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
        if (take('}')) return result;
      } while (take(','));
      return fail();
    }
    if (take('[')) {
      const result: unknown[] = [];
      if (take(']')) return result;
      do { result.push(value(depth + 1, `${path}/${result.length}`)); if (take(']')) return result; } while (take(','));
      return fail();
    }
    if (source[offset] === '"') return string();
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, offset)) { offset += token.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(offset));
    if (!match) return fail();
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail();
    if (!/[.eE]/.test(match[0])) integerPaths.add(path);
    return number;
  }
  const parsed = value(0, ''); whitespace();
  if (offset !== source.length) fail();
  return { value: parsed, integerPaths };
}
export function strictJson(source: string): any { return parseStrict(source).value; }

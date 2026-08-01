import { describe, expect, it } from 'vitest';

import {
  MAX_STRING_LENGTH,
  sanitizeFiniteNumber,
  sanitizeString,
  sanitizeStrings,
  utf8ByteLength,
} from './sanitize.js';

describe('sanitizeString', () => {
  it('strips C0 and C1 control characters', () => {
    const input = `a${String.fromCharCode(0)}b${String.fromCharCode(1)}c${String.fromCharCode(0x7f)}d${String.fromCharCode(0x9f)}e`;
    expect(sanitizeString(input)).toBe('abcde');
  });

  it('turns whitespace control characters into a single space', () => {
    expect(sanitizeString('line1\nline2')).toBe('line1 line2');
    expect(sanitizeString('a\t\t\tb')).toBe('a b');
    expect(sanitizeString('a\r\n\r\nb')).toBe('a b');
  });

  it('collapses whitespace runs and trims', () => {
    expect(sanitizeString('   a     b   ')).toBe('a b');
  });

  it('caps length and appends an ellipsis', () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 50);
    const result = sanitizeString(long);
    expect(result).toBe(`${'x'.repeat(MAX_STRING_LENGTH)}…`);

    expect(sanitizeString('abcdef', 3)).toBe('abc…');
    expect(sanitizeString('abc', 3)).toBe('abc');
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    // Three astral code points (six UTF-16 units), capped at two code points.
    const result = sanitizeString('😀😀😀', 2);
    expect(result).toBe('😀😀…');
    expect(Array.from(result)).toHaveLength(3);
  });

  it('coerces numbers and booleans but rejects everything else', () => {
    expect(sanitizeString(42)).toBe('42');
    expect(sanitizeString(0)).toBe('0');
    expect(sanitizeString(true)).toBe('true');
    expect(sanitizeString(false)).toBe('false');
    expect(sanitizeString(null)).toBe('');
    expect(sanitizeString(undefined)).toBe('');
    expect(sanitizeString({ a: 1 })).toBe('');
    expect(sanitizeString(['a'])).toBe('');
    expect(sanitizeString(() => 'x')).toBe('');
    expect(sanitizeString(Symbol('x'))).toBe('');
  });
});

describe('sanitizeStrings', () => {
  it('caps the array and reports truncation', () => {
    const result = sanitizeStrings(['a', 'b', 'c', 'd'], 2);
    expect(result.values).toEqual(['a', 'b']);
    expect(result.truncated).toBe(true);
  });

  it('reports no truncation when everything fits', () => {
    const result = sanitizeStrings(['a', 'b'], 5);
    expect(result.values).toEqual(['a', 'b']);
    expect(result.truncated).toBe(false);
  });

  it('sanitizes each item and honours the per-item length cap', () => {
    const result = sanitizeStrings(['  a\nb  ', { bad: true }, 'abcdef'], 5, 3);
    expect(result.values).toEqual(['a b', '', 'abc…']);
    expect(result.truncated).toBe(false);
  });
});

describe('sanitizeFiniteNumber', () => {
  it('accepts finite numbers only', () => {
    expect(sanitizeFiniteNumber(0)).toBe(0);
    expect(sanitizeFiniteNumber(-1.5)).toBe(-1.5);
    expect(sanitizeFiniteNumber(Number.NaN)).toBeUndefined();
    expect(sanitizeFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeFiniteNumber('7')).toBeUndefined();
    expect(sanitizeFiniteNumber(null)).toBeUndefined();
    expect(sanitizeFiniteNumber(undefined)).toBeUndefined();
  });
});

describe('utf8ByteLength', () => {
  it('counts ASCII as one byte per character', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('hello')).toBe(5);
  });

  it('counts two-byte code points', () => {
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('ß')).toBe(2);
  });

  it('counts CJK as three bytes per character', () => {
    expect(utf8ByteLength('日本語')).toBe(9);
  });

  it('counts an astral code point (surrogate pair) as four bytes', () => {
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('a😀b')).toBe(6);
  });

  it('handles lone surrogates without crashing', () => {
    // A lone high or low surrogate would be encoded as U+FFFD (three bytes) by a real encoder.
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('\udc00')).toBe(3);
    expect(utf8ByteLength('a\ud800b')).toBe(5);
    // High surrogate at the very end of the string: charCodeAt(i + 1) is NaN.
    expect(utf8ByteLength('ab\ud800')).toBe(5);
  });
});

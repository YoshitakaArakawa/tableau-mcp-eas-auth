/**
 * @file Whitelist sanitization for values read out of a workbook.
 *
 * Everything the Embedding API hands back is untrusted workbook content: field names, filter
 * values, parameter values and summary data cells are all author-controlled. Before any of it goes
 * into the payload pushed to the host, it is coerced to a plain, bounded, control-character-free
 * string. Anything that is not a primitive becomes the empty string rather than `[object Object]`.
 */

/** Default per-string cap, measured in code points (not UTF-16 units, so surrogate pairs stay intact). */
export const MAX_STRING_LENGTH = 200;

const WHITESPACE_RUN_PATTERN = /\s+/g;
const TRUNCATION_SUFFIX = '…';

// Control-character ranges, as code units. Handled with a code-unit walk rather than a regex literal
// so that no literal control character has to appear in this source file.
const C0_END = 0x1f;
const C1_START = 0x7f;
const C1_END = 0x9f;
const WHITESPACE_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/**
 * Removes C0 (U+0000-U+001F) and C1 (U+007F-U+009F) control characters.
 * Tab/newline/vertical-tab/form-feed/carriage-return become spaces so that multi-line workbook text
 * reads as separated words; every other control character is dropped outright.
 */
function stripControlCharacters(text: string): string {
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (code > C0_END && (code < C1_START || code > C1_END)) {
      out += text[i];
    } else if (WHITESPACE_CONTROLS.has(code)) {
      out += ' ';
    }
  }

  return out;
}

/**
 * Coerces an untrusted value to a bounded single-line string.
 * Only string/number/boolean are accepted; every other input (null, undefined, objects, arrays,
 * functions, symbols) yields ''.
 */
export function sanitizeString(value: unknown, maxLength = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return '';
  }

  const normalized = stripControlCharacters(String(value))
    .replace(WHITESPACE_RUN_PATTERN, ' ')
    .trim();

  // Slice by code point so a truncation boundary never splits a surrogate pair.
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxLength) {
    return normalized;
  }

  return codePoints.slice(0, maxLength).join('') + TRUNCATION_SUFFIX;
}

/**
 * Sanitizes an array of untrusted values and caps its length.
 * `truncated` reports whether items were dropped, so the caller can label the snapshot as partial.
 */
export function sanitizeStrings(
  values: unknown[],
  maxItems: number,
  maxLength = MAX_STRING_LENGTH,
): { values: string[]; truncated: boolean } {
  const kept = values.slice(0, maxItems).map((value) => sanitizeString(value, maxLength));
  return { values: kept, truncated: values.length > maxItems };
}

/** Returns the value only when it is a real, finite number; NaN/Infinity/non-numbers yield undefined. */
export function sanitizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * UTF-8 byte length of a string, computed by walking code units.
 *
 * Hand-rolled on purpose: `TextEncoder` is not reliably present in every environment this code is
 * tested in, and the push budget must be measurable without an environment-dependent global. Lone
 * surrogates are counted as 3 bytes, matching the U+FFFD replacement that any real UTF-8 encoder
 * would emit for them.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Well-formed surrogate pair: one astral code point, four bytes.
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

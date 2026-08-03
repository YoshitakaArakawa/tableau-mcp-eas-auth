/**
 * @file Minimal, hand-written type declarations for the `<tableau-pulse>` element of the Tableau
 * Embedding API v3.
 *
 * Same rules as `embed/vizState/embeddingApiTypes.ts`: the API is loaded at runtime from the
 * Tableau server, there are no vendor typings, and these declarations are NOT authoritative. Every
 * member is optional so feature detection (`typeof pulse.getFiltersAsync === 'function'`) is
 * type-safe rather than a cast.
 *
 * Write methods are DELIBERATELY omitted, so read-only usage is enforced by the type system.
 *
 * Event names are lowercase, which is what the DOM delivers — the documented camelCase
 * `TableauEventType` spellings never fire as DOM events. Measured against Tableau Cloud (2026.2)
 * with Embedding API 3.16.0; see verification/pulse-embed/FINDINGS.md.
 */

/** The `<tableau-pulse>` custom element once the Embedding API has upgraded it. */
export type TableauPulseElement = HTMLElement & {
  getFiltersAsync?: () => Promise<unknown[]>;
  getTimeDimensionAsync?: () => Promise<unknown>;
};

/**
 * Interaction events that should trigger a fresh state capture.
 *
 * `pulseinsightdiscovered` is both a trigger and a data source: the insights it reports are
 * accumulated by the bridge, because there is no "list the insights currently shown" API.
 */
export const PULSE_INSIGHT_DISCOVERED_EVENT = 'pulseinsightdiscovered';

export const TABLEAU_PULSE_EVENTS = [
  'pulsefilterschanged',
  'pulsetimedimensionchanged',
  PULSE_INSIGHT_DISCOVERED_EVENT,
] as const;

/** Fires once per element with the metric's natural size. `detail` carries `_width` / `_height`. */
export const PULSE_FIRST_SIZE_EVENT = 'firstpulsemetricsizeknown';

/** Fires on subsequent size changes, with the same `detail` shape as the first-size event. */
export const PULSE_SIZE_CHANGED_EVENT = 'pulsemetricsizechanged';

/** Runtime error from the Pulse element. `detail` carries `_message` / `_httpStatus`. */
export const PULSE_ERROR_EVENT = 'pulseerror';

/**
 * Fires when the element navigates. `detail._context === 'session-expired'` is how an expired or
 * insufficiently scoped embed token surfaces — there is no dedicated auth-error event.
 */
export const PULSE_URL_CHANGED_EVENT = 'pulseurlchanged';

/** `detail._context` value that means the embed session is no longer usable. */
export const PULSE_SESSION_EXPIRED_CONTEXT = 'session-expired';

/** The size payload carried by the first-size and size-changed events. */
export type PulseSizeDetail = { _width?: unknown; _height?: unknown };

/** The error payload carried by `pulseerror`. */
export type PulseErrorDetail = {
  _message?: unknown;
  _httpStatus?: unknown;
  _messageVisibility?: unknown;
};

/** The navigation payload carried by `pulseurlchanged`. */
export type PulseUrlChangedDetail = { _context?: unknown };

/** The insight payload carried by `pulseinsightdiscovered`. */
export type PulseInsightDetail = {
  id?: unknown;
  type?: unknown;
  question?: unknown;
  markup?: unknown;
  score?: unknown;
};

/**
 * @file Mounts a `<tableau-pulse>` element and wires its size and error events.
 */
import { TABLEAU_VIZ_CONTAINER_ID } from '../shared/vizContainer.js';
import {
  PULSE_ERROR_EVENT,
  PULSE_FIRST_SIZE_EVENT,
  PULSE_SESSION_EXPIRED_CONTEXT,
  PULSE_SIZE_CHANGED_EVENT,
  PULSE_URL_CHANGED_EVENT,
  type PulseErrorDetail,
  type PulseSizeDetail,
  type PulseUrlChangedDetail,
  type TableauPulseElement,
} from './pulseState/pulseEmbeddingApiTypes.js';

export type PulseLayout = 'default' | 'card' | 'ban';

export type EmbedPulseOptions = {
  metricUrl: string;
  token: string;
  layout?: PulseLayout;
  /** Called when the embed session is no longer usable (bad scopes, expired credential). */
  onAuthError?: () => void;
  /** Called on a runtime Pulse error that is not an auth failure. */
  onLoadError?: (message: string) => void;
};

/**
 * Creates and configures a `<tableau-pulse>` element.
 *
 * `layout` is passed through as an attribute only when the caller asked for a non-default one, so
 * the element keeps whatever its own default is rather than being pinned to this code's idea of it.
 */
export function createTableauPulseElement(options: EmbedPulseOptions): TableauPulseElement {
  const pulse = document.createElement('tableau-pulse') as TableauPulseElement;

  pulse.setAttribute('src', options.metricUrl);
  pulse.setAttribute('token', options.token);

  if (options.layout !== undefined && options.layout !== 'default') {
    pulse.setAttribute('layout', options.layout);
  }

  return pulse;
}

/**
 * Embeds a Tableau Pulse metric into the app's container element.
 *
 * @returns The mounted element, or undefined when the container is missing. Callers need the
 *   element itself to subscribe to Pulse events.
 */
export function embedTableauPulse(options: EmbedPulseOptions): TableauPulseElement | undefined {
  const container = document.getElementById(TABLEAU_VIZ_CONTAINER_ID);

  if (!container) {
    console.error(
      `[mcp-pulse] container element with id "${TABLEAU_VIZ_CONTAINER_ID}" not found; cannot embed metric`,
    );
    return undefined;
  }

  const pulse = createTableauPulseElement(options);

  // The Embedding API reports the metric's natural size via these two events, whose detail carries
  // `_width` / `_height` (leading underscores are the API's own field names, not private fields of
  // this code). Setting the element height to the reported height lets the ext-apps SDK's built-in
  // auto-resize grow the app frame to match the resulting document height.
  const applySize = (event: Event): void => {
    const detail = (event as CustomEvent).detail as PulseSizeDetail | undefined;
    const height = detail?._height;

    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      return;
    }

    pulse.style.height = `${height}px`;
  };

  pulse.addEventListener(PULSE_FIRST_SIZE_EVENT, applySize);
  pulse.addEventListener(PULSE_SIZE_CHANGED_EVENT, applySize);

  // Runtime errors. `pulseerror` covers load and request failures; an expired or
  // insufficiently-scoped embed credential does NOT arrive here — it arrives as a navigation to
  // the session-expired context, which is why both are wired.
  pulse.addEventListener(PULSE_ERROR_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as PulseErrorDetail | undefined;
    const status = typeof detail?._httpStatus === 'number' ? detail._httpStatus : undefined;
    const message = typeof detail?._message === 'string' ? detail._message : 'unknown Pulse error';

    console.error('[mcp-pulse] tableau-pulse reported an error', { status, message });

    if (status === 401 || status === 403) {
      options.onAuthError?.();
      return;
    }

    options.onLoadError?.(message);
  });

  pulse.addEventListener(PULSE_URL_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as PulseUrlChangedDetail | undefined;

    if (detail?._context === PULSE_SESSION_EXPIRED_CONTEXT) {
      console.error('[mcp-pulse] tableau-pulse reported an expired embed session');
      options.onAuthError?.();
    }
  });

  container.replaceChildren(pulse);

  return pulse;
}

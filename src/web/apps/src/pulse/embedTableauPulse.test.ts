/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTableauPulseElement, embedTableauPulse } from './embedTableauPulse.js';
import {
  PULSE_ERROR_EVENT,
  PULSE_FIRST_SIZE_EVENT,
  PULSE_SESSION_EXPIRED_CONTEXT,
  PULSE_SIZE_CHANGED_EVENT,
  PULSE_URL_CHANGED_EVENT,
} from './pulseState/pulseEmbeddingApiTypes.js';

const METRIC_URL = 'https://tableau.example.com/pulse/site/example/metrics/metric-1';
const TOKEN = 'fake-embed-jwt';

describe('createTableauPulseElement', () => {
  it('sets the source and credential attributes', () => {
    const pulse = createTableauPulseElement({ metricUrl: METRIC_URL, token: TOKEN });

    expect(pulse.tagName.toLowerCase()).toBe('tableau-pulse');
    expect(pulse.getAttribute('src')).toBe(METRIC_URL);
    expect(pulse.getAttribute('token')).toBe(TOKEN);
  });

  it('does not pin the layout attribute for the default layout', () => {
    const pulse = createTableauPulseElement({
      metricUrl: METRIC_URL,
      token: TOKEN,
      layout: 'default',
    });

    expect(pulse.hasAttribute('layout')).toBe(false);
  });

  it('sets the layout attribute for a non-default layout', () => {
    const pulse = createTableauPulseElement({
      metricUrl: METRIC_URL,
      token: TOKEN,
      layout: 'card',
    });

    expect(pulse.getAttribute('layout')).toBe('card');
  });
});

describe('embedTableauPulse', () => {
  beforeEach(() => {
    const container = document.createElement('div');
    container.id = 'tableauVizContainer';
    document.body.appendChild(container);

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('mounts the element into the container', () => {
    const pulse = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN });

    expect(pulse).toBeDefined();
    expect(document.getElementById('tableauVizContainer')?.querySelector('tableau-pulse')).toBe(
      pulse,
    );
  });

  it('replaces a previously mounted element', () => {
    const first = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN });
    const second = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN });

    expect(first).not.toBe(second);
    expect(
      document.getElementById('tableauVizContainer')?.querySelectorAll('tableau-pulse'),
    ).toHaveLength(1);
  });

  it('returns undefined when the container is missing', () => {
    document.body.replaceChildren();

    expect(embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN })).toBeUndefined();
  });

  it('applies the reported height on the first size event', () => {
    const pulse = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN });

    pulse?.dispatchEvent(
      new CustomEvent(PULSE_FIRST_SIZE_EVENT, { detail: { _width: 400, _height: 260 } }),
    );

    expect(pulse?.style.height).toBe('260px');
  });

  it('follows subsequent size changes', () => {
    const pulse = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN });

    pulse?.dispatchEvent(new CustomEvent(PULSE_FIRST_SIZE_EVENT, { detail: { _height: 260 } }));
    pulse?.dispatchEvent(new CustomEvent(PULSE_SIZE_CHANGED_EVENT, { detail: { _height: 520 } }));

    expect(pulse?.style.height).toBe('520px');
  });

  it('ignores a size event with no usable height', () => {
    const pulse = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN });

    pulse?.dispatchEvent(new CustomEvent(PULSE_FIRST_SIZE_EVENT, { detail: { _height: 300 } }));
    for (const detail of [{}, { _height: 0 }, { _height: -1 }, { _height: '400' }, undefined]) {
      pulse?.dispatchEvent(new CustomEvent(PULSE_SIZE_CHANGED_EVENT, { detail }));
    }

    expect(pulse?.style.height).toBe('300px');
  });

  it('routes a 401 pulse error to the auth handler', () => {
    const onAuthError = vi.fn();
    const onLoadError = vi.fn();

    const pulse = embedTableauPulse({
      metricUrl: METRIC_URL,
      token: TOKEN,
      onAuthError,
      onLoadError,
    });
    pulse?.dispatchEvent(
      new CustomEvent(PULSE_ERROR_EVENT, { detail: { _httpStatus: 401, _message: 'nope' } }),
    );

    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(onLoadError).not.toHaveBeenCalled();
  });

  it('routes a non-auth pulse error to the load handler', () => {
    const onAuthError = vi.fn();
    const onLoadError = vi.fn();

    const pulse = embedTableauPulse({
      metricUrl: METRIC_URL,
      token: TOKEN,
      onAuthError,
      onLoadError,
    });
    pulse?.dispatchEvent(
      new CustomEvent(PULSE_ERROR_EVENT, { detail: { _httpStatus: 500, _message: 'boom' } }),
    );

    expect(onLoadError).toHaveBeenCalledWith('boom');
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('treats a session-expired navigation as an auth failure', () => {
    const onAuthError = vi.fn();

    const pulse = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN, onAuthError });
    pulse?.dispatchEvent(
      new CustomEvent(PULSE_URL_CHANGED_EVENT, {
        detail: { _context: PULSE_SESSION_EXPIRED_CONTEXT },
      }),
    );

    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('ignores an ordinary navigation', () => {
    const onAuthError = vi.fn();

    const pulse = embedTableauPulse({ metricUrl: METRIC_URL, token: TOKEN, onAuthError });
    pulse?.dispatchEvent(
      new CustomEvent(PULSE_URL_CHANGED_EVENT, { detail: { _context: 'drill-down' } }),
    );

    expect(onAuthError).not.toHaveBeenCalled();
  });
});

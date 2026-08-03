import { describe, expect, it } from 'vitest';

import { constructPulseMetricWebUrl } from './pulseUrlUtils.js';

const METRIC_ID = 'CF32DDCC-362B-4869-9487-37DA4D152552';

describe('constructPulseMetricWebUrl', () => {
  it('builds the site-scoped Pulse path', () => {
    expect(
      constructPulseMetricWebUrl('https://example.online.tableau.com', 'my-site', METRIC_ID),
    ).toBe(`https://example.online.tableau.com/pulse/site/my-site/metrics/${METRIC_ID}`);
  });

  it('tolerates a server URL with a trailing slash or an existing path', () => {
    expect(
      constructPulseMetricWebUrl('https://example.online.tableau.com/', 'my-site', METRIC_ID),
    ).toBe(`https://example.online.tableau.com/pulse/site/my-site/metrics/${METRIC_ID}`);
  });

  it('drops the site segment for the default site', () => {
    for (const siteName of ['', 'Default']) {
      expect(constructPulseMetricWebUrl('https://example.com', siteName, METRIC_ID)).toBe(
        `https://example.com/pulse/metrics/${METRIC_ID}`,
      );
    }
  });

  it('encodes a site name that needs it', () => {
    expect(constructPulseMetricWebUrl('https://example.com', 'my site', METRIC_ID)).toContain(
      '/pulse/site/my%20site/metrics/',
    );
  });
});

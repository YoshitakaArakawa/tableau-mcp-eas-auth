/**
 * @vitest-environment jsdom
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../embed/getEmbedTokenToolClient.js');
vi.mock('../embed/loadTableauEmbeddingApi.js');
vi.mock('../embed/openInTableauLink.js');
vi.mock('../shared/recordEventClient.js');
vi.mock('./embedTableauPulse.js');
vi.mock('./pulseState/pulseStateBridge.js');

import { callGetEmbedTokenTool } from '../embed/getEmbedTokenToolClient.js';
import { loadTableauEmbeddingApi } from '../embed/loadTableauEmbeddingApi.js';
import { setupOpenInTableauLink } from '../embed/openInTableauLink.js';
import { recordEvent } from '../shared/recordEventClient.js';
import { embedTableauPulse } from './embedTableauPulse.js';
import { handlePulseToolResult } from './handlePulseToolResult.js';
import { startPulseStateBridge } from './pulseState/pulseStateBridge.js';

const METRIC_URL = 'https://tableau.example.com/pulse/site/example/metrics/metric-1';

function makeResult(payload: unknown, extraBlocks: string[] = []): CallToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload) },
      ...extraBlocks.map((text) => ({ type: 'text' as const, text })),
    ],
  };
}

function fullPayload(): Record<string, unknown> {
  return {
    url: METRIC_URL,
    layout: 'card',
    data: { id: 'metric-1', objectType: 'pulse-metric', name: 'Weekly Sales' },
  };
}

function errorUiPresent(): boolean {
  return document.querySelector('.mcp-app-error') != null;
}

describe('handlePulseToolResult', () => {
  let app: App;

  beforeEach(() => {
    const main = document.createElement('div');
    main.className = 'main';
    const container = document.createElement('div');
    container.id = 'tableauVizContainer';
    main.appendChild(container);
    document.body.appendChild(main);

    app = {
      getHostCapabilities: vi.fn().mockReturnValue({ serverTools: {} }),
      callServerTool: vi.fn(),
    } as unknown as App;

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(loadTableauEmbeddingApi).mockResolvedValue(undefined);
    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('fake-embed-jwt');
    vi.mocked(embedTableauPulse).mockImplementation(() => {
      const element = document.createElement('tableau-pulse');
      document.getElementById('tableauVizContainer')?.replaceChildren(element);
      return element;
    });
    vi.mocked(startPulseStateBridge).mockReturnValue(() => {});
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('embeds the metric and starts the state bridge', async () => {
    await handlePulseToolResult(app, makeResult(fullPayload(), ['guidance text']));

    expect(loadTableauEmbeddingApi).toHaveBeenCalledWith(METRIC_URL, 'tableau-pulse');
    expect(callGetEmbedTokenTool).toHaveBeenCalledWith(app, 'pulse');
    expect(embedTableauPulse).toHaveBeenCalledWith(
      expect.objectContaining({ metricUrl: METRIC_URL, token: 'fake-embed-jwt', layout: 'card' }),
    );
    expect(startPulseStateBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { id: 'metric-1', name: 'Weekly Sales', layout: 'card' },
      }),
    );
    expect(setupOpenInTableauLink).toHaveBeenCalledWith(app, METRIC_URL, expect.anything());
    expect(errorUiPresent()).toBe(false);
  });

  it('renders without the bridge when the payload carries no identity', async () => {
    await handlePulseToolResult(app, makeResult({ url: METRIC_URL }));

    expect(embedTableauPulse).toHaveBeenCalled();
    expect(startPulseStateBridge).not.toHaveBeenCalled();
    expect(errorUiPresent()).toBe(false);
  });

  it('degrades to no bridge when the identity block has an unexpected shape', async () => {
    await handlePulseToolResult(
      app,
      makeResult({ url: METRIC_URL, data: { id: 'metric-1', objectType: 'something-new' } }),
    );

    expect(embedTableauPulse).toHaveBeenCalled();
    expect(startPulseStateBridge).not.toHaveBeenCalled();
    expect(errorUiPresent()).toBe(false);
  });

  it('ignores an unknown layout rather than failing the render', async () => {
    await handlePulseToolResult(app, makeResult({ url: METRIC_URL, layout: 'carousel' }));

    expect(embedTableauPulse).toHaveBeenCalledWith(expect.objectContaining({ layout: undefined }));
  });

  it('disposes the previous bridge before starting a new one', async () => {
    const disposeFirst = vi.fn();
    vi.mocked(startPulseStateBridge).mockReturnValueOnce(disposeFirst);

    await handlePulseToolResult(app, makeResult(fullPayload()));
    await handlePulseToolResult(app, makeResult(fullPayload()));

    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(startPulseStateBridge).toHaveBeenCalledTimes(2);
  });

  it('shows the error UI when the tool returned an error', async () => {
    await handlePulseToolResult(app, {
      isError: true,
      content: [{ type: 'text', text: 'Pulse is disabled on this Tableau Cloud site.' }],
    });

    expect(errorUiPresent()).toBe(true);
    expect(embedTableauPulse).not.toHaveBeenCalled();
  });

  it('shows the error UI when the embedding API fails to load', async () => {
    vi.mocked(loadTableauEmbeddingApi).mockRejectedValue(new Error('offline'));

    await handlePulseToolResult(app, makeResult(fullPayload()));

    expect(errorUiPresent()).toBe(true);
    expect(embedTableauPulse).not.toHaveBeenCalled();
  });

  it('shows the error UI when no embed credential can be minted', async () => {
    vi.mocked(callGetEmbedTokenTool).mockRejectedValue(new Error('not available'));

    await handlePulseToolResult(app, makeResult(fullPayload()));

    expect(errorUiPresent()).toBe(true);
    expect(embedTableauPulse).not.toHaveBeenCalled();
    // The cause distinguishes a minting failure from the two runtime auth-error paths below,
    // so AUTH_ERROR reports can be diagnosed instead of just recording "something failed".
    expect(recordEvent).toHaveBeenCalledWith(app, 'AUTH_ERROR', 'mint failed: not available');
  });

  it('records the runtime auth-error cause reported by embedTableauPulse', async () => {
    vi.mocked(embedTableauPulse).mockImplementation((options) => {
      const element = document.createElement('tableau-pulse');
      document.getElementById('tableauVizContainer')?.replaceChildren(element);
      options.onAuthError?.('pulseerror status=401');
      return element;
    });

    await handlePulseToolResult(app, makeResult(fullPayload()));

    expect(recordEvent).toHaveBeenCalledWith(app, 'AUTH_ERROR', 'pulseerror status=401');
  });

  it('shows the error UI for an unparseable first delivery', async () => {
    await handlePulseToolResult(app, { content: [{ type: 'text', text: 'not json' }] });

    expect(errorUiPresent()).toBe(true);
  });

  it('restores the metric from structuredContent when the host re-delivers synthesized content (reload)', async () => {
    // Measured on ChatGPT (20260804, viz app): after a page reload the host re-delivers content
    // synthesized from the STORED structuredContent, not the original content blocks.
    await handlePulseToolResult(app, {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: fullPayload(),
    });

    expect(embedTableauPulse).toHaveBeenCalledWith(
      expect.objectContaining({ metricUrl: METRIC_URL, layout: 'card' }),
    );
    expect(errorUiPresent()).toBe(false);
  });

  it('still shows the error UI when the reload delivery carries an empty structuredContent', async () => {
    await handlePulseToolResult(app, {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {},
    });

    expect(embedTableauPulse).not.toHaveBeenCalled();
    expect(errorUiPresent()).toBe(true);
  });

  it('keeps the mounted metric on an unparseable re-delivery', async () => {
    await handlePulseToolResult(app, makeResult(fullPayload()));
    await handlePulseToolResult(app, { content: [{ type: 'text', text: 'not json' }] });

    expect(errorUiPresent()).toBe(false);
    expect(document.querySelector('tableau-pulse')).not.toBeNull();
    expect(recordEvent).toHaveBeenCalledWith(app, 'PARSE_ERROR_IGNORED', expect.anything());
  });

  it('keeps the mounted metric on an empty re-delivery', async () => {
    await handlePulseToolResult(app, makeResult(fullPayload()));
    vi.mocked(embedTableauPulse).mockClear();

    await handlePulseToolResult(app, { content: [] });

    expect(errorUiPresent()).toBe(false);
    expect(embedTableauPulse).not.toHaveBeenCalled();
    expect(document.querySelector('tableau-pulse')).not.toBeNull();
  });
});

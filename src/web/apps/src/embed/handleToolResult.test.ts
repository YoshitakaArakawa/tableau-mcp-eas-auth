/**
 * @vitest-environment jsdom
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleToolResult } from './handleToolResult.js';

// Mock dependencies
vi.mock('./getEmbedTokenToolClient.js');
vi.mock('./embedTableauViz.js');
vi.mock('./loadTableauEmbeddingApi.js');
vi.mock('./openInTableauLink.js');
vi.mock('../shared/recordEventClient.js');
vi.mock('./vizState/vizStateBridge.js');

import { recordEvent } from '../shared/recordEventClient.js';
import { embedTableauViz } from './embedTableauViz.js';
import { callGetEmbedTokenTool } from './getEmbedTokenToolClient.js';
import { loadTableauEmbeddingApi } from './loadTableauEmbeddingApi.js';
import { setupOpenInTableauLink } from './openInTableauLink.js';
import { startVizStateBridge } from './vizState/vizStateBridge.js';

describe('handleToolResult', () => {
  let mockApp: App;

  beforeEach(() => {
    // Set up DOM
    const main = document.createElement('div');
    main.className = 'main';
    const container = document.createElement('div');
    container.id = 'tableauVizContainer';
    main.appendChild(container);
    document.body.appendChild(main);

    // Create mock app
    mockApp = {
      getHostCapabilities: vi.fn().mockReturnValue({ serverTools: {} }),
      callServerTool: vi.fn(),
    } as unknown as App;

    // Mute console.error output during tests
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Default mock: embedding API loads successfully for most tests
    vi.mocked(loadTableauEmbeddingApi).mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('should show error UI when tool returns error result (isError: true)', async () => {
    const errorResult: CallToolResult = {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Tool execution failed',
        },
      ],
    };

    await handleToolResult(mockApp, errorResult);

    // Flush async
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // NO tableau-viz rendered
    expect(container?.querySelector('tableau-viz')).toBeNull();

    // error UI IS displayed
    const errorElement = container?.querySelector('.mcp-app-error');
    expect(errorElement).toBeTruthy();

    // New two-line layout: heading + subtitle
    expect(errorElement?.querySelector('.mcp-app-error-heading')?.textContent).toBe(
      'Unable to load this Tableau view',
    );
    expect(errorElement?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'The tool request was unsuccessful.',
    );

    // Assert embedTableauViz was NOT called
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();
  });

  it('should show error UI when tool result is null or undefined', async () => {
    // Test with undefined
    await handleToolResult(mockApp, undefined as any);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // NO tableau-viz rendered
    expect(container?.querySelector('tableau-viz')).toBeNull();

    // error UI IS displayed
    const errorElement = container?.querySelector('.mcp-app-error');
    expect(errorElement).toBeTruthy();

    // New two-line layout: heading + subtitle
    expect(errorElement?.querySelector('.mcp-app-error-heading')?.textContent).toBe(
      'Unable to load this Tableau view',
    );
    expect(errorElement?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'The tool request was unsuccessful.',
    );

    // Assert embedTableauViz was NOT called
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();

    // Clean up for null test
    vi.mocked(embedTableauViz).mockClear();

    // Test with null
    await handleToolResult(mockApp, null as any);
    await new Promise((r) => setTimeout(r, 0));

    const errorElement2 = container?.querySelector('.mcp-app-error');
    expect(container?.querySelector('tableau-viz')).toBeNull();
    expect(errorElement2).toBeTruthy();
    expect(errorElement2?.querySelector('.mcp-app-error-heading')?.textContent).toBe(
      'Unable to load this Tableau view',
    );
    expect(errorElement2?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'The tool request was unsuccessful.',
    );
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();
  });

  it('should show error UI when tool result is malformed JSON', async () => {
    const malformedResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: 'not json',
        },
      ],
    };

    await handleToolResult(mockApp, malformedResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // NO tableau-viz rendered
    expect(container?.querySelector('tableau-viz')).toBeNull();

    // error UI IS displayed
    const errorElement = container?.querySelector('.mcp-app-error');
    expect(errorElement).toBeTruthy();

    // New two-line layout: heading + subtitle
    expect(errorElement?.querySelector('.mcp-app-error-heading')?.textContent).toBe(
      'Unable to load this Tableau view',
    );
    expect(errorElement?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'The response was not in the expected format.',
    );

    // Assert embedTableauViz was NOT called
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();
  });

  it('should show error UI when tool result has valid JSON but missing url field', async () => {
    const missingUrlResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ notUrl: 'something else' }),
        },
      ],
    };

    await handleToolResult(mockApp, missingUrlResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // Assert NO tableau-viz rendered
    expect(container?.querySelector('tableau-viz')).toBeNull();

    // Assert error UI IS displayed
    expect(container?.querySelector('.mcp-app-error')).toBeTruthy();
  });

  it('should show error UI when embedding API script fails to load', async () => {
    const validResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
          }),
        },
      ],
    };

    vi.mocked(loadTableauEmbeddingApi).mockRejectedValue(new Error('Script load failed'));

    await handleToolResult(mockApp, validResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // NO tableau-viz rendered
    expect(container?.querySelector('tableau-viz')).toBeNull();

    // error UI IS displayed
    const errorElement = container?.querySelector('.mcp-app-error');
    expect(errorElement).toBeTruthy();

    // New two-line layout: heading + subtitle
    expect(errorElement?.querySelector('.mcp-app-error-heading')?.textContent).toBe(
      'Unable to load this Tableau view',
    );
    expect(errorElement?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'The visualization failed to load.',
    );

    // Assert downstream functions were NOT called
    expect(vi.mocked(callGetEmbedTokenTool)).not.toHaveBeenCalled();
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();
  });

  it('should show error UI when token minting fails', async () => {
    const validResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
          }),
        },
      ],
    };

    vi.mocked(callGetEmbedTokenTool).mockRejectedValue(new Error('Token minting failed'));

    await handleToolResult(mockApp, validResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // NO tableau-viz rendered
    expect(container?.querySelector('tableau-viz')).toBeNull();

    // error UI IS displayed
    const errorElement = container?.querySelector('.mcp-app-error');
    expect(errorElement).toBeTruthy();

    // New two-line layout: heading + subtitle
    expect(errorElement?.querySelector('.mcp-app-error-heading')?.textContent).toBe(
      'Unable to load this Tableau view',
    );
    expect(errorElement?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'Authentication was unsuccessful.',
    );

    // Assert embedTableauViz was NOT called
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();

    // The cause distinguishes a minting failure from a runtime vizloaderror in telemetry.
    expect(recordEvent).toHaveBeenCalledWith(
      mockApp,
      'AUTH_ERROR',
      'mint failed: Token minting failed',
    );
  });

  it('runtime: replaces viz with error UI when vizloaderror fires after embedding', async () => {
    const validResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
          }),
        },
      ],
    };

    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('test-token');

    // Override embedTableauViz to simulate runtime viz load error
    vi.mocked(embedTableauViz).mockImplementation((_url, _token, onError) => {
      const container = document.getElementById('tableauVizContainer');
      const viz = document.createElement('tableau-viz');
      container?.replaceChildren(viz);
      // Simulate runtime vizloaderror event
      onError?.('vizloaderror: Authentication failed');
      return viz;
    });

    await handleToolResult(mockApp, validResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // viz was replaced (removed)
    expect(container?.querySelector('tableau-viz')).toBeNull();

    // error UI IS displayed
    const errorElement = container?.querySelector('.mcp-app-error');
    expect(errorElement).toBeTruthy();

    // New two-line layout: heading + subtitle
    expect(errorElement?.querySelector('.mcp-app-error-heading')?.textContent).toBe(
      'Unable to load this Tableau view',
    );
    expect(errorElement?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'Authentication was unsuccessful.',
    );

    // The cause reported by embedTableauViz reaches record-event, so a runtime vizloaderror is
    // distinguishable from a minting failure in telemetry.
    expect(recordEvent).toHaveBeenCalledWith(
      mockApp,
      'AUTH_ERROR',
      'vizloaderror: Authentication failed',
    );
  });

  it('happy path: should successfully embed viz when all operations succeed', async () => {
    const validResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
          }),
        },
      ],
    };

    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('test-token-123');
    vi.mocked(embedTableauViz).mockImplementation(() => undefined);
    vi.mocked(setupOpenInTableauLink).mockImplementation(() => {});

    await handleToolResult(mockApp, validResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // Assert NO error UI displayed
    expect(container?.querySelector('.mcp-app-error')).toBeNull();

    // Assert embedTableauViz WAS called once
    expect(vi.mocked(embedTableauViz)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embedTableauViz)).toHaveBeenCalledWith(
      'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
      'test-token-123',
      expect.any(Function),
    );

    // Assert setupOpenInTableauLink WAS called
    expect(vi.mocked(setupOpenInTableauLink)).toHaveBeenCalledTimes(1);
  });

  it('no-ops on an empty (dataless) delivery instead of showing PARSE_ERROR', async () => {
    // The host can re-fire ui/notifications/tool-result on a re-render/re-mount with a
    // protocol-legal but empty result (content: [], no structuredContent). There is nothing to
    // embed, so this must be a silent no-op — NOT a PARSE_ERROR.
    const emptyResult: CallToolResult = {
      content: [],
    };

    await handleToolResult(mockApp, emptyResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // NO error UI displayed
    expect(container?.querySelector('.mcp-app-error')).toBeNull();

    // No embedding attempted and no telemetry event recorded
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing render when an empty re-delivery arrives', async () => {
    // First delivery: happy path renders a viz.
    const validResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
          }),
        },
      ],
    };

    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('test-token-123');
    vi.mocked(embedTableauViz).mockImplementation((_url, _token) => {
      const container = document.getElementById('tableauVizContainer');
      const viz = document.createElement('tableau-viz');
      container?.replaceChildren(viz);
      return viz;
    });
    vi.mocked(setupOpenInTableauLink).mockImplementation(() => {});

    await handleToolResult(mockApp, validResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('tableau-viz')).toBeTruthy();

    // Second delivery: empty re-fire. Must leave the rendered viz intact and show no error.
    await handleToolResult(mockApp, { content: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(container?.querySelector('tableau-viz')).toBeTruthy();
    expect(container?.querySelector('.mcp-app-error')).toBeNull();
  });

  it('shows PARSE_ERROR when the first delivery is unparseable and nothing is rendered yet', async () => {
    const unparseableResult: CallToolResult = {
      content: [{ type: 'text', text: 'col1,col2\n1,2' }],
    };

    await handleToolResult(mockApp, unparseableResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');

    // Nothing was mounted before this delivery, so the parse failure surfaces as the error UI.
    expect(container?.querySelector('tableau-viz')).toBeNull();
    const errorElement = container?.querySelector('.mcp-app-error');
    expect(errorElement).toBeTruthy();
    expect(errorElement?.querySelector('.mcp-app-error-message')?.textContent).toBe(
      'The response was not in the expected format.',
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(mockApp, 'PARSE_ERROR', expect.anything());
  });

  it('restores the viz from structuredContent when the host re-delivers synthesized content (reload)', async () => {
    // Measured on ChatGPT (20260804): after a page reload the host does not preserve the original
    // content blocks — it re-delivers content synthesized from the STORED structuredContent. With
    // the payload mirrored into structuredContent, that delivery must re-render, not PARSE_ERROR.
    const reloadDelivery: CallToolResult = {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
        data: { luid: 'view-luid-1', objectType: 'view', name: 'My View' },
      },
    };

    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('test-token-123');
    vi.mocked(embedTableauViz).mockImplementation(() => undefined);
    vi.mocked(setupOpenInTableauLink).mockImplementation(() => {});

    await handleToolResult(mockApp, reloadDelivery);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('.mcp-app-error')).toBeNull();
    expect(vi.mocked(embedTableauViz)).toHaveBeenCalledWith(
      'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
      'test-token-123',
      expect.any(Function),
    );
  });

  it('restores the viz from structuredContent when content is empty but structuredContent is not', async () => {
    const structuredOnlyDelivery: CallToolResult = {
      content: [],
      structuredContent: {
        url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
      },
    };

    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('test-token-123');
    vi.mocked(embedTableauViz).mockImplementation(() => undefined);
    vi.mocked(setupOpenInTableauLink).mockImplementation(() => {});

    await handleToolResult(mockApp, structuredOnlyDelivery);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('.mcp-app-error')).toBeNull();
    expect(vi.mocked(embedTableauViz)).toHaveBeenCalledTimes(1);
  });

  it('still shows PARSE_ERROR when the reload delivery carries an empty structuredContent', async () => {
    // A chat rendered before structuredContent existed re-delivers `{}` on both channels; the
    // failure mode stays a PARSE_ERROR with the original content error.
    const legacyReloadDelivery: CallToolResult = {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {},
    };

    await handleToolResult(mockApp, legacyReloadDelivery);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('.mcp-app-error')).toBeTruthy();
    expect(vi.mocked(embedTableauViz)).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(mockApp, 'PARSE_ERROR', expect.anything());
  });

  it('keeps the mounted viz when an unparseable re-delivery arrives after a render', async () => {
    // Observed on a real device: the host can re-deliver non-render tool results (e.g. a
    // get-view-data CSV fetched during an analysis turn) to the already-mounted widget.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First delivery: happy path renders a viz.
    const validResult: CallToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view',
          }),
        },
      ],
    };

    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('test-token-123');
    vi.mocked(embedTableauViz).mockImplementation(() => {
      const container = document.getElementById('tableauVizContainer');
      const viz = document.createElement('tableau-viz');
      container?.replaceChildren(viz);
      return viz;
    });
    vi.mocked(setupOpenInTableauLink).mockImplementation(() => {});

    await handleToolResult(mockApp, validResult);
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('tableau-viz')).toBeTruthy();

    // Second delivery: unparseable content. Must be ignored — the viz stays, no error UI,
    // no re-embed; only a log line and a telemetry event.
    await handleToolResult(mockApp, {
      content: [{ type: 'text', text: 'col1,col2\n1,2' }],
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(container?.querySelector('tableau-viz')).toBeTruthy();
    expect(container?.querySelector('.mcp-app-error')).toBeNull();
    expect(vi.mocked(embedTableauViz)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      mockApp,
      'PARSE_ERROR_IGNORED',
      expect.anything(),
    );
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      mockApp,
      'PARSE_ERROR',
      expect.anything(),
    );
  });

  it('reports telemetry with the tool error message when a tool error occurs', async () => {
    const errorResult: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'Tool execution failed' }],
    };

    await handleToolResult(mockApp, errorResult);
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      mockApp,
      'TOOL_ERROR',
      'Tool execution failed',
    );
  });

  it('reports telemetry with undefined cause when the tool result is null', async () => {
    await handleToolResult(mockApp, null as any);
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(mockApp, 'TOOL_ERROR', undefined);
  });
});

describe('handleToolResult viz state bridge', () => {
  let mockApp: App;

  const VIEW_URL = 'https://prod-uswest-c.online.tableau.com/site/mysite/views/workbook/view';

  /** A delivery as the render tools send it: payload block first, guidance text block second. */
  function makeResult(data?: Record<string, unknown>): CallToolResult {
    return {
      content: [
        { type: 'text', text: JSON.stringify(data ? { url: VIEW_URL, data } : { url: VIEW_URL }) },
        { type: 'text', text: 'Guidance for the model about the rendered viz.' },
      ],
    };
  }

  /** Mounts a real element so the handler has something to hand the bridge. */
  function mountViz(): void {
    vi.mocked(embedTableauViz).mockImplementation(() => {
      const container = document.getElementById('tableauVizContainer');
      const viz = document.createElement('tableau-viz');
      container?.replaceChildren(viz);
      return viz;
    });
  }

  beforeEach(() => {
    const main = document.createElement('div');
    main.className = 'main';
    const container = document.createElement('div');
    container.id = 'tableauVizContainer';
    main.appendChild(container);
    document.body.appendChild(main);

    mockApp = {
      getHostCapabilities: vi.fn().mockReturnValue({ serverTools: {} }),
      callServerTool: vi.fn(),
    } as unknown as App;

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadTableauEmbeddingApi).mockResolvedValue(undefined);
    vi.mocked(callGetEmbedTokenTool).mockResolvedValue('test-token-123');
    vi.mocked(setupOpenInTableauLink).mockImplementation(() => {});
    vi.mocked(startVizStateBridge).mockReturnValue(() => {});
    mountViz();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('starts the bridge with a view identity when the payload names a view', async () => {
    await handleToolResult(
      mockApp,
      makeResult({ luid: 'view-luid', objectType: 'view', name: 'Sales' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(startVizStateBridge)).toHaveBeenCalledTimes(1);

    const options = vi.mocked(startVizStateBridge).mock.calls[0][0];
    expect(options.app).toBe(mockApp);
    expect(options.viz).toBe(document.querySelector('tableau-viz'));
    expect(options.identity).toEqual({
      view: { luid: 'view-luid', name: 'Sales' },
      workbook: {},
    });
  });

  it('starts the bridge with a workbook identity when the payload names a workbook', async () => {
    await handleToolResult(
      mockApp,
      makeResult({ luid: 'wb-luid', objectType: 'workbook', name: 'Superstore' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(startVizStateBridge).mock.calls[0][0].identity).toEqual({
      workbook: { luid: 'wb-luid', name: 'Superstore' },
      view: {},
    });
  });

  it('renders without starting the bridge when the payload carries no identity', async () => {
    await handleToolResult(mockApp, makeResult());
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('tableau-viz')).toBeTruthy();
    expect(container?.querySelector('.mcp-app-error')).toBeNull();
    expect(vi.mocked(startVizStateBridge)).not.toHaveBeenCalled();
  });

  it('disposes the previous bridge before starting one on the re-mounted element', async () => {
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    vi.mocked(startVizStateBridge)
      .mockReturnValueOnce(disposeFirst)
      .mockReturnValueOnce(disposeSecond);

    const result = makeResult({ luid: 'view-luid', objectType: 'view', name: 'Sales' });

    await handleToolResult(mockApp, result);
    await new Promise((r) => setTimeout(r, 0));

    expect(disposeFirst).not.toHaveBeenCalled();

    await handleToolResult(mockApp, result);
    await new Promise((r) => setTimeout(r, 0));

    // The first element was orphaned by the re-embed, so its bridge must be stopped.
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(disposeSecond).not.toHaveBeenCalled();
    expect(vi.mocked(startVizStateBridge)).toHaveBeenCalledTimes(2);
  });

  it('still renders the viz when starting the bridge throws', async () => {
    vi.mocked(startVizStateBridge).mockImplementation(() => {
      throw new Error('bridge exploded');
    });

    await handleToolResult(
      mockApp,
      makeResult({ luid: 'view-luid', objectType: 'view', name: 'Sales' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('tableau-viz')).toBeTruthy();
    expect(container?.querySelector('.mcp-app-error')).toBeNull();
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('does not start the bridge when the container was missing and no element was mounted', async () => {
    vi.mocked(embedTableauViz).mockReturnValue(undefined);

    await handleToolResult(
      mockApp,
      makeResult({ luid: 'view-luid', objectType: 'view', name: 'Sales' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(startVizStateBridge)).not.toHaveBeenCalled();
  });

  it('renders without a bridge when the identity block is an unrecognized shape', async () => {
    await handleToolResult(
      mockApp,
      makeResult({ luid: 'x-luid', objectType: 'datasource', name: 'Sales' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // An identity this client cannot map costs the bridge, never the render.
    const container = document.getElementById('tableauVizContainer');
    expect(container?.querySelector('tableau-viz')).toBeTruthy();
    expect(container?.querySelector('.mcp-app-error')).toBeNull();
    expect(vi.mocked(startVizStateBridge)).not.toHaveBeenCalled();
  });
});

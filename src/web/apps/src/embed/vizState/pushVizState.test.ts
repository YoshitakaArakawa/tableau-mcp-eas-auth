/**
 * @vitest-environment jsdom
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/recordEventClient.js');

import { recordEvent } from '../../shared/recordEventClient.js';
import { captureVizState } from './captureVizState.js';
import { BASE_CAVEATS, PUSH_BUDGET_BYTES, type VizStatePayload } from './payload.js';
import { PUSH_PREAMBLE, pushVizState } from './pushVizState.js';
import { utf8ByteLength } from './sanitize.js';
import {
  FAKE_EMBED_TOKEN,
  makeCategoricalFilter,
  makeDashboardWorkbook,
  makeFakeVizElement,
  makeWorksheet,
} from './testFakes.js';

type MockApp = App & { updateModelContext: ReturnType<typeof vi.fn> };

function makeApp(overrides: Partial<Record<string, unknown>> = {}): MockApp {
  return {
    getHostCapabilities: vi.fn().mockReturnValue({ updateModelContext: { text: true } }),
    updateModelContext: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as MockApp;
}

function pushedText(app: MockApp): string {
  const [params] = app.updateModelContext.mock.calls[0] as [
    { content: Array<{ type: string; text: string }> },
  ];
  return params.content[0].text;
}

function makePayload(overrides: Partial<VizStatePayload> = {}): VizStatePayload {
  return {
    capturedAt: '2026-08-01T00:00:00.000Z',
    workbook: { name: 'Superstore', luid: 'wb-luid' },
    view: { name: 'Sales', luid: 'view-luid' },
    activeSheet: { name: 'Sales Dashboard', sheetType: 'dashboard' },
    filters: [],
    parameters: [],
    selection: { marks: [], columns: [], truncated: false },
    caveats: [...BASE_CAVEATS],
    ...overrides,
  };
}

describe('pushVizState', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes a preamble followed by the payload JSON', async () => {
    const app = makeApp();
    const payload = makePayload();

    await pushVizState(app, payload);

    expect(app.updateModelContext).toHaveBeenCalledTimes(1);
    const text = pushedText(app);
    const [preamble, json] = text.split('\n');

    expect(preamble).toBe(PUSH_PREAMBLE);
    // The guidance must name the current-view framing and the fallback query route.
    expect(preamble).toContain('what the user currently sees');
    expect(preamble).toContain('query-datasource');
    expect(preamble).toContain('bounded sample');
    expect(preamble).toContain('cross-check');
    // The leak test rejects any pushed text matching /token/i; the preamble must satisfy it too.
    expect(preamble).not.toMatch(/token/i);
    expect(JSON.parse(json)).toEqual(payload);
  });

  it('does not push when the host does not accept context updates', async () => {
    const app = makeApp({ getHostCapabilities: vi.fn().mockReturnValue({ serverTools: true }) });

    await pushVizState(app, makePayload());

    expect(app.updateModelContext).not.toHaveBeenCalled();
  });

  it('does not push when getHostCapabilities returns nothing', async () => {
    const app = makeApp({ getHostCapabilities: vi.fn().mockReturnValue(undefined) });

    await pushVizState(app, makePayload());

    expect(app.updateModelContext).not.toHaveBeenCalled();
  });

  it('swallows a rejected update and reports it', async () => {
    const app = makeApp({
      updateModelContext: vi.fn().mockRejectedValue(new Error('host said no')),
    });

    await expect(pushVizState(app, makePayload())).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      '[mcp-app] viz state push failed',
      expect.any(Error),
    );
    expect(recordEvent).toHaveBeenCalledWith(app, 'VIZ_STATE_PUSH_ERROR', expect.any(Error));
  });

  it('keeps the whole pushed string, preamble included, inside the budget', async () => {
    const app = makeApp();
    const payload = makePayload({
      data: {
        sheet: 'Sales',
        columns: ['Region', 'Category', 'Sales', 'Profit', 'Quantity'],
        rows: Array.from({ length: 4000 }, (_, i) => [
          `Region ${i}`,
          'Furniture'.repeat(4),
          '1,234,567',
          '89,012',
          '42',
        ]),
        truncated: false,
        totalRowCount: 4000,
        selectionActive: false,
      },
    });

    await pushVizState(app, payload);

    const text = pushedText(app);
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(PUSH_BUDGET_BYTES);
    expect(text).toContain('JSON follows.');
  });
});

describe('pushVizState leak safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never pushes the embed token, through the real capture-and-push path', async () => {
    // The fake viz element carries the embed JWT in its `token` attribute and exposes the workbook
    // by two enumerable paths, matching what the Embedding API leaves behind. Anything that walked
    // the object graph instead of reading whitelisted fields would surface the token here.
    const viz = makeFakeVizElement(
      makeDashboardWorkbook({
        activeSheet: {
          name: 'Sales Dashboard',
          sheetType: 'dashboard',
          worksheets: [
            makeWorksheet({
              getFiltersAsync: vi.fn().mockResolvedValue([makeCategoricalFilter()]),
            }),
            makeWorksheet({ name: 'Sheet B' }),
          ],
        },
      }),
    );

    const app = makeApp();
    const payload = await captureVizState({
      viz,
      identity: {
        workbook: { name: 'Superstore', luid: 'wb-luid' },
        view: { name: 'Sales', luid: 'view-luid' },
      },
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    await pushVizState(app, payload);

    const text = pushedText(app);

    expect(text).not.toContain(FAKE_EMBED_TOKEN);
    expect(text).not.toMatch(/token/i);
    // Sanity: the push really did carry the captured state, so the assertions above mean something.
    expect(text).toContain('Superstore');
    expect(text).toContain('Region');
  });
});

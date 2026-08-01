import { describe, expect, it, vi } from 'vitest';

import { captureSummaryData, SUMMARY_PAGE_ROW_COUNT } from './captureSummaryData.js';
import { SerialQueue } from './serialQueue.js';
import { makeSummaryDataReader, makeWorksheet } from './testFakes.js';

/** Generous bounds: these tests are about call shape, not about timeouts. */
const makeQueue = (): SerialQueue =>
  new SerialQueue({ callTimeoutMs: 60_000, overallTimeoutMs: 120_000 });

describe('captureSummaryData', () => {
  it('reads exactly one page with ignoreSelection set', async () => {
    const reader = makeSummaryDataReader();
    const getSummaryDataReaderAsync = vi.fn().mockResolvedValue(reader);
    const worksheet = makeWorksheet({ getSummaryDataReaderAsync });
    const queue = makeQueue();

    const result = await captureSummaryData(worksheet, queue, false);
    queue.abort('disposed');

    expect(getSummaryDataReaderAsync).toHaveBeenCalledTimes(1);
    expect(getSummaryDataReaderAsync).toHaveBeenCalledWith(SUMMARY_PAGE_ROW_COUNT, {
      ignoreSelection: true,
    });

    // getAllPagesAsync ignores pageRowCount, so page 0 is the only page ever requested.
    expect(reader.getPageAsync).toHaveBeenCalledTimes(1);
    expect(reader.getPageAsync).toHaveBeenCalledWith(0);
    expect(reader.releaseAsync).toHaveBeenCalledTimes(1);

    expect(result.error).toBeUndefined();
    expect(result.block).toEqual({
      sheet: 'Sheet A',
      columns: ['Region', 'Sales'],
      rows: [
        ['West', '$1,000'],
        ['East', '$2,000'],
      ],
      truncated: false,
      totalRowCount: 2,
      selectionActive: false,
    });
  });

  it('passes selectionActive through to the block', async () => {
    const queue = makeQueue();
    const result = await captureSummaryData(makeWorksheet(), queue, true);
    queue.abort('disposed');

    expect(result.block?.selectionActive).toBe(true);
  });

  it('honours an explicit pageRowCount', async () => {
    const getSummaryDataReaderAsync = vi.fn().mockResolvedValue(makeSummaryDataReader());
    const queue = makeQueue();

    await captureSummaryData(makeWorksheet({ getSummaryDataReaderAsync }), queue, false, 25);
    queue.abort('disposed');

    expect(getSummaryDataReaderAsync).toHaveBeenCalledWith(25, { ignoreSelection: true });
  });

  it('marks the block truncated when the reader has more rows than the page', async () => {
    const reader = makeSummaryDataReader({ totalRowCount: 288 });
    const queue = makeQueue();

    const result = await captureSummaryData(
      makeWorksheet({ getSummaryDataReaderAsync: vi.fn().mockResolvedValue(reader) }),
      queue,
      false,
    );
    queue.abort('disposed');

    expect(result.block?.truncated).toBe(true);
    expect(result.block?.totalRowCount).toBe(288);
    expect(result.block?.rows).toHaveLength(2);
  });

  it('releases the reader even when the page read rejects', async () => {
    const reader = makeSummaryDataReader({
      getPageAsync: vi.fn().mockRejectedValue(new Error('page blew up')),
    });
    const queue = makeQueue();

    const result = await captureSummaryData(
      makeWorksheet({ getSummaryDataReaderAsync: vi.fn().mockResolvedValue(reader) }),
      queue,
      false,
    );
    queue.abort('disposed');

    expect(reader.releaseAsync).toHaveBeenCalledTimes(1);
    expect(result.block).toBeUndefined();
    expect(result.error).toBe('summary data unavailable: page blew up');
  });

  it('swallows a failing release', async () => {
    const reader = makeSummaryDataReader({
      releaseAsync: vi.fn().mockRejectedValue(new Error('release blew up')),
    });
    const queue = makeQueue();

    const result = await captureSummaryData(
      makeWorksheet({ getSummaryDataReaderAsync: vi.fn().mockResolvedValue(reader) }),
      queue,
      false,
    );
    queue.abort('disposed');

    expect(result.error).toBeUndefined();
    expect(result.block?.rows).toHaveLength(2);
  });

  it('reports a degraded reason when the reader API is missing', async () => {
    const queue = makeQueue();

    const result = await captureSummaryData(
      makeWorksheet({ getSummaryDataReaderAsync: undefined }),
      queue,
      false,
    );
    queue.abort('disposed');

    expect(result.block).toBeUndefined();
    expect(result.error).toBe(
      'summary data unavailable: getSummaryDataReaderAsync requires Embedding API 3.5+',
    );
  });

  it('reports an abort without rethrowing it', async () => {
    const queue = makeQueue();
    queue.abort('overall-timeout');

    const getSummaryDataReaderAsync = vi.fn().mockResolvedValue(makeSummaryDataReader());
    const result = await captureSummaryData(
      makeWorksheet({ getSummaryDataReaderAsync }),
      queue,
      false,
    );

    expect(getSummaryDataReaderAsync).not.toHaveBeenCalled();
    expect(result.block).toBeUndefined();
    expect(result.error).toBe(
      'summary data capture aborted: getSummaryDataReaderAsync (overall-timeout)',
    );
  });

  it('sanitizes cell values and column names', async () => {
    const reader = makeSummaryDataReader({
      totalRowCount: 1,
      getPageAsync: vi.fn().mockResolvedValue({
        totalRowCount: 1,
        columns: [{ fieldName: 'Re\u0000gion' }, { fieldName: { evil: true } }],
        data: [[{ formattedValue: 'ab' }, { formattedValue: 'x'.repeat(500) }]],
      }),
    });
    const queue = makeQueue();

    const result = await captureSummaryData(
      makeWorksheet({ getSummaryDataReaderAsync: vi.fn().mockResolvedValue(reader) }),
      queue,
      false,
    );
    queue.abort('disposed');

    expect(result.block?.columns).toEqual(['Region', '']);
    expect(result.block?.rows[0][0]).toBe('ab');
    expect(result.block?.rows[0][1]).toHaveLength(201);
  });
});

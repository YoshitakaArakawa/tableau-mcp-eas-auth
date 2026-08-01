import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureAbortedError, SerialQueue } from './serialQueue.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Captures the rejection eagerly so a fake-timer advance never trips an unhandled rejection. */
const settle = <T>(promise: Promise<T>): Promise<T | unknown> => promise.catch((error) => error);

describe('SerialQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs queued calls one at a time in FIFO order', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 1000, overallTimeoutMs: 10_000 });
    const order: string[] = [];

    // Descending durations: if the calls overlapped, 'c' would finish first.
    const a = queue.run('a', async () => {
      await delay(30);
      order.push('a');
      return 'a';
    });
    const b = queue.run('b', async () => {
      await delay(20);
      order.push('b');
      return 'b';
    });
    const c = queue.run('c', async () => {
      await delay(10);
      order.push('c');
      return 'c';
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);

    queue.abort('disposed');
  });

  it('aborts the capture when a call exceeds the per-call timeout', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 100, overallTimeoutMs: 10_000 });

    const captured = settle(queue.run('slow', () => new Promise<never>(() => {})));

    await vi.advanceTimersByTimeAsync(100);

    const error = await captured;
    expect(error).toBeInstanceOf(CaptureAbortedError);
    expect((error as CaptureAbortedError).reason).toBe('call-timeout');
    expect((error as CaptureAbortedError).label).toBe('slow');
    expect(queue.aborted).toBe(true);
    expect(queue.abortReason).toBe('call-timeout');
  });

  it('fails fast without invoking fn once aborted', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 100, overallTimeoutMs: 10_000 });
    queue.abort('disposed');

    const fn = vi.fn().mockResolvedValue('never');
    const error = await settle(queue.run('later', fn));

    expect(fn).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(CaptureAbortedError);
    expect((error as CaptureAbortedError).reason).toBe('disposed');
    expect((error as CaptureAbortedError).label).toBe('later');
  });

  it('rejects a call that was already queued when the abort happened', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 1000, overallTimeoutMs: 10_000 });

    const first = queue.run('first', async () => {
      await delay(50);
      return 'first';
    });
    const second = vi.fn().mockResolvedValue('second');
    const queued = settle(queue.run('second', second));

    // Let the queue dequeue 'first' before aborting; calls are only ever invoked a microtask after
    // being enqueued, so an abort in the same tick would reject 'first' too.
    await vi.advanceTimersByTimeAsync(0);

    queue.abort('disposed');
    await vi.advanceTimersByTimeAsync(100);

    await expect(first).resolves.toBe('first');
    expect(second).not.toHaveBeenCalled();

    const error = await queued;
    expect(error).toBeInstanceOf(CaptureAbortedError);
    expect((error as CaptureAbortedError).reason).toBe('disposed');
  });

  it('aborts on the overall deadline', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 1000, overallTimeoutMs: 500 });

    expect(queue.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(500);

    expect(queue.aborted).toBe(true);
    expect(queue.abortReason).toBe('overall-timeout');
  });

  it('still runs runFinal after an abort', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 100, overallTimeoutMs: 10_000 });
    queue.abort('overall-timeout');

    const release = vi.fn().mockResolvedValue('released');

    await expect(queue.runFinal('release', release)).resolves.toBe('released');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('is not wedged by a call that never settles', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 100, overallTimeoutMs: 10_000 });

    const hung = settle(queue.run('hang', () => new Promise<never>(() => {})));

    await vi.advanceTimersByTimeAsync(100);
    expect(await hung).toBeInstanceOf(CaptureAbortedError);

    // The hung call is abandoned, not awaited: the queue keeps draining.
    const release = vi.fn().mockResolvedValue('released');
    const result = queue.runFinal('release', release);

    await vi.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toBe('released');
  });

  it('keeps the first abort reason', () => {
    const queue = new SerialQueue({ callTimeoutMs: 100, overallTimeoutMs: 10_000 });

    queue.abort('disposed');
    queue.abort('call-timeout');
    queue.abort('overall-timeout');

    expect(queue.abortReason).toBe('disposed');
  });

  it('surfaces a synchronous throw from fn as a rejection', async () => {
    const queue = new SerialQueue({ callTimeoutMs: 100, overallTimeoutMs: 10_000 });

    const error = await settle(
      queue.run<string>('boom', () => {
        throw new Error('boom');
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('boom');

    // A throwing call does not abort the capture; the next call still runs.
    await expect(queue.run('next', async () => 'ok')).resolves.toBe('ok');

    queue.abort('disposed');
  });
});

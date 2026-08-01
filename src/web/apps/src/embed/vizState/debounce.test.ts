import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDebouncer } from './debounce.js';

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of triggers into a single call', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(100, fn);

    for (let i = 0; i < 5; i++) {
      debouncer.trigger();
    }

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('restarts the delay on every trigger', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(100, fn);

    debouncer.trigger();
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();

    // Re-trigger before expiry: the original 100ms window is discarded.
    debouncer.trigger();
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not fire after cancel', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(100, fn);

    debouncer.trigger();
    debouncer.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it('reports pending only while a timer is armed', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(100, fn);

    expect(debouncer.pending).toBe(false);

    debouncer.trigger();
    expect(debouncer.pending).toBe(true);

    vi.advanceTimersByTime(100);
    expect(debouncer.pending).toBe(false);

    debouncer.trigger();
    expect(debouncer.pending).toBe(true);

    debouncer.cancel();
    expect(debouncer.pending).toBe(false);
  });

  it('is a no-op when cancelled without a pending trigger', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(100, fn);

    expect(() => debouncer.cancel()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

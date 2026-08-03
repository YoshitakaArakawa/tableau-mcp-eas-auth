/**
 * @file Pushes a Pulse metric state snapshot into the host's model context.
 *
 * Each `updateModelContext` call replaces the previous one from this view, so the payload is
 * always a complete snapshot rather than a delta.
 *
 * The push is bounded before it is sent: the host applies an undocumented context limit at DISPLAY
 * time, and exceeding it bricks the widget rather than returning an error. The preamble is measured
 * and subtracted from the budget so the total, not just the JSON, stays inside it.
 */
import type { App } from '@modelcontextprotocol/ext-apps';

import { utf8ByteLength } from '../../embed/vizState/sanitize.js';
import { recordEvent } from '../../shared/recordEventClient.js';
import {
  fitPulsePayloadToBudget,
  type PulseStatePayload,
  PUSH_BUDGET_BYTES,
} from './pulsePayload.js';

/**
 * Tells the model what the JSON is, that it describes the CURRENT metric view, and — the part that
 * matters most for Pulse — that it contains no numbers. A snapshot of a metric invites the model to
 * state the metric's value; the only numbers here are an insight relevance score and whatever
 * appears inside insight prose, so the preamble names the tools that can actually answer that.
 *
 * Wording constraint: the pushed text must never contain the word "token" in any casing — the leak
 * test treats its presence as evidence of an embed credential reaching the model context.
 */
export const PULSE_PUSH_PREAMBLE =
  'Tableau Pulse metric state snapshot — what the user currently sees in the embedded Pulse metric. ' +
  'It describes the metric configuration (filters, time dimension) and the insight text Pulse has surfaced; ' +
  'it does NOT contain the metric value, its comparisons, or any aggregate. ' +
  'To state a number, call generate-pulse-metric-value-insight-bundle for `metric.id`, ' +
  'or query the underlying data source with query-datasource, translating `filters` and `timeDimension` into query filters. ' +
  "Quote `insights[].text` as Pulse's wording rather than as your own analysis, and do not extrapolate a trend from it. " +
  'JSON follows.';

const PREAMBLE_BYTES = utf8ByteLength(`${PULSE_PUSH_PREAMBLE}\n`);

/**
 * Sends the snapshot to the host. Never throws and never rethrows: a failed context update must not
 * break the embedded metric the user is looking at.
 */
export async function pushPulseState(app: App, payload: PulseStatePayload): Promise<void> {
  try {
    // No capability, no push. The host simply does not accept context updates.
    if (!app.getHostCapabilities()?.updateModelContext) {
      return;
    }

    const { text: json } = fitPulsePayloadToBudget(payload, PUSH_BUDGET_BYTES - PREAMBLE_BYTES);
    const text = `${PULSE_PUSH_PREAMBLE}\n${json}`;

    await app.updateModelContext({ content: [{ type: 'text', text }] });
  } catch (error) {
    console.error('[mcp-pulse] pulse state push failed', error);
    recordEvent(app, 'PULSE_STATE_PUSH_ERROR', error);
  }
}

/**
 * @file Pushes a viz state snapshot into the host's model context.
 *
 * Each `updateModelContext` call replaces the previous one from this view, so the payload is
 * always a complete snapshot rather than a delta.
 *
 * The push is bounded before it is sent: the host applies an undocumented context limit at DISPLAY
 * time, and exceeding it bricks the widget rather than returning an error. The preamble is measured
 * and subtracted from the budget so the total, not just the JSON, stays inside it.
 */
import type { App } from '@modelcontextprotocol/ext-apps';

import { recordEvent } from '../../shared/recordEventClient.js';
import { fitPayloadToBudget, PUSH_BUDGET_BYTES, type VizStatePayload } from './payload.js';
import { utf8ByteLength } from './sanitize.js';

/** Tells the model what the JSON is and, importantly, that it describes the CURRENT view. */
const PUSH_PREAMBLE =
  'Tableau viz state snapshot — what the user currently sees in the embedded viz. JSON follows.';

const PREAMBLE_BYTES = utf8ByteLength(`${PUSH_PREAMBLE}\n`);

/**
 * Sends the snapshot to the host. Never throws and never rethrows: a failed context update must not
 * break the embedded viz the user is looking at.
 */
export async function pushVizState(app: App, payload: VizStatePayload): Promise<void> {
  try {
    // No capability, no push. The host simply does not accept context updates.
    if (!app.getHostCapabilities()?.updateModelContext) {
      return;
    }

    const { text: json } = fitPayloadToBudget(payload, PUSH_BUDGET_BYTES - PREAMBLE_BYTES);
    const text = `${PUSH_PREAMBLE}\n${json}`;

    await app.updateModelContext({ content: [{ type: 'text', text }] });
  } catch (error) {
    console.error('[mcp-app] viz state push failed', error);
    recordEvent(app, 'VIZ_STATE_PUSH_ERROR', error);
  }
}

import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { extractToolErrorMessage } from '../../../../utils/extractToolErrorMessage.js';
import { callGetEmbedTokenTool } from '../embed/getEmbedTokenToolClient.js';
import { loadTableauEmbeddingApi } from '../embed/loadTableauEmbeddingApi.js';
import { setupOpenInTableauLink } from '../embed/openInTableauLink.js';
import { recordEvent } from '../shared/recordEventClient.js';
import { showError } from '../shared/showError.js';
import { TABLEAU_VIZ_CONTAINER_ID } from '../shared/vizContainer.js';
import { embedTableauPulse, type PulseLayout } from './embedTableauPulse.js';
import type { PulseIdentity } from './pulseState/capturePulseState.js';
import { startPulseStateBridge } from './pulseState/pulseStateBridge.js';

/**
 * The first content block of the render-pulse-metric result.
 *
 * `data` and `layout` are optional and `.catch`-guarded for the same reason as the viz payload: a
 * delivery from another or older server carries only the URL, and a `data` block that is present
 * but shaped differently (a future object type, say) must degrade to no state bridge rather than to
 * a PARSE_ERROR that would cost the user the metric they asked for.
 */
const pulsePayloadSchema = z.object({
  url: z.string().url(),
  layout: z.enum(['default', 'card', 'ban']).optional().catch(undefined),
  data: z
    .object({
      id: z.string(),
      objectType: z.literal('pulse-metric'),
      name: z.string(),
    })
    .optional()
    .catch(undefined),
});

export type PulsePayload = z.infer<typeof pulsePayloadSchema>;

/**
 * Tolerates extra content blocks: the render tool appends a guidance text block after the payload,
 * and future blocks must not turn a good delivery into a PARSE_ERROR.
 */
const callToolResultSchema = z.object({
  content: z
    .array(
      z.object({
        type: z.literal('text'),
        text: z.string(),
      }),
    )
    .nonempty(),
  isError: z.boolean().optional(),
});

/** The bridge for the currently mounted metric, if any. Module-level because deliveries are too. */
let disposeBridge: (() => void) | undefined;

/** Extracts the render payload from the first content block of a tool result. */
export function extractPulsePayloadFromResult(result: CallToolResult): PulsePayload {
  try {
    const validated = callToolResultSchema.parse(result);
    const content = validated.content[0];

    const data = JSON.parse(content.text);
    return pulsePayloadSchema.parse(data);
  } catch (contentError) {
    // Hosts do not necessarily preserve `content` across a page reload. ChatGPT re-delivers a
    // synthesized `content` of `[{text: "{}"}]` built from the STORED structuredContent (measured
    // 20260804 on the viz app), so structuredContent is the durable half of the result: a delivery
    // whose content blocks do not parse gets one more chance from it.
    const structured = pulsePayloadSchema.safeParse(result.structuredContent);
    if (structured.success) {
      return structured.data;
    }
    throw contentError;
  }
}

/** Maps the server's content identity onto the capture identity. */
export function toPulseIdentity(
  data: NonNullable<PulsePayload['data']>,
  layout: PulseLayout | undefined,
): PulseIdentity {
  return { id: data.id, name: data.name, ...(layout !== undefined && { layout }) };
}

/**
 * Whether a delivery carries no usable payload (empty `content`, no `structuredContent`).
 * Empty `content` is protocol-legal (MCP defaults it to `[]`), so this is not a parse failure —
 * just nothing to render.
 */
function isEmptyDelivery(result: CallToolResult): boolean {
  const hasContent = Array.isArray(result.content) && result.content.length > 0;
  const hasStructuredContent =
    result.structuredContent != null && Object.keys(result.structuredContent).length > 0;
  return !hasContent && !hasStructuredContent;
}

/** Whether the container currently holds a mounted metric (as opposed to nothing or the error UI). */
function isPulseMounted(): boolean {
  return document.getElementById(TABLEAU_VIZ_CONTAINER_ID)?.querySelector('tableau-pulse') != null;
}

/**
 * Handles a tool result from render-pulse-metric and embeds the Pulse metric.
 * @param app - The MCP App instance
 * @param result - The tool result containing the metric URL and identity
 */
export async function handlePulseToolResult(app: App, result: CallToolResult): Promise<void> {
  if (!result || result.isError) {
    const cause = result ? extractToolErrorMessage(result) : undefined;
    showError('TOOL_ERROR', cause, app);
    return;
  }

  // Empty re-delivery: the host can re-fire tool-result with no payload on a re-render/re-mount.
  // Nothing to embed, so no-op and keep the current render instead of overwriting it with an error.
  if (isEmptyDelivery(result)) {
    return;
  }

  // Parse failure. The host can re-deliver tool results that are not render payloads at all (a
  // Pulse insight bundle fetched during an analysis turn, say) to the already-mounted widget. Once
  // a metric is on screen, an unparseable delivery must never replace it with the error UI — log
  // and record it, keep the metric. PARSE_ERROR only surfaces while nothing is rendered yet.
  let payload: PulsePayload;
  try {
    payload = extractPulsePayloadFromResult(result);
  } catch (e) {
    if (isPulseMounted()) {
      console.warn('[mcp-pulse] ignored an unparseable re-delivery; keeping the mounted metric', e);
      recordEvent(app, 'PARSE_ERROR_IGNORED', e);
      return;
    }
    showError('PARSE_ERROR', e, app);
    return;
  }

  const metricUrl = payload.url;

  // Embedding API load failure. The awaited element is 'tableau-pulse', not 'tableau-viz': the
  // script defines both, and waiting on the wrong one would report ready too early.
  try {
    await loadTableauEmbeddingApi(metricUrl, 'tableau-pulse');
  } catch (e) {
    showError('EMBED_LOAD_ERROR', e, app);
    return;
  }

  // Auth failure (minting). 'pulse' asks the server for the Pulse scope set — a viz-scoped
  // credential reaches the element fine and then fails as a session-expired error mid-render.
  let token: string;
  try {
    token = await callGetEmbedTokenTool(app, 'pulse');
  } catch (e) {
    showError('AUTH_ERROR', e, app);
    return;
  }

  const pulse = embedTableauPulse({
    metricUrl,
    token,
    layout: payload.layout,
    onAuthError: () => showError('AUTH_ERROR', undefined, app),
    onLoadError: (message) => showError('EMBED_LOAD_ERROR', message, app),
  });

  // The host can re-deliver a tool result on re-mount, and `embedTableauPulse` replaces the
  // container's children — the previous element is orphaned along with its listeners, so the
  // bridge watching it has to be stopped before a new one is started on the new element.
  disposeBridge?.();
  disposeBridge = undefined;

  if (pulse && payload.data) {
    try {
      disposeBridge = startPulseStateBridge({
        app,
        pulse,
        identity: toPulseIdentity(payload.data, payload.layout),
      });
    } catch (e) {
      // State capture is an enhancement. A failure to start it must never cost the user the metric
      // they asked for, so it is logged and nothing else.
      console.error('[mcp-pulse] failed to start the pulse state bridge', e);
    }
  }

  const main = document.querySelector('.main');
  if (main) {
    setupOpenInTableauLink(app, metricUrl, main as HTMLElement);
  }
}

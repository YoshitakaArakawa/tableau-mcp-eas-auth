import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { extractToolErrorMessage } from '../../../../utils/extractToolErrorMessage.js';
import { recordEvent } from '../shared/recordEventClient.js';
import { showError } from '../shared/showError.js';
import { TABLEAU_VIZ_CONTAINER_ID } from '../shared/vizContainer.js';
import { embedTableauViz } from './embedTableauViz.js';
import { callGetEmbedTokenTool } from './getEmbedTokenToolClient.js';
import { loadTableauEmbeddingApi } from './loadTableauEmbeddingApi.js';
import { setupOpenInTableauLink } from './openInTableauLink.js';
import type { VizIdentity } from './vizState/captureVizState.js';
import type { TableauVizElement } from './vizState/embeddingApiTypes.js';
import { startVizStateBridge } from './vizState/vizStateBridge.js';

/**
 * The first content block of a render tool result.
 *
 * `data` is optional on purpose: the identity block is an addition of this server, and a delivery
 * from another or older server carries only the URL. Rendering must not depend on it — its absence
 * costs the viz state bridge, nothing else. `.catch` extends that to a `data` block that is present
 * but not the shape expected here (a future object type, say): it degrades to no bridge, never to a
 * PARSE_ERROR that would cost the user the viz they asked for.
 */
const renderPayloadSchema = z.object({
  url: z.string().url(),
  data: z
    .object({
      luid: z.string(),
      objectType: z.enum(['workbook', 'view']),
      name: z.string(),
    })
    .optional()
    .catch(undefined),
});

export type RenderPayload = z.infer<typeof renderPayloadSchema>;

/**
 * Tolerates extra content blocks: the render tools append a guidance text block after the payload,
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

/** The bridge for the currently mounted viz, if any. Module-level because deliveries are too. */
let disposeBridge: (() => void) | undefined;

/**
 * Extracts the render payload (view URL, plus the content identity when the server sent one) from
 * the first content block of a tool result.
 */
export function extractRenderPayloadFromResult(result: CallToolResult): RenderPayload {
  const validated = callToolResultSchema.parse(result);
  const content = validated.content[0];

  const data = JSON.parse(content.text);
  return renderPayloadSchema.parse(data);
}

/**
 * Extracts the view URL from tool result content
 */
export function extractUrlObjectFromResult(result: CallToolResult): string {
  return extractRenderPayloadFromResult(result).url;
}

/**
 * Maps the server's content identity onto the capture identity. A luid is only ever attributed to
 * the object type the server actually named — an unknown identity stays absent rather than invented.
 */
export function toVizIdentity(data: NonNullable<RenderPayload['data']>): VizIdentity {
  return data.objectType === 'view'
    ? { view: { luid: data.luid, name: data.name }, workbook: {} }
    : { workbook: { luid: data.luid, name: data.name }, view: {} };
}

/**
 * Whether a delivery carries no usable payload (empty `content`, no `structuredContent`).
 * Empty `content` is protocol-legal (MCP defaults it to `[]`), so this is not a parse failure —
 * just nothing to render. Content that is present but unparseable is NOT empty and still surfaces
 * PARSE_ERROR downstream (unless a viz is already mounted — see `handleToolResult`).
 */
function isEmptyDelivery(result: CallToolResult): boolean {
  const hasContent = Array.isArray(result.content) && result.content.length > 0;
  const hasStructuredContent =
    result.structuredContent != null && Object.keys(result.structuredContent).length > 0;
  return !hasContent && !hasStructuredContent;
}

/** Whether the container currently holds a mounted viz (as opposed to nothing or the error UI). */
function isVizMounted(): boolean {
  return document.getElementById(TABLEAU_VIZ_CONTAINER_ID)?.querySelector('tableau-viz') != null;
}

/**
 * Bounded description of an unparseable delivery, for telemetry. What hosts re-deliver on a
 * re-mount is undocumented and has only ever been understood from these reports, so the head of
 * the raw delivery rides along with the parse error. A render delivery carries no secrets (a view
 * URL plus content identity), and the head is capped well under the record-event message limit.
 */
function describeUnparseableDelivery(e: unknown, result: CallToolResult): string {
  let head: string;
  try {
    head = JSON.stringify(result).slice(0, 700);
  } catch {
    head = '<unserializable delivery>';
  }
  const error = e instanceof Error ? e.message : String(e);
  return `${error.slice(0, 200)} | delivery head: ${head}`;
}

/**
 * Handles a tool result from an embed-Tableau-viz tool (get-view / get-workbook) and embeds the viz.
 * @param app - The MCP App instance
 * @param result - The tool result containing the view URL
 */
export async function handleToolResult(app: App, result: CallToolResult): Promise<void> {
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

  // Parse failure. Observed on a real device: the host can re-deliver tool results that are not
  // render payloads at all (e.g. a get-view-data CSV fetched during an analysis turn) to the
  // already-mounted widget. Once a viz is on screen, an unparseable delivery must never replace
  // it with the error UI — log and record it, keep the viz. PARSE_ERROR only surfaces while
  // nothing is rendered yet.
  let payload: RenderPayload;
  try {
    payload = extractRenderPayloadFromResult(result);
  } catch (e) {
    if (isVizMounted()) {
      console.warn('[mcp-app] ignored an unparseable re-delivery; keeping the mounted viz', e);
      recordEvent(app, 'PARSE_ERROR_IGNORED', describeUnparseableDelivery(e, result));
      return;
    }
    showError('PARSE_ERROR', describeUnparseableDelivery(e, result), app);
    return;
  }

  const viewUrl = payload.url;

  // Embedding API load failure
  try {
    await loadTableauEmbeddingApi(viewUrl);
  } catch (e) {
    showError('EMBED_LOAD_ERROR', e, app);
    return;
  }

  // Auth failure (minting)
  let token: string;
  try {
    token = await callGetEmbedTokenTool(app);
  } catch (e) {
    showError('AUTH_ERROR', e, app);
    return;
  }

  // Auth failure (runtime) - handled by onError callback
  const viz = embedTableauViz(viewUrl, token, () => showError('AUTH_ERROR', undefined, app));

  // The host can re-deliver a tool result on re-mount, and `embedTableauViz` replaces the
  // container's children — the previous element is orphaned along with its listeners, so the
  // bridge watching it has to be stopped before a new one is started on the new element.
  disposeBridge?.();
  disposeBridge = undefined;

  if (viz && payload.data) {
    try {
      disposeBridge = startVizStateBridge({
        app,
        viz: viz as TableauVizElement,
        identity: toVizIdentity(payload.data),
      });
    } catch (e) {
      // State capture is an enhancement. A failure to start it must never cost the user the viz
      // they asked for, so it is logged and nothing else.
      console.error('[mcp-app] failed to start the viz state bridge', e);
    }
  }

  const main = document.querySelector('.main');
  if (main) {
    setupOpenInTableauLink(app, viewUrl, main as HTMLElement);
  }
}

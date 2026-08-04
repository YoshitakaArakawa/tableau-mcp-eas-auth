export const queryWorkbookDatasourceToolDescription = `
Queries a datasource that belongs to a workbook currently rendered in an embedded viz, using the
VizQL session of that viz. Use this when a viz state snapshot is in context: the snapshot carries
both the datasource id and the session values this tool needs.

When to use this instead of \`query-datasource\`:
- The datasource is embedded in the workbook (not published), so it has no LUID at all. This tool is
  the only way to query it.
- You have a viz state snapshot and want to query what it names without a separate lookup step.
Prefer \`query-datasource\` when you already have a published datasource LUID: it needs no session
and cannot go stale.

Required arguments, all three of which must come from the SAME viz state snapshot:
- \`workbookDatasourceId\`: \`datasources[].id\` from the snapshot. It looks like
  \`sqlproxy.<id>\` (a published datasource referenced by the workbook) or \`federated.<id>\`
  (a datasource embedded in the workbook). It is NOT a LUID — if you are holding a 36-character
  GUID, use \`query-datasource\` with \`datasourceLuid\` instead.
- \`vizqlSessionId\` and \`globalSessionHeader\`: the two values under \`vds\` in the snapshot.

Call it with no \`query\` first to get the field list, then call it again with a query built from
those field names. The query shape is identical to \`query-datasource\`.

Important limits:
- Results reflect the DATASOURCE, not the on-screen state. Filters, parameters and selections the
  user applied in the viz are not applied here. Translate the snapshot's \`filters\` and
  \`parameters\` into the query yourself if you want the numbers to match the screen.
- The session expires. On a session error, ask the user to re-render the viz and use the new values.
- Server-side datasource restrictions (INCLUDE_DATASOURCE_IDS / EXCLUDE_DATASOURCE_IDS) are keyed by
  published LUID and therefore do not apply to this tool. Deployments that rely on that allowlist
  should exclude this tool.
`;

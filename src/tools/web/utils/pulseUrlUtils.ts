/**
 * Constructs the web URL of a Tableau Pulse metric.
 *
 * Unlike the viz URLs built by `viewUrlUtils`, the Pulse route is a real path rather than a hash
 * fragment: `{server}/pulse/site/{siteName}/metrics/{metricId}`.
 *
 * Pulse is a Tableau Cloud feature, and a Cloud deployment always has a named site, so the
 * site-less form is a defensive fallback rather than a supported shape.
 *
 * @param server - The Tableau server URL (e.g. 'https://example.online.tableau.com')
 * @param siteName - The site name, or empty string/'Default' for the default site
 * @param metricId - The Pulse metric ID (not the metric definition ID)
 */
export function constructPulseMetricWebUrl(
  server: string,
  siteName: string,
  metricId: string,
): string {
  const url = new URL(server);

  url.pathname =
    !siteName || siteName === 'Default'
      ? `/pulse/metrics/${encodeURIComponent(metricId)}`
      : `/pulse/site/${encodeURIComponent(siteName)}/metrics/${encodeURIComponent(metricId)}`;

  return url.toString();
}

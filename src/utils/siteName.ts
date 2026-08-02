/**
 * The Default site has an empty content URL, which cannot be written in a comma-separated list nor
 * asked for by name. `Default` (case-insensitive) is the explicit token that stands for it.
 */
export const DEFAULT_SITE_NAME = 'Default';

/**
 * Reads a site as written by an operator or a caller into a Tableau site content URL.
 */
export function toSiteContentUrl(site: string): string {
  const trimmed = site.trim();
  return trimmed.toLowerCase() === DEFAULT_SITE_NAME.toLowerCase() ? '' : trimmed;
}

/**
 * Names a site content URL for display. The Default site has no content URL, so it is shown by the
 * same token that selects it.
 */
export function toSiteDisplayName(contentUrl: string): string {
  return contentUrl || DEFAULT_SITE_NAME;
}

/**
 * HTML escaping, on its own so a small page helper (./config-picker.ts) can
 * use it without loading every page renderer in ./html.ts.
 */

/** Escape a string for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!
  );
}

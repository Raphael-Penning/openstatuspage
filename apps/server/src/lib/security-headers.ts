/**
 * Security headers of the HTML pages (public pages and the management UI).
 *
 * Content-Security-Policy: scripts, styles, fonts and requests from the own
 * origin only. Pages carry no inline scripts that run: the state block and the
 * JSON-LD are data blocks (type application/json, application/ld+json), which
 * script-src does not govern. Inline styles stay allowed: React writes style
 * attributes (uptime bars, map markers). The theme of the public pages is a
 * same-origin stylesheet (/theme/<hash>.css), never a <style> element. Images may come from any HTTPS origin, because
 * the logo and favicon of the settings are URLs. A public page may be embedded
 * by other sites (no frame-ancestors); the management UI may not.
 */
const BASE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

export const PUBLIC_PAGE_CSP = BASE_POLICY.join('; ');
export const FRAMELESS_PAGE_CSP = [...BASE_POLICY, "frame-ancestors 'none'"].join('; ');

/** Browser features no page of the app uses. */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

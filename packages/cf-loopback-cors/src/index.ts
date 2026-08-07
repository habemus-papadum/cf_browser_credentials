/**
 * Loopback-only CORS echo for cookie-authenticated endpoints.
 *
 * The pattern: a static site's dev server runs on localhost on an arbitrary
 * port and calls the *deployed* endpoint cross-origin, authenticated by the
 * cookie riding along with `credentials: "include"`. That works only when the
 * endpoint echoes the caller's origin (a wildcard cannot be combined with
 * credentials) — so echo loopback origins, on any port, and nothing else.
 *
 * CORS is never used to reject: authentication belongs to the auth layer in
 * front (e.g. Cloudflare Access), and a non-loopback origin simply gets no
 * CORS headers, leaving same-origin behaviour untouched.
 *
 * @packageDocumentation
 */

/** True when `origin` parses to http(s) on a loopback host (any port). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/**
 * CORS headers echoing `origin`, or null when none should be set.
 *
 * Spread the result into a response's headers; null means "add nothing"
 * (same-origin callers need no CORS and non-loopback origins get none).
 */
export function corsHeadersFor(origin: string | null): Record<string, string> | null {
  if (!origin || !isLoopbackOrigin(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "origin",
  };
}

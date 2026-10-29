/**
 * The Content Security Policy's directives, in plain JavaScript so `next.config.mjs` (loaded by Node before any bundling) and `proxy.ts`
 * (through lib/csp.ts) read the one list. See lib/csp.ts for what each half is used for.
 *
 * @param {string | undefined} nonce the page's nonce, or undefined for a response that should run no inline script at all
 * @param {boolean} development React's development build needs eval for its error stacks
 * @returns {string}
 */
export function cspPolicy(nonce, development = false) {
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the page compile WebAssembly (MediaPipe for 摄像头精力采样, docs/energy-and-ecosystem.md §8) without allowing
    // JavaScript eval; the wasm and MediaPipe's module are served from this origin.
    `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""} 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
    // Styles keep inline: React writes `style` attributes (bar widths, chart positions) everywhere, and a nonce cannot cover an attribute.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    // Kept from the static policy: a font may come as a `data:` URI.
    "font-src 'self' data:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
}

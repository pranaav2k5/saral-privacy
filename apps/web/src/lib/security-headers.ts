/**
 * Headers for every dashboard page. The content security policy here limits framing, form targets, the base address and
 * plugins. It does not limit scripts yet: Next.js inlines small scripts, and a script policy needs a nonce on every
 * request, which would stop the pages being prerendered (see docs/threat-model/0009-dashboard.md).
 */
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

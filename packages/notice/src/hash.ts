/**
 * Canonical form of a notice text, so the same notice always has the same hash: Unicode NFC, all line
 * endings as LF, no trailing spaces or tabs on any line, no trailing blank lines, one final newline.
 */
export function canonicalNoticeText(text: string): string {
  const lines = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

/** SHA-256 (lowercase hex) of the canonical text, using Web Crypto (Node 20+ and browsers). */
export async function noticeSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNoticeText(text));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

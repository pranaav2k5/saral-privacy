/**
 * The link a receipt carries to the privacy notice. It points to the published notice, which never changes, so a receipt
 * keeps showing the text the person saw even after the tenant edits its own page. Without a public https base URL it
 * falls back to the tenant's own page. A receipt needs an https link, so an http base (local development) is ignored.
 */
export function receiptPolicyUrl(publicBaseUrl: string | undefined, profilePolicyUrl: string | undefined, noticeId: string): string | undefined {
  if (publicBaseUrl !== undefined && publicBaseUrl.startsWith("https://")) {
    return `${publicBaseUrl.replace(/\/+$/, "")}/v1/notices/${noticeId}`;
  }
  return profilePolicyUrl;
}

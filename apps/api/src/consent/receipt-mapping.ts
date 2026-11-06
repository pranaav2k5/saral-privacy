import { MAX_TOKEN_CHARS, ReceiptError, buildReceiptClaims, type PiiController, type ReceiptPurpose } from "@saral/receipts";
import type { CollectionMethod } from "@saral/schemas";
import { receiptPolicyUrl } from "./policy-url.js";

export interface PurposeDefinition {
  key: string;
  purpose: string;
  purposeCategory: string[];
  piiCategory: string[];
  termination: string;
  retentionDays: number;
  thirdPartyDisclosure: boolean;
  thirdPartyName?: string;
  primaryPurpose?: boolean;
}

export const COLLECTION: Record<CollectionMethod, string> = {
  web_sdk: "web_sdk: consent banner on the organisation's website or app",
  api: "api: server-side call by the organisation",
  dpo_entry: "dpo_entry: recorded by the data protection officer",
};

/** What a receipt says about one purpose the person agreed to, taken from the notice's definition, never from the caller. */
export function toReceiptPurpose(d: PurposeDefinition): ReceiptPurpose {
  return {
    purpose: d.purpose, consentType: "EXPLICIT", purposeCategory: d.purposeCategory, piiCategory: d.piiCategory,
    termination: d.termination, thirdPartyDisclosure: d.thirdPartyDisclosure,
    ...(d.thirdPartyName !== undefined ? { thirdPartyName: d.thirdPartyName } : {}),
    ...(d.primaryPurpose !== undefined ? { primaryPurpose: d.primaryPurpose } : {}),
  };
}

/** The header (with its key id), the signature of a 4096-bit key, and the two dots. Counted so the estimate can only be too high. */
const HEADER_AND_SIGNATURE_CHARS = 1000;

/**
 * The size, in characters, of the largest receipt a notice can produce: the one that grants every purpose. Null when the
 * profile cannot make a receipt at all (grants then fail for that reason, and there is nothing to measure).
 */
export function largestReceiptChars(input: {
  profile: { controller?: unknown; policyUrl?: unknown; service?: unknown };
  publicBaseUrl: string | undefined;
  noticeId: string;
  noticeSha256: string;
  language: string;
  definitions: PurposeDefinition[];
}): number | null {
  const { profile } = input;
  const longest = Object.values(COLLECTION).reduce((a, b) => (b.length > a.length ? b : a));
  try {
    const claims = buildReceiptClaims({
      receiptId: "00000000-0000-4000-8000-000000000001", principalId: "00000000-0000-4000-8000-000000000002", consentedAt: new Date(),
      collectionMethod: longest, language: input.language,
      controller: profile.controller as PiiController, policyUrl: receiptPolicyUrl(input.publicBaseUrl, profile.policyUrl as string | undefined, input.noticeId) as string,
      service: profile.service as string, consentId: "00000000-0000-4000-8000-000000000003", noticeId: input.noticeId, noticeSha256: input.noticeSha256,
      purposes: input.definitions.map(toReceiptPurpose),
    });
    return Buffer.from(JSON.stringify(claims)).toString("base64url").length + HEADER_AND_SIGNATURE_CHARS;
  } catch (e) {
    if (e instanceof ReceiptError) return null;
    throw e;
  }
}

export { MAX_TOKEN_CHARS as MAX_RECEIPT_CHARS };

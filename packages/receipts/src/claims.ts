import { RECEIPT_SPEC_VERSION } from "@saral/schemas";

/**
 * Kantara Consent Receipt Specification v1.1.0 (KI-CR-v1.1.0), JSON encoding.
 * Field names follow the normative JSON schema in section 4.8 of the specification
 * (`policyUrl`, `piiControllerUrl`, array-valued `purposeCategory`), not the prose of section 4.
 * See docs/RESEARCH.md for the conflict between the two.
 */

export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

export interface PostalAddress {
  streetAddress: string;
  addressLocality: string;
  addressRegion?: string;
  postalCode: string;
  addressCountry: string;
}

export interface PiiController {
  piiController: string;
  onBehalf?: boolean;
  contact: string;
  address: PostalAddress;
  email: string;
  /** RFC 3966 `tel:` URI. */
  phone: string;
  piiControllerUrl?: string;
}

export interface ReceiptPurpose {
  purpose?: string;
  consentType: string;
  purposeCategory: string[];
  piiCategory: string[];
  primaryPurpose?: boolean;
  termination: string;
  thirdPartyDisclosure: boolean;
  thirdPartyName?: string;
}

export interface ReceiptService {
  service: string;
  purposes: ReceiptPurpose[];
}

export interface KantaraReceiptClaims {
  version: typeof RECEIPT_SPEC_VERSION;
  jurisdiction: string;
  /** Seconds since the Unix epoch. */
  consentTimestamp: number;
  collectionMethod: string;
  consentReceiptID: string;
  language?: string;
  /** Pseudonymous principal id (a UUID), never a phone number or email. */
  piiPrincipalId: string;
  piiControllers: PiiController[];
  policyUrl: string;
  services: ReceiptService[];
  sensitive: boolean;
  spiCat: string[];
  /** Issue time, seconds since the Unix epoch (JWT registered claim). */
  iat: number;
}

export interface ReceiptInput {
  /** UUID v4 of this receipt. */
  receiptId: string;
  /** Pseudonymous principal id (a lowercase UUID). */
  principalId: string;
  consentedAt: Date;
  collectionMethod: string;
  language?: string;
  controller: PiiController;
  policyUrl: string;
  service: string;
  /** Only the purposes the principal agreed to. */
  purposes: ReceiptPurpose[];
  sensitive?: boolean;
  spiCat?: string[];
  jurisdiction?: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEL = /^tel:\+[0-9][0-9.()-]{3,30}$/;
const LANG = /^[a-z]{2}$/;

function fail(field: string, why: string): never {
  throw new ReceiptError(`${field}: ${why}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(field: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") fail(field, "must be a non-empty string");
  return v;
}

function bool(field: string, v: unknown): boolean {
  if (typeof v !== "boolean") fail(field, "must be a boolean");
  return v;
}

function strings(field: string, v: unknown, nonEmpty: boolean): string[] {
  if (!Array.isArray(v) || (nonEmpty && v.length === 0)) fail(field, "must be an array of strings");
  return (v as unknown[]).map((s) => str(field, s));
}

function httpsUrl(field: string, v: unknown): string {
  const s = str(field, v);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return fail(field, "must be a valid URL");
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") {
    fail(field, "must be an https URL without credentials");
  }
  return s;
}

function arrayOfObjects(field: string, v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v) || v.length === 0) fail(field, "must be a non-empty array");
  return (v as unknown[]).map((o) => (isObject(o) ? o : fail(field, "items must be objects")));
}

function checkController(c: Record<string, unknown>): void {
  str("piiControllers.piiController", c.piiController);
  str("piiControllers.contact", c.contact);
  if (!EMAIL.test(str("piiControllers.email", c.email))) fail("piiControllers.email", "must be an email address");
  if (!TEL.test(str("piiControllers.phone", c.phone))) fail("piiControllers.phone", "must be an RFC 3966 tel: URI");
  if (!isObject(c.address)) fail("piiControllers.address", "must be a schema.org PostalAddress object");
  for (const k of ["streetAddress", "addressLocality", "postalCode", "addressCountry"]) {
    str(`piiControllers.address.${k}`, c.address[k]);
  }
  if (c.address.addressRegion !== undefined) str("piiControllers.address.addressRegion", c.address.addressRegion);
  if (c.piiControllerUrl !== undefined) httpsUrl("piiControllers.piiControllerUrl", c.piiControllerUrl);
  if (c.onBehalf !== undefined) bool("piiControllers.onBehalf", c.onBehalf);
}

function checkPurpose(p: Record<string, unknown>): void {
  if (p.purpose !== undefined) str("purposes.purpose", p.purpose);
  str("purposes.consentType", p.consentType);
  strings("purposes.purposeCategory", p.purposeCategory, true);
  strings("purposes.piiCategory", p.piiCategory, true);
  if (p.primaryPurpose !== undefined) bool("purposes.primaryPurpose", p.primaryPurpose);
  str("purposes.termination", p.termination);
  if (bool("purposes.thirdPartyDisclosure", p.thirdPartyDisclosure)) {
    str("purposes.thirdPartyName", p.thirdPartyName);
  }
}

/** Checks the receipt against the KI-CR-v1.1.0 schema and this project's stricter rules. Throws ReceiptError. */
export function validateClaims(value: unknown): KantaraReceiptClaims {
  if (!isObject(value)) return fail("claims", "must be an object");
  if (value.version !== RECEIPT_SPEC_VERSION) fail("version", `must be ${RECEIPT_SPEC_VERSION}`);
  str("jurisdiction", value.jurisdiction);
  const ts = value.consentTimestamp;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) fail("consentTimestamp", "must be a non-negative integer");
  const iat = value.iat;
  if (typeof iat !== "number" || !Number.isInteger(iat) || iat < 0) fail("iat", "must be a non-negative integer");
  str("collectionMethod", value.collectionMethod);
  if (typeof value.consentReceiptID !== "string" || !UUID_V4.test(value.consentReceiptID)) {
    fail("consentReceiptID", "must be a lowercase UUID v4");
  }
  if (value.language !== undefined && (typeof value.language !== "string" || !LANG.test(value.language))) {
    fail("language", "must be an ISO 639-1 code");
  }
  if (typeof value.piiPrincipalId !== "string" || !UUID_ANY.test(value.piiPrincipalId)) {
    fail("piiPrincipalId", "must be a pseudonymous UUID, never an email or phone number");
  }
  arrayOfObjects("piiControllers", value.piiControllers).forEach(checkController);
  httpsUrl("policyUrl", value.policyUrl);
  for (const s of arrayOfObjects("services", value.services)) {
    str("services.service", s.service);
    arrayOfObjects("services.purposes", s.purposes).forEach(checkPurpose);
  }
  const sensitive = bool("sensitive", value.sensitive);
  const spiCat = strings("spiCat", value.spiCat, false);
  if (sensitive && spiCat.length === 0) fail("spiCat", "must list categories when sensitive is true");
  return value as unknown as KantaraReceiptClaims;
}

/** Builds and validates the receipt payload for one consent transaction. Does not mutate the input. */
export function buildReceiptClaims(input: ReceiptInput, now: Date = new Date()): KantaraReceiptClaims {
  const consentTimestamp = Math.floor(input.consentedAt.getTime() / 1000);
  const iat = Math.floor(now.getTime() / 1000);
  if (Number.isNaN(consentTimestamp)) fail("consentedAt", "must be a valid date");
  if (Number.isNaN(iat)) fail("now", "must be a valid date");
  const claims: KantaraReceiptClaims = {
    version: RECEIPT_SPEC_VERSION,
    jurisdiction: input.jurisdiction ?? "IN",
    consentTimestamp,
    collectionMethod: input.collectionMethod,
    consentReceiptID: input.receiptId,
    ...(input.language !== undefined ? { language: input.language } : {}),
    piiPrincipalId: input.principalId,
    piiControllers: [structuredClone(input.controller)],
    policyUrl: input.policyUrl,
    services: [{ service: input.service, purposes: structuredClone(input.purposes) }],
    sensitive: input.sensitive ?? false,
    spiCat: [...(input.spiCat ?? [])],
    iat,
  };
  return validateClaims(claims);
}

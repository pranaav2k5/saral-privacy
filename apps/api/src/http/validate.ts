import { BadRequestException } from "@nestjs/common";

export function bad(field: string, message: string): BadRequestException {
  return new BadRequestException({ error: "invalid_request", field, message });
}

export function objectBody(v: unknown, field = "body"): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(field, "must be a JSON object");
  return v as Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function uuidParam(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw bad(field, "must be a lowercase UUID");
  return v;
}

export function boolField(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw bad(field, "must be true or false");
  return v;
}

export function keyField(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(v)) throw bad(field, "must be a lowercase key such as analytics");
  return v;
}

const PHONE = /^\+[0-9]{8,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalises an E.164 phone number or an email address so the same person always gets the same pseudonym.
 * The value is used to compute an HMAC and is never stored, logged or echoed back.
 */
export function normalizeIdentifier(raw: unknown): string {
  if (typeof raw !== "string") throw bad("identifier", "must be a string");
  const t = raw.trim();
  const phone = t.replace(/[\s-]/g, "");
  if (PHONE.test(phone)) return phone;
  if (t.length <= 254 && EMAIL.test(t)) return t.toLowerCase();
  throw bad("identifier", "must be an E.164 phone number (+919876543210) or an email address");
}

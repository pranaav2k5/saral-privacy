export interface NoticePurpose {
  name: string;
  description: string;
  dataItems: string[];
  retention: string;
}

export interface NoticeInput {
  organisationName: string;
  websiteUrl: string;
  grievanceEmail: string;
  grievanceAddress: string;
  /** Optional: a named data protection officer. */
  dpoName?: string;
  purposes: NoticePurpose[];
  /** Names of organisations the data is shared with. May be empty. */
  thirdParties: string[];
  processesChildrenData: boolean;
  withdrawalUrl: string;
  rightsRequestUrl: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult = { ok: true; value: NoticeInput } | { ok: false; errors: FieldError[] };

const MAX = {
  name: 200,
  description: 1000,
  item: 100,
  retention: 200,
  address: 300,
  email: 254,
  url: 500,
  purposes: 30,
  items: 50,
  thirdParties: 50,
} as const;

// Control characters (including line breaks, so a value cannot add structure to the notice) and the
// bidirectional override and isolate characters that can make text read differently from how it is stored.
// Zero-width joiners (U+200C, U+200D) stay allowed because Indic scripts need them.
const FORBIDDEN = /[\p{Cc}‪-‮⁦-⁩]/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Collector {
  readonly errors: FieldError[] = [];

  add(field: string, message: string): undefined {
    this.errors.push({ field, message });
    return undefined;
  }

  text(field: string, v: unknown, max: number): string | undefined {
    if (typeof v !== "string") return this.add(field, "is required");
    const t = v.trim();
    if (t === "") return this.add(field, "is required");
    if (t.length > max) return this.add(field, `must be at most ${String(max)} characters`);
    if (FORBIDDEN.test(t)) return this.add(field, "must not contain line breaks or control characters");
    return t;
  }

  email(field: string, v: unknown): string | undefined {
    const t = this.text(field, v, MAX.email);
    if (t !== undefined && !EMAIL.test(t)) return this.add(field, "must be an email address");
    return t;
  }

  url(field: string, v: unknown): string | undefined {
    const t = this.text(field, v, MAX.url);
    if (t === undefined) return undefined;
    try {
      const u = new URL(t);
      if (u.protocol !== "https:" || u.username !== "" || u.password !== "") throw new Error("scheme");
    } catch {
      return this.add(field, "must be an https URL without credentials");
    }
    return t;
  }

  list(field: string, v: unknown, minLength: number, maxLength: number, maxItem: number): string[] | undefined {
    if (!Array.isArray(v) || v.length < minLength || v.length > maxLength) {
      return this.add(field, `must have ${minLength === 0 ? "at most" : `from ${String(minLength)} to`} ${String(maxLength)} items`);
    }
    const items = (v as unknown[]).map((x, i) => this.text(`${field}[${String(i)}]`, x, maxItem));
    return items.every((x) => x !== undefined) ? (items as string[]) : undefined;
  }
}

/** Checks the form input and returns every problem at once. The input object is not modified. */
export function validateNoticeInput(raw: unknown): ValidationResult {
  const c = new Collector();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: "", message: "must be an object" }] };
  }
  const r = raw as Record<string, unknown>;

  const organisationName = c.text("organisationName", r.organisationName, MAX.name);
  const websiteUrl = c.url("websiteUrl", r.websiteUrl);
  const grievanceEmail = c.email("grievanceEmail", r.grievanceEmail);
  const grievanceAddress = c.text("grievanceAddress", r.grievanceAddress, MAX.address);
  const dpoName = r.dpoName === undefined || r.dpoName === "" ? undefined : c.text("dpoName", r.dpoName, MAX.name);
  const withdrawalUrl = c.url("withdrawalUrl", r.withdrawalUrl);
  const rightsRequestUrl = c.url("rightsRequestUrl", r.rightsRequestUrl);
  const thirdParties =
    r.thirdParties === undefined ? [] : c.list("thirdParties", r.thirdParties, 0, MAX.thirdParties, MAX.name);
  if (typeof r.processesChildrenData !== "boolean") c.add("processesChildrenData", "must be true or false");

  const purposes: NoticePurpose[] = [];
  if (!Array.isArray(r.purposes) || r.purposes.length < 1 || r.purposes.length > MAX.purposes) {
    c.add("purposes", `must have from 1 to ${String(MAX.purposes)} purposes`);
  } else {
    (r.purposes as unknown[]).forEach((p, i) => {
      const at = `purposes[${String(i)}]`;
      if (typeof p !== "object" || p === null) {
        c.add(at, "must be an object");
        return;
      }
      const o = p as Record<string, unknown>;
      const name = c.text(`${at}.name`, o.name, MAX.name);
      const description = c.text(`${at}.description`, o.description, MAX.description);
      const retention = c.text(`${at}.retention`, o.retention, MAX.retention);
      const dataItems = c.list(`${at}.dataItems`, o.dataItems, 1, MAX.items, MAX.item);
      if (name !== undefined && description !== undefined && retention !== undefined && dataItems !== undefined) {
        purposes.push({ name, description, dataItems, retention });
      }
    });
  }

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return {
    ok: true,
    value: {
      organisationName: organisationName as string,
      websiteUrl: websiteUrl as string,
      grievanceEmail: grievanceEmail as string,
      grievanceAddress: grievanceAddress as string,
      ...(dpoName !== undefined ? { dpoName } : {}),
      purposes,
      thirdParties: thirdParties ?? [],
      processesChildrenData: r.processesChildrenData as boolean,
      withdrawalUrl: withdrawalUrl as string,
      rightsRequestUrl: rightsRequestUrl as string,
    },
  };
}

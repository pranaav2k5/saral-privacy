export interface ConsentState {
  decision: "granted" | "refused";
  consentId?: string;
  receiptId?: string;
  /** Each purpose key with whether it was granted. */
  purposes: Record<string, boolean>;
  at: string;
}

const keyFor = (noticeId: string): string => `saral-privacy:${noticeId}`;

function valid(v: unknown): v is ConsentState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.decision !== "granted" && o.decision !== "refused") return false;
  if (typeof o.at !== "string" || typeof o.purposes !== "object" || o.purposes === null) return false;
  if (!Object.values(o.purposes).every((p) => typeof p === "boolean")) return false;
  return o.decision === "refused" || (typeof o.consentId === "string" && typeof o.receiptId === "string");
}

/**
 * Keeps the decision in the person's own browser: the decision, the receipt and consent ids, and the per-purpose choices.
 * Never the email address or phone number. If storage is blocked, the decision is held in memory for this page.
 */
export class Store {
  private memory: ConsentState | null = null;

  constructor(
    private readonly noticeId: string,
    private readonly storage: Storage | undefined,
  ) {}

  read(): ConsentState | null {
    try {
      const raw = this.storage?.getItem(keyFor(this.noticeId));
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (valid(parsed)) return (this.memory = parsed);
      }
    } catch {
      // Blocked or corrupt storage: fall back to memory.
    }
    return this.memory;
  }

  write(state: ConsentState): void {
    this.memory = state;
    try {
      this.storage?.setItem(keyFor(this.noticeId), JSON.stringify(state));
    } catch {
      // Held in memory only.
    }
  }

  clear(): void {
    this.memory = null;
    try {
      this.storage?.removeItem(keyFor(this.noticeId));
    } catch {
      // Nothing to remove.
    }
  }
}

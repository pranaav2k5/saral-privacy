"use client";

import { useState } from "react";
import { ApiError, type Anchor, type AuditResult } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAction } from "@/lib/use-action";
import { messageOf } from "@/lib/use-load";
import { Alert, Button } from "./ui";

const FAILURE_WORDS: Record<string, string> = {
  hash_mismatch: "its fingerprint does not match its contents",
  prev_mismatch: "it does not link to the entry before it",
  seq_gap: "an entry is missing before it",
  unknown_key: "it was signed with a key this system does not know",
  key_version_regression: "it uses an older signing key than the entry before it",
  unsupported_version: "it uses a format this system does not support",
  invalid_fields: "its fields are not valid",
  tenant_mismatch: "it belongs to a different organisation",
  anchor_mismatch: "it does not match the saved daily anchor",
};
const failureText = (failure: string, seqNo: string) => `entry ${seqNo}: ${FAILURE_WORDS[failure] ?? failure}`;

const range = (count: number, first: string | null, last: string | null) => `${String(count)} ${count === 1 ? "entry" : "entries"}, numbered ${first ?? "?"} to ${last ?? "?"}`;

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-soft">{label}</dt>
      <dd className="break-all font-mono text-sm">{value}</dd>
    </>
  );
}

export function AuditPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          Every consent, withdrawal and rights request is written to a log in which each entry is chained to the one before it. Verifying recomputes the chain, so
          any entry that was changed or removed shows up.
        </p>
      </div>
      <VerifyCard />
      <AnchorCard />
    </div>
  );
}

function VerifyCard() {
  const { api } = useSession();
  const [date, setDate] = useState("");
  const action = useAction<{ result: AuditResult; day: string | null }>(messageOf);

  return (
    <section aria-labelledby="verify-h" className="flex flex-col gap-3 rounded border border-rule bg-sheet p-4">
      <h2 id="verify-h" className="text-xl font-semibold">Verify the log</h2>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => ({ result: await api.verifyAudit(date === "" ? undefined : date), day: date === "" ? null : date }));
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="verify-date" className="font-medium">Check only this day, UTC (optional)</label>
          <input id="verify-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); action.reset(); }} className="min-h-11 rounded border border-field bg-sheet px-3" />
        </div>
        <Button type="submit" disabled={action.busy}>{action.busy ? "Verifying…" : "Verify"}</Button>
      </form>
      {action.error && <Alert>{action.error}</Alert>}
      {action.result && !action.result.result.ok && (
        <Alert>The log does not match at {failureText(action.result.result.failure, action.result.result.seqNo)}. Do not rely on this log until it is explained.</Alert>
      )}
      {action.result?.result.ok && action.result.result.count === 0 && <p role="status">There are no entries to check yet.</p>}
      {action.result?.result.ok && action.result.result.count > 0 && (
        <div role="status" className="flex flex-col gap-2 rounded bg-ok-bg p-3 text-ok-fg">
          <p className="font-semibold">{action.result.day ? `The log is intact for ${action.result.day} (UTC).` : "The log is intact."}</p>
          {action.result.day && <p>Only that day&apos;s entries were checked. Check without a day to verify the whole chain.</p>}
          <p>{range(action.result.result.count, action.result.result.firstSeqNo, action.result.result.lastSeqNo)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <Hash label="Latest entry fingerprint" value={action.result.result.headHash} />
            <Hash label="Merkle root" value={action.result.result.merkleRoot} />
          </dl>
        </div>
      )}
    </section>
  );
}

function AnchorCard() {
  const { api } = useSession();
  const [day, setDay] = useState("");
  const action = useAction<Anchor>((e) => {
    if (e instanceof ApiError && e.status === 404) return "There are no audit entries on that day.";
    if (e instanceof ApiError && e.status === 409) {
      const b = (e.body ?? {}) as { failure?: unknown; seqNo?: unknown };
      if (typeof b.failure === "string" && typeof b.seqNo === "string") return `The log did not verify on that day, so no anchor was made. It failed at ${failureText(b.failure, b.seqNo)}.`;
    }
    return messageOf(e);
  });

  return (
    <section aria-labelledby="anchor-h" className="flex flex-col gap-3 rounded border border-rule bg-sheet p-4">
      <h2 id="anchor-h" className="text-xl font-semibold">Daily anchor</h2>
      <p className="max-w-prose text-ink-soft">
        An anchor is a short fingerprint of everything logged on one day. Keep a copy somewhere outside Saral, such as in your own records: if the log is ever
        altered, its fingerprint will no longer match your copy.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (day === "") {
            action.fail("Choose a day.");
            return;
          }
          void action.run(() => api.anchor(day));
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="anchor-day" className="font-medium">Day (UTC)</label>
          <input id="anchor-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="min-h-11 rounded border border-field bg-sheet px-3" />
        </div>
        <Button type="submit" disabled={action.busy}>{action.busy ? "Fetching…" : "Get anchor"}</Button>
      </form>
      {action.error && <Alert>{action.error}</Alert>}
      {action.result && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded bg-neutral-bg p-3">
          <dt className="text-ink-soft">Day</dt>
          <dd>{action.result.date}</dd>
          <dt className="text-ink-soft">Entries</dt>
          <dd>{range(action.result.count, action.result.firstSeqNo, action.result.lastSeqNo)}</dd>
          <Hash label="Latest entry fingerprint" value={action.result.headHash} />
          <Hash label="Merkle root" value={action.result.merkleRoot} />
        </dl>
      )}
    </section>
  );
}

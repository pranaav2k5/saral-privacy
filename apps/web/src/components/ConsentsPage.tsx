"use client";

import { useCallback, useState } from "react";
import type { ConsentView } from "@/lib/api";
import { dayLabel, when } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useAction } from "@/lib/use-action";
import { messageOf, useLoad } from "@/lib/use-load";
import { Alert, Button, focusOnMount } from "./ui";

const DAYS = 30;
const LANGUAGE: Record<string, string> = { en: "English", hi: "Hindi" };
const HOW: Record<ConsentView["collectionMethod"], string> = { web_sdk: "Website banner", api: "Your server (API)", dpo_entry: "Entered by an officer" };

const status = (c: ConsentView): string => (c.status === "granted" ? "Active" : c.status === "expired" ? "Expired" : `Withdrawn ${when(c.withdrawnAt ?? c.grantedAt)}`);

function purposes(c: ConsentView): string {
  const yes = c.purposes.filter((p) => p.granted).map((p) => p.key);
  const no = c.purposes.filter((p) => !p.granted).map((p) => p.key);
  return [yes.length > 0 ? `Agreed: ${yes.join(", ")}` : "", no.length > 0 ? `Not agreed: ${no.join(", ")}` : ""].filter((x) => x !== "").join(". ");
}

export function ConsentsPage() {
  const { api } = useSession();
  const load = useCallback(() => api.consentSummary(DAYS), [api]);
  const summary = useLoad(load);
  const [identifier, setIdentifier] = useState("");
  const [round, setRound] = useState(0);
  const search = useAction<{ consents: ConsentView[]; truncated: boolean }>(messageOf);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = identifier.trim();
    if (typed === "") return search.fail("Enter a phone number or an email address.");
    const found = await search.run(() => api.searchConsents(typed));
    if (found !== undefined) setRound((n) => n + 1);
  }

  const empty = summary.status === "ready" && summary.data.totals.active + summary.data.totals.withdrawn + summary.data.totals.expired === 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Consents</h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          How many consents your organisation holds, and a way to find one person&apos;s consents when they write to you.
        </p>
      </div>

      <section aria-labelledby="find-h" className="flex flex-col gap-3 rounded border border-rule bg-sheet p-4">
        <h2 id="find-h" className="text-xl font-semibold">Find a person&apos;s consents</h2>
        <p className="max-w-prose text-ink-soft">
          Type the phone number or email address the person gave. Every search that finds a person is recorded in the audit log, with who looked.
        </p>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="identifier" className="font-medium">Phone number or email address</label>
            <input
              id="identifier"
              type="text"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="min-h-11 max-w-md rounded border border-field bg-sheet px-3"
            />
          </div>
          {search.error && <Alert>{search.error}</Alert>}
          <Button type="submit" className="self-start" disabled={search.busy}>{search.busy ? "Finding…" : "Find consents"}</Button>
        </form>

        {search.result && (
          <section key={round} aria-labelledby="found-h" className="flex flex-col gap-3">
            <h3 id="found-h" ref={focusOnMount} tabIndex={-1} className="text-lg font-semibold">Consents found</h3>
            {search.result.consents.length === 0 && <p>No consent was found for that phone number or email address.</p>}
            {search.result.consents.length > 0 && (
              <>
                {search.result.truncated && <p>Only the newest 100 are shown. There are more.</p>}
                <table className="w-full border-collapse text-left">
                  <caption className="sr-only">Consents of the person, newest first</caption>
                  <thead>
                    <tr className="border-b border-rule text-sm text-ink-soft">
                      <th scope="col" className="py-2 pr-3">Status</th>
                      <th scope="col" className="py-2 pr-3">Given</th>
                      <th scope="col" className="py-2 pr-3">How</th>
                      <th scope="col" className="py-2 pr-3">Notice</th>
                      <th scope="col" className="py-2 pr-3">Purposes</th>
                      <th scope="col" className="py-2">Receipt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {search.result.consents.map((c) => (
                      <tr key={c.id} className="border-b border-rule align-top">
                        <th scope="row" className="py-2 pr-3 font-normal">{status(c)}</th>
                        <td className="py-2 pr-3">{when(c.grantedAt)}</td>
                        <td className="py-2 pr-3">{HOW[c.collectionMethod]}</td>
                        <td className="py-2 pr-3">Version {c.notice.version}, {LANGUAGE[c.notice.language] ?? c.notice.language}</td>
                        <td className="py-2 pr-3">{purposes(c)}</td>
                        <td className="break-all py-2 font-mono text-sm">{c.receiptId ?? "No receipt"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}
      </section>

      {summary.status === "loading" && <p role="status">Loading the numbers…</p>}
      {summary.status === "error" && (
        <div className="flex flex-col items-start gap-3">
          <Alert>{summary.error}</Alert>
          <Button type="button" onClick={summary.retry}>Try again</Button>
        </div>
      )}
      {empty && <p>No consent has been recorded yet.</p>}
      {summary.status === "ready" && !empty && (
        <>
          <section aria-labelledby="numbers-h" className="flex flex-col gap-3">
            <h2 id="numbers-h" className="text-xl font-semibold">In numbers</h2>
            <dl className="grid max-w-xl grid-cols-3 gap-3">
              {([["Active", summary.data.totals.active], ["Withdrawn", summary.data.totals.withdrawn], ["Expired", summary.data.totals.expired]] as const).map(([label, n]) => (
                <div key={label} className="rounded border border-rule bg-sheet p-3">
                  <dt className="text-sm text-ink-soft">{label}</dt>
                  <dd className="text-2xl font-semibold">{n}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="purposes-h" className="flex flex-col gap-3">
            <h2 id="purposes-h" className="text-xl font-semibold">By purpose</h2>
            <table className="w-full max-w-xl border-collapse text-left">
              <caption className="sr-only">By purpose: the consents that agreed to each purpose</caption>
              <thead>
                <tr className="border-b border-rule text-sm text-ink-soft">
                  <th scope="col" className="py-2 pr-3">Purpose</th>
                  <th scope="col" className="py-2 pr-3">Active</th>
                  <th scope="col" className="py-2 pr-3">Withdrawn</th>
                  <th scope="col" className="py-2">Expired</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.purposes.map((p) => (
                  <tr key={p.key} className="border-b border-rule">
                    <th scope="row" className="py-2 pr-3 font-normal">{p.key}</th>
                    <td className="py-2 pr-3">{p.active}</td>
                    <td className="py-2 pr-3">{p.withdrawn}</td>
                    <td className="py-2">{p.expired}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="days-h" className="flex flex-col gap-3">
            <h2 id="days-h" className="text-xl font-semibold">Last {DAYS} days</h2>
            <p className="text-ink-soft">{dayLabel(summary.data.from)} to {dayLabel(summary.data.to)}, UTC days.</p>
            <table className="w-full max-w-xl border-collapse text-left">
              <caption className="sr-only">Last {DAYS} days: consents given and withdrawn each day</caption>
              <thead>
                <tr className="border-b border-rule text-sm text-ink-soft">
                  <th scope="col" className="py-2 pr-3">Day</th>
                  <th scope="col" className="py-2 pr-3">Given</th>
                  <th scope="col" className="py-2">Withdrawn</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.days.map((d) => (
                  <tr key={d.date} className="border-b border-rule">
                    <th scope="row" className="py-2 pr-3 font-normal">{dayLabel(d.date)}</th>
                    <td className="py-2 pr-3">{d.granted}</td>
                    <td className="py-2">{d.withdrawn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

    </div>
  );
}

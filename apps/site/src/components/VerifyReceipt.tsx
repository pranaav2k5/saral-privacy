"use client";

import { useRef, useState } from "react";
import { parseJwks, reasonInWords, verifyReceiptToken, type ReceiptSummary, type VerifyResult } from "@/lib/receipt-verify";

const KEYS_TIMEOUT_MS = 10_000;
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const utc = (iso: string): string => `${DAY.format(new Date(iso))}, ${iso.slice(11, 16)} UTC`;

type Outcome = { kind: "valid"; kid: string; summary: ReceiptSummary } | { kind: "refused"; message: string } | { kind: "no_keys" };

export function VerifyReceipt({ apiBase, fetchFn }: { apiBase: string; fetchFn?: typeof fetch }) {
  const keysUrl = `${apiBase}/.well-known/jwks.json`;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const running = useRef(false);

  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    setOutcome(null);
    if (text.trim() === "") {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    running.current = true;
    setBusy(true);
    try {
      let jwks: ReturnType<typeof parseJwks> = null;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), KEYS_TIMEOUT_MS);
      try {
        // Only the public keys are fetched: no cookies, no body, and the receipt is not in the address.
        const res = await (fetchFn ?? fetch)(keysUrl, { credentials: "omit", cache: "no-store", signal: abort.signal });
        jwks = res.ok ? parseJwks(await res.json()) : null;
      } catch {
        jwks = null;
      } finally {
        clearTimeout(timer);
      }
      if (jwks === null) {
        setOutcome({ kind: "no_keys" });
        return;
      }
      const result: VerifyResult = await verifyReceiptToken(text, jwks);
      setOutcome(result.ok ? { kind: "valid", kid: result.kid, summary: result.summary } : { kind: "refused", message: result.message || reasonInWords(result.code) });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={(e) => void check(e)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="receipt" className="font-medium">Consent receipt</label>
          <p className="text-sm text-ink-soft">The long piece of text you were given when you agreed. Paste all of it.</p>
          <textarea
            id="receipt"
            rows={6}
            spellCheck={false}
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-field bg-white px-3 py-2 font-mono text-sm"
          />
        </div>
        <p className="text-sm text-ink-soft">
          Nothing you paste leaves this page. The only thing fetched is the public key set at <code className="break-all">{keysUrl}</code>.
        </p>
        {empty && (
          <p role="alert" className="rounded-md border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">Paste the receipt first.</p>
        )}
        <button type="submit" disabled={busy} className="self-start rounded-md bg-action px-5 py-3 font-medium text-white disabled:opacity-60">
          {busy ? "Checking…" : "Check this receipt"}
        </button>
      </form>

      {outcome?.kind === "no_keys" && (
        <p role="alert" className="rounded-md border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">
          We could not get the signing keys from {keysUrl}, so the receipt could not be checked. This says nothing about the receipt. Try again in a moment.
        </p>
      )}
      {outcome?.kind === "refused" && (
        <div role="alert" className="rounded-md border border-overdue-fg bg-overdue-bg px-4 py-3 text-overdue-fg">
          <p className="font-semibold">This receipt could not be confirmed.</p>
          <p className="mt-1">{outcome.message}</p>
        </div>
      )}

      {outcome?.kind === "valid" && (
        <>
          <section aria-labelledby="valid-h" className="flex flex-col gap-4 rounded-md border border-ok-fg bg-ok-bg p-5 text-ink">
            <h2 id="valid-h" className="text-xl font-semibold text-ok-fg">The signature is valid</h2>
            <p>
              This receipt was signed with key <code>{outcome.kid}</code> published at {apiBase}, and it has not been changed since.
            </p>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
              <dt className="font-medium">Receipt number</dt>
              <dd className="break-all font-mono text-sm">{outcome.summary.receiptId}</dd>
              <dt className="font-medium">Consent given</dt>
              <dd>{utc(outcome.summary.consentedAt)}</dd>
              <dt className="font-medium">Organisation</dt>
              <dd>{outcome.summary.controllers.join(", ")}</dd>
              {outcome.summary.language !== undefined && (
                <>
                  <dt className="font-medium">Language</dt>
                  <dd>{outcome.summary.language}</dd>
                </>
              )}
              <dt className="font-medium">Policy address</dt>
              <dd className="break-all">{outcome.summary.policyUrl}</dd>
              {outcome.summary.noticeSha256 !== undefined && (
                <>
                  <dt className="font-medium">Notice fingerprint</dt>
                  <dd className="break-all font-mono text-sm">{outcome.summary.noticeSha256}</dd>
                </>
              )}
            </dl>
            {outcome.summary.services.map((s) => (
              <div key={s.service} className="flex flex-col gap-2">
                <h3 className="font-semibold">{s.service}</h3>
                <ul className="flex flex-col gap-3">
                  {s.purposes.map((p, i) => (
                    <li key={`${p.name ?? ""}-${String(i)}`} className="rounded-md border border-rule bg-white p-3">
                      <p className="font-medium">{p.name ?? p.categories.join(", ")}</p>
                      <p>Kinds of purpose: {p.categories.join(", ")}</p>
                      <p>Personal data: {p.data.join(", ")}</p>
                      <p>How to withdraw: {p.withdrawVia}</p>
                      <p>{p.sharedWith === null ? "Not shared with a third party" : `Shared with ${p.sharedWith}`}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <section aria-labelledby="limits-h" className="flex flex-col gap-2">
            <h2 id="limits-h" className="text-lg font-semibold">What this does not show</h2>
            <ul className="list-disc pl-5">
              <li>Who the person is. A receipt holds a number that stands for the person, never a phone number or an email address.</li>
              <li>That the consent is still in force. The person may have withdrawn it since. Ask the organisation.</li>
              <li>The text of the notice that was shown. The receipt holds its fingerprint (a SHA-256 hash), which the organisation can match to the notice it published.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

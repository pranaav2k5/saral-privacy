"use client";

import { useCallback, useState, type FormEvent } from "react";
import type { RightsRequest } from "@/lib/api";
import { dueLabel, when, type Tone } from "@/lib/format";
import { useSession } from "@/lib/session";
import { ACTION_LABEL, STATES, nextStates, stateLabel, typeLabel, type RequestState } from "@/lib/states";
import { messageOf, useLoad } from "@/lib/use-load";
import { Alert, Button } from "./ui";

const TONE: Record<Tone, string> = {
  overdue: "bg-overdue-bg text-overdue-fg",
  soon: "bg-soon-bg text-soon-fg",
  ok: "bg-ok-bg text-ok-fg",
  done: "bg-neutral-bg text-neutral-fg",
};

/** The text says how long is left, so the colour is never the only signal. */
export function DueBadge({ request, now }: { request: RightsRequest; now: number }) {
  const due = dueLabel(request.dueAt, request.state, new Date(now));
  return <span className={`inline-block rounded px-2 py-0.5 text-sm font-medium ${TONE[due.tone]}`}>{due.text}</span>;
}

export function RequestsPage() {
  const { api, now } = useSession();
  const [state, setState] = useState<RequestState | "">("");
  const [overdue, setOverdue] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => api.listRequests({ ...(state ? { state } : {}), overdue }), [api, state, overdue]);
  const list = useLoad(load);
  const filtered = state !== "" || overdue;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Rights requests</h1>
      <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-col gap-1">
          <label htmlFor="status-filter" className="font-medium">Status</label>
          <select id="status-filter" value={state} onChange={(e) => setState(e.target.value as RequestState | "")} className="min-h-11 rounded border border-field bg-sheet px-3">
            <option value="">All</option>
            {STATES.map((s) => (
              <option key={s} value={s}>{stateLabel(s)}</option>
            ))}
          </select>
        </div>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} className="size-5" />
          Overdue only
        </label>
      </form>

      <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
        <div>
          {list.status === "loading" && <p role="status">Loading requests…</p>}
          {list.status === "error" && (
            <div className="flex flex-col items-start gap-3">
              <Alert>{list.error}</Alert>
              <Button type="button" onClick={list.retry}>Try again</Button>
            </div>
          )}
          {list.status === "ready" && list.data.length === 0 && (
            <p>{filtered ? "No requests match these filters." : "No requests yet. Requests made through your privacy notice or consent form appear here."}</p>
          )}
          {list.status === "ready" && list.data.length > 0 && (
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Rights requests, soonest due first</caption>
              <thead>
                <tr className="border-b border-rule text-sm text-ink-soft">
                  <th scope="col" className="py-2 pr-3">Request</th>
                  <th scope="col" className="py-2 pr-3">Status</th>
                  <th scope="col" className="py-2">Due</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id} className="border-b border-rule">
                    <th scope="row" className="py-1 pr-3 font-normal">
                      <button
                        type="button"
                        onClick={() => setSelected(r.id)}
                        aria-current={selected === r.id ? "true" : undefined}
                        className="min-h-11 rounded px-1 text-left text-action underline aria-[current=true]:font-semibold aria-[current=true]:text-ink"
                      >
                        {typeLabel(r.type)}
                        <span className="sr-only">, submitted {when(r.submittedAt)}</span>
                      </button>
                    </th>
                    <td className="py-1 pr-3">{stateLabel(r.state)}</td>
                    <td className="py-1"><DueBadge request={r} now={now()} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected && <RequestDetail key={selected} id={selected} onChanged={list.refresh} />}
      </div>
    </div>
  );
}

const CONFIRM: Partial<Record<RequestState, { warning: string; yes: string }>> = {
  fulfilled: { warning: "Marking a request as fulfilled cannot be undone.", yes: "Yes, mark as fulfilled" },
  closed: { warning: "Closing a request cannot be undone.", yes: "Yes, close request" },
};

function RequestDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { api, now } = useSession();
  const load = useCallback(() => api.getRequest(id), [api, id]);
  const loaded = useLoad(load);
  const [moved, setMoved] = useState<RightsRequest | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RequestState | null>(null);
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The heading takes focus once, when it first appears, so keyboard users land on the request they opened.
  const focusOnMount = useCallback((el: HTMLElement | null) => el?.focus(), []);

  if (loaded.status === "loading") return <p role="status">Loading request…</p>;
  if (loaded.status === "error") return <Alert>{loaded.error}</Alert>;
  const r = moved ?? loaded.data;

  async function go(to: RequestState, why?: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const updated = await api.transition(id, to, why);
      setMoved({ ...r, ...updated, details: r.details ?? null });
      setNote(`Moved to ${stateLabel(to)}.`);
      setConfirm(null);
      setReason("");
      onChanged();
    } catch (e) {
      setProblem(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setContact((await api.revealContact(id)).contact);
    } catch (e) {
      setProblem(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  function submitRejection(ev: FormEvent) {
    ev.preventDefault();
    const text = reason.trim();
    if (text === "") {
      setProblem("Give a reason for the rejection. It is kept with the request.");
      return;
    }
    void go("rejected", text);
  }

  return (
    <section aria-labelledby={`req-${id}`} className="flex flex-col gap-4 rounded border border-rule bg-sheet p-4">
      <h2 id={`req-${id}`} ref={focusOnMount} tabIndex={-1} className="text-xl font-semibold">{typeLabel(r.type)} request</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-ink-soft">Status</dt>
        <dd>{stateLabel(r.state)}</dd>
        <dt className="text-ink-soft">Submitted</dt>
        <dd>{when(r.submittedAt)}</dd>
        <dt className="text-ink-soft">Due</dt>
        <dd>{when(r.dueAt)} <DueBadge request={r} now={now()} /></dd>
        {r.closedAt && (
          <>
            <dt className="text-ink-soft">Closed</dt>
            <dd>{when(r.closedAt)}</dd>
          </>
        )}
        {r.decidedReason && (
          <>
            <dt className="text-ink-soft">Reason for rejecting</dt>
            <dd>{r.decidedReason}</dd>
          </>
        )}
      </dl>
      {r.details && (
        <div>
          <h3 className="text-sm text-ink-soft">What the person wrote</h3>
          <p className="whitespace-pre-wrap">{r.details}</p>
        </div>
      )}

      <div className="flex flex-col items-start gap-2">
        {contact === null ? (
          <Button type="button" onClick={() => void reveal()} disabled={busy}>Show contact details</Button>
        ) : (
          <p>
            <span className="text-ink-soft">Contact: </span>
            <strong>{contact}</strong>
          </p>
        )}
        <p className="text-sm text-ink-soft">Showing contact details is recorded in the audit log.</p>
      </div>

      {problem && <Alert>{problem}</Alert>}
      {note && <p role="status" className="rounded bg-ok-bg px-3 py-2 text-ok-fg">{note}</p>}

      {confirm === "rejected" ? (
        <form onSubmit={submitRejection} className="flex flex-col gap-2">
          <label htmlFor={`reason-${id}`} className="font-medium">Reason for rejecting</label>
          <textarea id={`reason-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} className="rounded border border-field bg-sheet p-2" />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>Confirm rejection</Button>
            <Button type="button" onClick={() => { setConfirm(null); setProblem(null); }} className="!bg-sheet !text-action border border-action">Cancel</Button>
          </div>
        </form>
      ) : confirm && CONFIRM[confirm] ? (
        <div className="flex flex-col gap-2">
          <p>{CONFIRM[confirm].warning}</p>
          <div className="flex gap-2">
            <Button type="button" onClick={() => void go(confirm)} disabled={busy}>{CONFIRM[confirm].yes}</Button>
            <Button type="button" onClick={() => setConfirm(null)} className="!bg-sheet !text-action border border-action">Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {nextStates(r.state).map((to) => (
            <Button
              key={to}
              type="button"
              disabled={busy}
              onClick={() => (to === "rejected" || CONFIRM[to] ? (setProblem(null), setConfirm(to)) : void go(to))}
            >
              {ACTION_LABEL[to]}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

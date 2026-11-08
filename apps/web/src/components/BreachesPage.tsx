"use client";

import { useCallback, useState } from "react";
import type { Breach, BreachNature } from "@/lib/api";
import { boardLine, buildBoardNotified, buildBreachPatch, buildBreachRequest, buildPrincipals, emptyBreachForm, formFromBreach, problemsFromBreachError, stateWords, type BoardTone, type BreachForm, type Problem } from "@/lib/breach-form";
import { when } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { Alert, Button, Field, TextArea, focusOnMount } from "./ui";

const secondary = "!bg-sheet !text-action border border-action";
const NATURE_WORDS: Record<BreachNature, string> = {
  confidentiality: "Someone who should not have seen it saw it",
  integrity: "It was changed or damaged",
  availability: "It could not be reached or was lost",
};
const NATURES: readonly BreachNature[] = ["confidentiality", "integrity", "availability"];
const TONE: Record<BoardTone, string> = { ok: "", soon: "font-semibold", overdue: "font-semibold text-overdue-fg", done: "" };

/** Every problem at once, as one alert that screen readers announce. */
function Problems({ messages }: { messages: readonly string[] }) {
  return (
    <div role="alert" tabIndex={-1} ref={focusOnMount} className="rounded border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">
      <ul className="list-disc pl-5">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

const said = (problems: readonly Problem[]): string[] => problems.map((p) => p.message);

/** The incident form, for reporting and for correcting. */
function BreachFields({ form, set }: { form: BreachForm; set: (f: BreachForm) => void }) {
  const text = <K extends keyof BreachForm>(key: K) => (v: BreachForm[K]) => set({ ...form, [key]: v });
  return (
    <>
      <Field label="Title" value={form.title} onChange={text("title")} />
      <TextArea label="What happened" value={form.description} onChange={text("description")} rows={4} />
      <Field label="When the organisation found out" type="datetime-local" value={form.discoveredAt} onChange={text("discoveredAt")} />
      <Field label="When it happened (if known)" type="datetime-local" value={form.occurredAt} onChange={text("occurredAt")} />
      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">How the data was affected</legend>
        {NATURES.map((n) => (
          <label key={n} className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="size-5" checked={form.nature[n]} onChange={(e) => set({ ...form, nature: { ...form.nature, [n]: e.target.checked } })} />
            {NATURE_WORDS[n]}
          </label>
        ))}
      </fieldset>
      <TextArea label="Kinds of personal data (one on each line)" value={form.dataCategories} onChange={text("dataCategories")} rows={3} />
      <Field label="About how many people (leave empty if not known)" value={form.approx} onChange={text("approx")} />
      <TextArea label="What could happen to the people affected" value={form.consequences} onChange={text("consequences")} />
      <TextArea label="What has been done about it" value={form.measures} onChange={text("measures")} />
    </>
  );
}

const people = (n: number | null): string => (n === null ? "Not known yet" : `About ${String(n)} ${n === 1 ? "person" : "people"}`);

function Detail({ breach, onClose, refresh }: { breach: Breach; onClose: () => void; refresh: () => void }) {
  const { api, role, now } = useSession();
  const isDpo = role === "dpo";
  const factsKey = [breach.title, breach.description, breach.discoveredAt, breach.occurredAt, breach.nature.join(","), breach.dataCategories.join("|"), breach.approxPrincipalsAffected, breach.likelyConsequences, breach.measuresTaken].join("\u0000");
  const loadDrafts = useCallback(() => api.breachDrafts(breach.id), [api, breach.id, factsKey]);
  const drafts = useLoad(loadDrafts);

  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [nothing, setNothing] = useState(false);
  const [editing, setEditing] = useState<BreachForm | null>(null);
  const [board, setBoard] = useState({ notifiedAt: "", reference: "" });
  const [told, setTold] = useState({ how: "", count: "" });
  const [note, setNote] = useState("");

  async function act(work: () => Promise<unknown>, after?: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblems(null);
    setNothing(false);
    try {
      await work();
      after?.();
      refresh();
    } catch (e) {
      setProblems(problemsFromBreachError(e));
    } finally {
      setBusy(false);
    }
  }
  const refuse = (messages: string[]) => {
    setNothing(false);
    setProblems(messages);
  };

  const line = boardLine(breach, new Date(now()));
  const closed = breach.state === "closed";
  const canTellPeople = (breach.state === "signed_off" || breach.state === "board_notified") && breach.principalsNotifiedAt === null;

  if (editing !== null) {
    return (
      <section aria-labelledby="breach-h" className="flex flex-col gap-4 rounded border border-rule bg-sheet p-4">
        <h2 id="breach-h" className="break-words text-xl font-semibold">{breach.title}</h2>
        <form
          aria-label="Correct this report"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const built = buildBreachPatch(editing, breach, new Date(now()));
            if (!built.ok) return refuse(said(built.problems));
            if (Object.keys(built.patch).length === 0) {
              setProblems(null);
              setNothing(true);
              return;
            }
            void act(() => api.updateBreach(breach.id, built.patch), () => setEditing(null));
          }}
        >
          <BreachFields form={editing} set={setEditing} />
          {problems && <Problems messages={problems} />}
          {nothing && <p role="status">Nothing was changed.</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save the correction"}</Button>
            <Button type="button" className={secondary} onClick={() => { setEditing(null); setProblems(null); setNothing(false); }}>Cancel</Button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section aria-labelledby="breach-h" className="flex flex-col gap-5 rounded border border-rule bg-sheet p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="breach-h" ref={focusOnMount} tabIndex={-1} className="break-words text-xl font-semibold">{breach.title}</h2>
        <div className="flex gap-2">
          {breach.state === "reported" && <Button type="button" className={secondary} onClick={() => setEditing(formFromBreach(breach))}>Correct this report</Button>}
          <Button type="button" className={secondary} onClick={onClose}>Close this incident view</Button>
        </div>
      </div>

      <p className={TONE[line.tone]}>{line.text}</p>

      <div className="flex flex-col gap-2">
        <p>Found: {when(breach.discoveredAt)}</p>
        <p>It happened: {breach.occurredAt === null ? "not known" : when(breach.occurredAt)}</p>
        <p className="whitespace-pre-wrap">{breach.description}</p>
        <ul className="list-disc pl-5">
          {breach.nature.map((n) => (
            <li key={n}>{NATURE_WORDS[n]}</li>
          ))}
        </ul>
        <p>Personal data: {breach.dataCategories.join(", ")}</p>
        <p>{people(breach.approxPrincipalsAffected)}</p>
        <p className="whitespace-pre-wrap">{breach.likelyConsequences}</p>
        <p className="whitespace-pre-wrap">{breach.measuresTaken}</p>
      </div>

      <section aria-labelledby="drafts-h" className="flex flex-col gap-3">
        <h3 id="drafts-h" className="text-lg font-semibold">Drafts</h3>
        <p className="text-ink-soft">Written from the facts above and your organisation&apos;s profile. Nobody has reviewed them. Check them against the current Rules and the Board&apos;s own form.</p>
        {drafts.status === "loading" && <p role="status">Loading the drafts…</p>}
        {drafts.status === "error" && (
          <div className="flex flex-col items-start gap-3">
            <Alert>{drafts.error}</Alert>
            <Button type="button" onClick={drafts.retry}>Try again</Button>
          </div>
        )}
        {drafts.status === "ready" && (
          <>
            <h4 className="font-semibold">For the Board</h4>
            <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-rule bg-neutral-bg p-3 text-sm">{drafts.data.boardNotification}</pre>
            <h4 className="font-semibold">For the affected people</h4>
            <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-rule bg-neutral-bg p-3 text-sm">{drafts.data.principalNotice}</pre>
          </>
        )}
      </section>

      <ol aria-label="Steps" className="flex flex-col gap-1">
        <li>Reported {when(breach.reportedAt)}</li>
        <li>Signed off{breach.signedOffAt === null ? ": not yet" : ` ${when(breach.signedOffAt)}`}</li>
        <li>Board told{breach.boardNotifiedAt === null ? ": not yet" : ` ${when(breach.boardNotifiedAt)}, reference ${breach.boardReference ?? ""}`}</li>
        <li>
          Affected people told
          {breach.principalsNotifiedAt === null ? ": not yet" : ` ${when(breach.principalsNotifiedAt)}: ${breach.principalsHow ?? ""} (${String(breach.principalsCount ?? 0)} ${breach.principalsCount === 1 ? "person" : "people"})`}
        </li>
        <li>Closed{breach.closedAt === null ? ": not yet" : ` ${when(breach.closedAt)}: ${breach.closingNote ?? ""}`}</li>
      </ol>

      {problems && <Problems messages={problems} />}

      {!closed && !isDpo && <p className="text-ink-soft">Only the data protection officer can sign off, record what was sent, or close an incident.</p>}

      {isDpo && breach.state === "reported" && (
        <div className="flex flex-col items-start gap-2">
          <p>Signing off records that you have read the drafts and that the facts are right. The report can no longer be corrected after that.</p>
          <Button type="button" disabled={busy} onClick={() => void act(() => api.signOffBreach(breach.id))}>Sign off the drafts</Button>
        </div>
      )}

      {isDpo && breach.state === "signed_off" && (
        <form
          aria-label="Record that the Board was told"
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const built = buildBoardNotified(board, breach.discoveredAt, new Date(now()));
            if (!built.ok) return refuse(said(built.problems));
            void act(() => api.recordBoardNotified(breach.id, built.request));
          }}
        >
          <p>Saral has not sent anything to the Board. Send the draft yourselves, then record here that you did.</p>
          <Field label="When you told the Board" type="datetime-local" value={board.notifiedAt} onChange={(v) => setBoard({ ...board, notifiedAt: v })} />
          <Field label="Reference the Board gave" value={board.reference} onChange={(v) => setBoard({ ...board, reference: v })} />
          <Button type="submit" className="self-start" disabled={busy}>Record that the Board was told</Button>
        </form>
      )}

      {isDpo && canTellPeople && (
        <form
          aria-label="Record that the people were told"
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const built = buildPrincipals(told);
            if (!built.ok) return refuse(said(built.problems));
            void act(() => api.recordPrincipalsNotified(breach.id, built.request));
          }}
        >
          <p>Saral has not sent anything to the people affected either. Send the notice yourselves, then record here how.</p>
          <Field label="How the people were told" value={told.how} onChange={(v) => setTold({ ...told, how: v })} />
          <Field label="How many people were told" value={told.count} onChange={(v) => setTold({ ...told, count: v })} />
          <Button type="submit" className="self-start" disabled={busy}>Record that the people were told</Button>
        </form>
      )}

      {isDpo && breach.state === "board_notified" && breach.principalsNotifiedAt !== null && (
        <form
          aria-label="Close the incident"
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const closing = note.trim();
            if (closing === "") return refuse(["Write a short closing note."]);
            void act(() => api.closeBreach(breach.id, closing));
          }}
        >
          <TextArea label="Closing note" value={note} onChange={setNote} />
          <Button type="submit" className="self-start" disabled={busy}>Close the incident</Button>
        </form>
      )}
    </section>
  );
}

export function BreachesPage() {
  const { api, now } = useSession();
  const load = useCallback(() => api.listBreaches(), [api]);
  const list = useLoad(load);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [form, setForm] = useState<BreachForm>(emptyBreachForm);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildBreachRequest(form, new Date(now()));
    if (!built.ok) return setProblems(said(built.problems));
    setBusy(true);
    setProblems(null);
    try {
      const made = await api.reportBreach(built.request);
      setReporting(false);
      setForm(emptyBreachForm());
      setOpenId(made.id);
      list.refresh();
    } catch (err) {
      setProblems(problemsFromBreachError(err));
    } finally {
      setBusy(false);
    }
  }

  const current = list.status === "ready" && openId !== null ? list.data.find((b) => b.id === openId) : undefined;
  const at = new Date(now());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Breaches</h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          Record a personal data breach, prepare what has to be sent, and keep a record of each step. Saral does not send anything to the Board or to anyone: you send the drafts yourselves, then record here that you did.
        </p>
        <p className="mt-2 max-w-prose text-ink-soft">
          The Board has to be told within 72 hours of when you found out. That 72 hours is the working figure in our plan and has not been confirmed with a lawyer. Confirm it, and what has to be sent, before you rely on it.
        </p>
      </div>

      <section aria-labelledby="incidents-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="incidents-h" className="text-xl font-semibold">Incidents</h2>
          {!reporting && <Button type="button" onClick={() => setReporting(true)}>Report a breach</Button>}
        </div>
        {list.status === "loading" && <p role="status">Loading incidents…</p>}
        {list.status === "error" && (
          <div className="flex flex-col items-start gap-3">
            <Alert>{list.error}</Alert>
            <Button type="button" onClick={list.retry}>Try again</Button>
          </div>
        )}
        {list.status === "ready" && list.data.length === 0 && <p>No breach has been recorded.</p>}
        {list.status === "ready" && list.data.length > 0 && (
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Recorded breaches, newest first</caption>
            <thead>
              <tr className="border-b border-rule text-sm text-ink-soft">
                <th scope="col" className="py-2 pr-3">Incident</th>
                <th scope="col" className="py-2 pr-3">Found</th>
                <th scope="col" className="py-2 pr-3">Status</th>
                <th scope="col" className="py-2 pr-3">Board</th>
                <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((b) => {
                const line = boardLine(b, at);
                return (
                  <tr key={b.id} className="border-b border-rule align-top">
                    <th scope="row" className="py-2 pr-3 font-normal">{b.title}</th>
                    <td className="py-2 pr-3">{when(b.discoveredAt)}</td>
                    <td className="py-2 pr-3">{stateWords(b.state)}</td>
                    <td className={`py-2 pr-3 ${TONE[line.tone]}`}>{line.text}</td>
                    <td className="py-2">
                      <Button type="button" className={secondary} onClick={() => setOpenId(b.id)}>
                        Open<span className="sr-only"> {b.title}</span>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {reporting && (
        <section aria-labelledby="report-h" className="flex flex-col gap-3 rounded border border-rule bg-sheet p-4">
          <h2 id="report-h" className="text-xl font-semibold">Report a breach</h2>
          <form aria-label="Report a breach" onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
            <BreachFields form={form} set={setForm} />
            {problems && <Problems messages={problems} />}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? "Recording…" : "Record the breach"}</Button>
              <Button type="button" className={secondary} onClick={() => { setReporting(false); setProblems(null); }}>Cancel</Button>
            </div>
          </form>
        </section>
      )}

      {current && <Detail key={current.id} breach={current} onClose={() => setOpenId(null)} refresh={list.refresh} />}
    </div>
  );
}

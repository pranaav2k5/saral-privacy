"use client";

import { useCallback, useId, useState } from "react";
import type { RopaActivity, RopaDocument, RopaMeasure, RopaVersionWithRecord } from "@/lib/api";
import { dayLabel, when } from "@/lib/format";
import {
  FIDUCIARY_WORDS, LEGAL_BASIS_WORDS, MEASURE_WORDS, ROLE_WORDS, SOURCE_WORDS, buildRopaDocument, emptyActivityForm, emptyRopaForm, formFromRopa, problemStep, problemsFromRopaError, reviewLine,
  type ActivityForm, type RopaForm,
} from "@/lib/ropa-form";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { Alert, Button, Field, TextArea, focusOnMount } from "./ui";

const secondary = "!bg-sheet !text-action border border-action";
const TONE = { ok: "", soon: "font-semibold", overdue: "font-semibold text-overdue-fg" } as const;
const MEASURES = Object.keys(MEASURE_WORDS) as RopaMeasure[];
const STEPS = ["About the organisation", "What is done with personal data", "Check and save"] as const;

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

/** A group of radio buttons. `value` is "" until the person chooses. */
function Choice<T extends string>({ legend, hint, value, options, onChange }: { legend: string; hint?: string; value: "" | T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  // Each group needs its own name, or the browser treats the same question in two activities as one group of radio buttons.
  const group = useId();
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="font-medium">{legend}</legend>
      {hint && <p className="text-sm text-ink-soft">{hint}</p>}
      {options.map(([v, words]) => (
        <label key={v} className="flex min-h-11 items-center gap-2">
          <input type="radio" className="size-5" name={group} checked={value === v} onChange={() => onChange(v)} />
          {words}
        </label>
      ))}
    </fieldset>
  );
}

const YES_NO = [["yes", "Yes"], ["no", "No"]] as const;
const entries = <T extends string>(words: Record<T, string>): (readonly [T, string])[] => (Object.keys(words) as T[]).map((k) => [k, words[k]] as const);

function OrganisationStep({ form, set }: { form: RopaForm; set: (f: RopaForm) => void }) {
  const o = form.organisation;
  const org = (key: keyof RopaForm["organisation"]) => (v: string) => set({ ...form, organisation: { ...o, [key]: v } });
  return (
    <>
      <Field label="Name of the organisation" value={o.name} onChange={org("name")} />
      <TextArea label="Address" value={o.address} onChange={org("address")} rows={2} />
      <Field label="Contact person" hint="The person to ask about this record." value={o.contactName} onChange={org("contactName")} />
      <Field label="Contact email" type="email" value={o.contactEmail} onChange={org("contactEmail")} autoComplete="off" />
      <Field label="Website (optional)" hint="An https address." value={o.website} onChange={org("website")} />
      <Field label="Line of business" hint="For example retail, a clinic or a school." value={o.sector} onChange={org("sector")} />
      <Choice
        legend="Is the organisation a significant data fiduciary?"
        hint="The government names these under the DPDP Act. If you have not been told that you are one, the answer is most likely No."
        value={o.significantDataFiduciary}
        options={entries(FIDUCIARY_WORDS)}
        onChange={(v) => set({ ...form, organisation: { ...o, significantDataFiduciary: v } })}
      />
      <Field label="Date of the last review" type="date" hint="The day someone last went through this whole record. Change it only when they did." value={form.lastReviewedOn} onChange={(v) => set({ ...form, lastReviewedOn: v })} />
      <Field label="Next review due (optional)" type="date" value={form.nextReviewDue} onChange={(v) => set({ ...form, nextReviewDue: v })} />
    </>
  );
}

function ActivityFields({ a, set }: { a: ActivityForm; set: (a: ActivityForm) => void }) {
  const text = <K extends keyof ActivityForm>(key: K) => (v: ActivityForm[K]) => set({ ...a, [key]: v });
  return (
    <>
      <Field label="Name of the activity" hint="For example Payroll or Newsletter." value={a.name} onChange={text("name")} />
      <TextArea label="What the organisation does with the data" value={a.description} onChange={text("description")} />
      <TextArea label="Why it is done (one reason on each line)" value={a.purposes} onChange={text("purposes")} />
      <Choice legend="Why it is allowed" hint="Saral does not decide this for you. Choose what you believe, or Not sure, and ask your adviser." value={a.legalBasis} options={entries(LEGAL_BASIS_WORDS)} onChange={text("legalBasis")} />
      <TextArea label="Whose data it is (one kind of person on each line)" hint="For example customers or employees." value={a.principals} onChange={text("principals")} rows={2} />
      <TextArea label="What data is kept (one kind on each line)" hint="For example name, phone number or bank account number." value={a.personalData} onChange={text("personalData")} />
      <Choice legend="Is the data of children involved?" hint="A child is a person under 18." value={a.involvesChildren} options={YES_NO} onChange={text("involvesChildren")} />
      <Choice legend="Where the data comes from" value={a.source} options={entries(SOURCE_WORDS)} onChange={text("source")} />

      <fieldset className="flex flex-col gap-3">
        <legend className="font-medium">Who else receives the data</legend>
        <p className="text-sm text-ink-soft">Other organisations the data is given to, or that look after it for you. Leave empty if there are none.</p>
        {a.recipients.map((r, k) => (
          <div key={k} className="flex flex-col gap-2 rounded border border-rule p-3">
            <Field label={`Recipient ${String(k + 1)}: name`} value={r.name} onChange={(v) => set({ ...a, recipients: a.recipients.map((x, j) => (j === k ? { ...x, name: v } : x)) })} />
            <Choice legend={`Recipient ${String(k + 1)}: what it is`} value={r.role} options={entries(ROLE_WORDS)} onChange={(v) => set({ ...a, recipients: a.recipients.map((x, j) => (j === k ? { ...x, role: v } : x)) })} />
            <Field label={`Recipient ${String(k + 1)}: country code`} hint="Two letters, such as IN." value={r.country} onChange={(v) => set({ ...a, recipients: a.recipients.map((x, j) => (j === k ? { ...x, country: v } : x)) })} />
            <div>
              <Button type="button" className={secondary} onClick={() => set({ ...a, recipients: a.recipients.filter((_, j) => j !== k) })}>
                Remove recipient {String(k + 1)}
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button type="button" className={secondary} onClick={() => set({ ...a, recipients: [...a.recipients, { name: "", role: "", country: "" }] })}>Add a recipient</Button>
        </div>
      </fieldset>

      <Choice legend="Is data sent to another country?" value={a.crossBorder} options={YES_NO} onChange={text("crossBorder")} />
      {a.crossBorder === "yes" && <Field label="Which countries" hint="Two-letter codes, such as US or SG, separated by commas." value={a.transferCountries} onChange={text("transferCountries")} />}
      <TextArea label="How long it is kept, and what happens then" value={a.retention} onChange={text("retention")} rows={2} />
      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">How the data is protected</legend>
        {MEASURES.map((m) => (
          <label key={m} className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="size-5" checked={a.securityMeasures[m]} onChange={(e) => set({ ...a, securityMeasures: { ...a.securityMeasures, [m]: e.target.checked } })} />
            {MEASURE_WORDS[m]}
          </label>
        ))}
      </fieldset>
      <Field label="Other ways it is protected (optional)" value={a.otherMeasures} onChange={text("otherMeasures")} />
      <Field label="Where it is kept" hint="For example the name of the software or the cloud service." value={a.storage} onChange={text("storage")} />
      <Field label="Who is responsible for it" value={a.owner} onChange={text("owner")} />
    </>
  );
}

function ActivitiesStep({ form, set }: { form: RopaForm; set: (f: RopaForm) => void }) {
  return (
    <>
      <p className="max-w-prose text-ink-soft">One entry for each thing you do with personal data, such as paying staff, sending a newsletter or taking orders.</p>
      {form.activities.map((a, i) => (
        <fieldset key={i} className="flex flex-col gap-4 rounded border border-rule p-4">
          <legend className="px-1 text-lg font-semibold">Activity {String(i + 1)}{a.name.trim() === "" ? "" : `: ${a.name.trim()}`}</legend>
          <ActivityFields a={a} set={(next) => set({ ...form, activities: form.activities.map((x, j) => (j === i ? next : x)) })} />
          {form.activities.length > 1 && (
            <div>
              <Button type="button" className={secondary} onClick={() => set({ ...form, activities: form.activities.filter((_, j) => j !== i) })}>Remove activity {String(i + 1)}</Button>
            </div>
          )}
        </fieldset>
      ))}
      <div>
        <Button type="button" className={secondary} onClick={() => set({ ...form, activities: [...form.activities, emptyActivityForm()] })}>Add an activity</Button>
      </div>
      <TextArea label="Notes (optional)" hint="Anything else a reader of this record should know." value={form.notes} onChange={(v) => set({ ...form, notes: v })} />
    </>
  );
}

const yes = (b: boolean): string => (b ? "Yes" : "No");
const listed = (xs: readonly string[]): string => (xs.length === 0 ? "None" : xs.join(", "));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-ink-soft sm:w-56">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function ActivityView({ a, n }: { a: RopaActivity; n: number }) {
  return (
    <section aria-label={`Activity ${String(n)}: ${a.name}`} className="rounded border border-rule bg-sheet p-4 print:break-inside-avoid">
      <h3 className="mb-2 break-words text-lg font-semibold">{n}. {a.name}</h3>
      <dl className="flex flex-col gap-1">
        <Row label="What is done">{a.description}</Row>
        <Row label="Why">{listed(a.purposes)}</Row>
        <Row label="Why it is allowed">{LEGAL_BASIS_WORDS[a.legalBasis]}</Row>
        <Row label="Whose data">{listed(a.principals)}</Row>
        <Row label="Data kept">{listed(a.personalData)}</Row>
        <Row label="Children's data">{yes(a.involvesChildren)}</Row>
        <Row label="Where it comes from">{SOURCE_WORDS[a.source]}</Row>
        <Row label="Who else receives it">{a.recipients.length === 0 ? "No one" : a.recipients.map((r) => `${r.name} (${r.country}, ${r.role === "processor" ? "processor" : "third party"})`).join("; ")}</Row>
        <Row label="Sent to another country">{a.crossBorder ? `Yes: ${a.transferCountries.join(", ")}` : "No"}</Row>
        <Row label="How long it is kept">{a.retention}</Row>
        <Row label="How it is protected">{listed([...a.securityMeasures.map((m) => MEASURE_WORDS[m]), ...(a.otherMeasures === undefined ? [] : [a.otherMeasures])])}</Row>
        <Row label="Where it is kept">{a.storage}</Row>
        <Row label="Who is responsible">{a.owner}</Row>
      </dl>
    </section>
  );
}

function RecordView({ doc }: { doc: RopaDocument }) {
  const { now } = useSession();
  const o = doc.organisation;
  const line = reviewLine(doc.review, new Date(now()));
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="The organisation" className="rounded border border-rule bg-sheet p-4">
        <h3 className="mb-2 break-words text-lg font-semibold">{o.name}</h3>
        <dl className="flex flex-col gap-1">
          <Row label="Address">{o.address}</Row>
          <Row label="Contact">{o.contactName}, {o.contactEmail}</Row>
          {o.website !== undefined && <Row label="Website">{o.website}</Row>}
          <Row label="Line of business">{o.sector}</Row>
          <Row label="Significant data fiduciary">{FIDUCIARY_WORDS[o.significantDataFiduciary]}</Row>
          <Row label="Last reviewed">{dayLabel(doc.review.lastReviewedOn)}</Row>
          <Row label="Next review"><span className={TONE[line.tone]}>{line.text}</span></Row>
        </dl>
      </section>
      {doc.activities.map((a, i) => (
        <ActivityView key={a.name} a={a} n={i + 1} />
      ))}
      {doc.notes !== undefined && (
        <section aria-label="Notes" className="rounded border border-rule bg-sheet p-4">
          <h3 className="mb-2 text-lg font-semibold">Notes</h3>
          <p className="whitespace-pre-line break-words">{doc.notes}</p>
        </section>
      )}
    </div>
  );
}

/** The record as a file the person can keep: indented JSON, in a data address so nothing is sent anywhere. */
const downloadAddress = (doc: RopaDocument): string => `data:application/json;charset=utf-8,${encodeURIComponent(`${JSON.stringify(doc, null, 2)}\n`)}`;

function Viewer({ version, isLatest, saved, onUpdate }: { version: RopaVersionWithRecord; isLatest: boolean; saved: boolean; onUpdate: () => void }) {
  return (
    <section aria-labelledby="record-h" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2 print:hidden">
        <h2 id="record-h" className="text-xl font-semibold">Version {String(version.version)}{isLatest ? " (the current one)" : ""}</h2>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onUpdate}>{isLatest ? "Update the record" : "Start a new version from this one"}</Button>
          <a
            href={downloadAddress(version.document)}
            download={`saral-ropa-version-${String(version.version)}.json`}
            className="inline-flex min-h-11 items-center rounded border border-action bg-sheet px-4 py-2 font-semibold text-action"
          >
            Download as JSON
          </a>
          <Button type="button" className={secondary} onClick={() => window.print()}>Print</Button>
        </div>
      </div>
      <h2 className="hidden text-xl font-semibold print:block">Record of processing, version {String(version.version)}</h2>
      {saved && <p role="status" className="rounded border border-rule bg-neutral-bg px-3 py-2 print:hidden">Saved as version {String(version.version)}.</p>}
      <p className="text-sm text-ink-soft">
        Saved {when(version.createdAt)} by {version.createdBy}. {version.note !== null && <>Note: {version.note}. </>}
        Fingerprint (SHA-256): <code className="break-all">{version.sha256}</code>
      </p>
      <RecordView doc={version.document} />
    </section>
  );
}

function Editor({ initial, basedOn, onSaved, onCancel }: { initial: RopaForm; basedOn: number | null; onSaved: (id: string) => void; onCancel: () => void }) {
  const { api, now } = useSession();
  const [form, setForm] = useState(initial);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const next = (basedOn ?? 0) + 1;

  function advance(): void {
    const built = buildRopaDocument(form, new Date(now()));
    const here = step === 0 ? 1 : 2;
    const mine = built.ok ? [] : built.problems.filter((p) => problemStep(p.field) === here);
    if (mine.length > 0) return setProblems(mine.map((p) => p.message));
    setProblems(null);
    setStep(step === 0 ? 1 : 2);
  }

  async function save(): Promise<void> {
    if (busy) return;
    const built = buildRopaDocument(form, new Date(now()));
    if (!built.ok) {
      setProblems(built.problems.map((p) => p.message));
      setStep(problemStep((built.problems[0] as { field: string }).field) === 1 ? 0 : 1);
      return;
    }
    if (note.trim().length > 500) return setProblems(["Note: use at most 500 characters."]);
    setBusy(true);
    setProblems(null);
    try {
      const saved = await api.saveRopa(built.request, note.trim() === "" ? undefined : note.trim(), basedOn ?? 0);
      onSaved(saved.id);
    } catch (e) {
      setProblems(problemsFromRopaError(e));
    } finally {
      setBusy(false);
    }
  }

  /** Only the last step shows the whole record, so only then is it built on every change. */
  const final = step === 2 ? buildRopaDocument(form, new Date(now())) : undefined;
  return (
    <section aria-labelledby="edit-h" className="flex flex-col gap-4 rounded border border-rule bg-sheet p-4">
      <h2 id="edit-h" className="text-xl font-semibold">{basedOn === null ? "Start the record" : `Update the record (a new version ${String(next)})`}</h2>
      <ol aria-label="Steps" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={i === step ? "font-semibold" : "text-ink-soft"}>
            Step {String(i + 1)} of 3: {s}
          </li>
        ))}
      </ol>
      <form
        aria-label={STEPS[step]}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (step < 2) advance();
          else void save();
        }}
      >
        <h3 key={step} ref={focusOnMount} tabIndex={-1} className="text-lg font-semibold">{STEPS[step]}</h3>
        {step === 0 && <OrganisationStep form={form} set={setForm} />}
        {step === 1 && <ActivitiesStep form={form} set={setForm} />}
        {step === 2 && (
          <>
            <p className="max-w-prose">Here is the record as it will be saved. Saving makes version {String(next)}. A saved version is never changed or removed: a change is saved as a new version.</p>
            {final?.ok ? <RecordView doc={final.request} /> : <Problems messages={final?.ok === false ? final.problems.map((p) => p.message) : []} />}
            <TextArea label="Note about this version (optional)" hint="What changed, or why. Kept with the version." value={note} onChange={setNote} rows={2} />
          </>
        )}
        {problems && step !== 2 && <Problems messages={problems} />}
        {problems && step === 2 && final?.ok && <Problems messages={problems} />}
        <div className="flex flex-wrap gap-2">
          {step > 0 && <Button type="button" className={secondary} onClick={() => { setProblems(null); setStep(step === 2 ? 1 : 0); }}>Back</Button>}
          {step < 2 && <Button type="submit">Next</Button>}
          {step === 2 && <Button type="submit" disabled={busy}>{busy ? "Saving…" : `Save as version ${String(next)}`}</Button>}
          <Button type="button" className={secondary} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </section>
  );
}

export function RopaPage() {
  const { api } = useSession();
  const list = useLoad(useCallback(() => api.listRopa(), [api]));
  /** `null` is the newest version; otherwise the version being looked at. */
  const [shownId, setShownId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ form: RopaForm; basedOn: number | null } | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const loadShown = useCallback(() => (shownId === null ? api.latestRopa() : api.getRopa(shownId)), [api, shownId]);
  const hasVersions = list.status === "ready" && list.data.length > 0;
  const shown = useLoad(useCallback(() => (hasVersions ? loadShown() : Promise.resolve(null)), [hasVersions, loadShown]));

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <h1 className="text-2xl font-semibold">Record of processing</h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          A written record of what your organisation does with personal data: who it is about, why, who else gets it, how long it is kept and how it is protected. Keeping one makes every other part of the DPDP work easier, and an auditor or the Board may ask for it.
        </p>
        <p className="mt-2 max-w-prose text-ink-soft">
          Saral keeps each saved version and never changes one. It does not check that your answers are right or that the reasons you give are allowed, and it does not send this record anywhere.
        </p>
      </div>

      {list.status === "loading" && <p role="status">Loading the record…</p>}
      {list.status === "error" && (
        <div className="flex flex-col items-start gap-3">
          <Alert>{list.error}</Alert>
          <Button type="button" onClick={list.retry}>Try again</Button>
        </div>
      )}

      {editing !== null && (
        <Editor
          initial={editing.form}
          basedOn={editing.basedOn}
          onCancel={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            setShownId(id);
            setJustSaved(true);
            list.retry();
          }}
        />
      )}

      {editing === null && list.status === "ready" && list.data.length === 0 && (
        <section aria-labelledby="none-h" className="flex flex-col items-start gap-3 rounded border border-rule bg-sheet p-4">
          <h2 id="none-h" className="text-xl font-semibold">No record has been saved yet</h2>
          <p className="max-w-prose">It takes about 30 questions for the organisation and about 15 for each activity. You can go back to any step before you save.</p>
          <Button type="button" onClick={() => setEditing({ form: emptyRopaForm(), basedOn: null })}>Start the record</Button>
        </section>
      )}

      {editing === null && hasVersions && (
        <>
          {shown.status === "loading" && <p role="status">Loading version…</p>}
          {shown.status === "error" && (
            <div className="flex flex-col items-start gap-3">
              <Alert>{shown.error}</Alert>
              <Button type="button" onClick={shown.retry}>Try again</Button>
            </div>
          )}
          {shown.status === "ready" && shown.data !== null && list.status === "ready" && (
            <Viewer
              version={shown.data}
              isLatest={shown.data.id === (list.data[0] as { id: string }).id}
              saved={justSaved && shown.data.id === shownId}
              onUpdate={() => setEditing({ form: formFromRopa((shown.data as RopaVersionWithRecord).document), basedOn: (list.data[0] as { version: number }).version })}
            />
          )}
          {list.status === "ready" && (
            <section aria-labelledby="versions-h" className="flex flex-col gap-3 print:hidden">
              <h2 id="versions-h" className="text-xl font-semibold">Saved versions</h2>
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">Saved versions, newest first</caption>
                <thead>
                  <tr className="border-b border-rule text-sm text-ink-soft">
                    <th scope="col" className="py-2 pr-3">Version</th>
                    <th scope="col" className="py-2 pr-3">Saved</th>
                    <th scope="col" className="py-2 pr-3">By</th>
                    <th scope="col" className="py-2 pr-3">Note</th>
                    <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((v) => (
                    <tr key={v.id} className="border-b border-rule align-top">
                      <th scope="row" className="py-2 pr-3 font-normal">{v.version}</th>
                      <td className="py-2 pr-3">{when(v.createdAt)}</td>
                      <td className="py-2 pr-3 [overflow-wrap:anywhere]">{v.createdBy}</td>
                      <td className="py-2 pr-3 [overflow-wrap:anywhere]">{v.note ?? ""}</td>
                      <td className="py-2">
                        <Button type="button" className={secondary} onClick={() => { setJustSaved(false); setShownId(v.id === (list.data[0] as { id: string }).id ? null : v.id); }}>
                          View<span className="sr-only"> version {String(v.version)}</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

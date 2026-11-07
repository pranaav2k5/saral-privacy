"use client";

import { useCallback, useRef, useState } from "react";
import type { NoticeSummary } from "@/lib/api";
import { when } from "@/lib/format";
import { buildRequest, emptyForm, emptyPurpose, fieldLabel, problemsFromError, type NoticeForm, type PurposeForm } from "@/lib/notice-form";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { Alert, Button, Field, TextArea, focusOnMount } from "./ui";

const MAX_PURPOSES = 30;
const LANGUAGE: Record<string, string> = { en: "English", hi: "Hindi" };
const language = (code: string) => LANGUAGE[code] ?? code;
const REVIEW: Record<NoticeSummary["reviewStatus"], string> = { "pending-human-review": "Pending human review", reviewed: "Reviewed" };
const secondary = "!bg-sheet !text-action border border-action";

export function NoticesPage() {
  const { api } = useSession();
  const load = useCallback(() => api.listNotices(), [api]);
  const list = useLoad(load);
  const [form, setForm] = useState<NoticeForm>(emptyForm);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [published, setPublished] = useState<NoticeSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const set = <K extends keyof NoticeForm>(key: K, value: NoticeForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setPurpose = (i: number, patch: Partial<PurposeForm>) =>
    setForm((f) => ({ ...f, purposes: f.purposes.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const refuse = (messages: string[]) => {
    setPublished(null);
    setProblems(messages);
    setAttempt((n) => n + 1);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    const built = buildRequest(form);
    if (!built.ok) {
      refuse(built.problems.map((p) => `${fieldLabel(p.field)} ${p.message}.`));
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      const made = await api.publishNotice(built.request);
      setProblems(null);
      setPublished(made);
      list.refresh();
    } catch (err) {
      refuse(problemsFromError(err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const thirdParties = form.thirdParties.split("\n").map((x) => x.trim()).filter((x) => x !== "");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Privacy notices</h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          The notice is what people read when they give consent. Publishing makes a new version. Earlier versions stay readable, so every receipt keeps pointing to the text the person saw. The text is made from our template for the language you choose and is marked pending human review until it has been reviewed.
        </p>
      </div>

      {published && (
        <section key={published.id} aria-labelledby="published-h" className="flex flex-col gap-2 rounded border border-ok-fg bg-ok-bg p-4 text-ok-fg">
          <h2 id="published-h" ref={focusOnMount} tabIndex={-1} className="font-semibold">Published: {language(published.language)}, version {published.version}</h2>
          <p>
            Notice id: <code className="break-all font-mono select-all">{published.id}</code>
          </p>
          <p>Give this id to your consent banner. The notice is marked pending human review.</p>
        </section>
      )}

      <section aria-labelledby="notices-h" className="flex flex-col gap-3">
        <h2 id="notices-h" className="text-xl font-semibold">Published notices</h2>
        {list.status === "loading" && <p role="status">Loading notices…</p>}
        {list.status === "error" && (
          <div className="flex flex-col items-start gap-3">
            <Alert>{list.error}</Alert>
            <Button type="button" onClick={list.retry}>Try again</Button>
          </div>
        )}
        {list.status === "ready" && list.data.length === 0 && <p>No notice has been published yet. Publish one below.</p>}
        {list.status === "ready" && list.data.length > 0 && (
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Published notices</caption>
            <thead>
              <tr className="border-b border-rule text-sm text-ink-soft">
                <th scope="col" className="py-2 pr-3">Notice</th>
                <th scope="col" className="py-2 pr-3">Published</th>
                <th scope="col" className="py-2 pr-3">Review</th>
                <th scope="col" className="py-2 pr-3">Purposes</th>
                <th scope="col" className="py-2">Notice id</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((n) => (
                <tr key={n.id} className="border-b border-rule align-top">
                  <th scope="row" className="py-2 pr-3 font-normal">{language(n.language)}, version {n.version}</th>
                  <td className="py-2 pr-3">{when(n.publishedAt)}</td>
                  <td className="py-2 pr-3">{REVIEW[n.reviewStatus]}</td>
                  <td className="py-2 pr-3">{n.purposeKeys.join(", ")}</td>
                  <td className="break-all py-2 font-mono text-sm">{n.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="publish-h" className="flex flex-col gap-4 rounded border border-rule bg-sheet p-4">
        <h2 id="publish-h" className="text-xl font-semibold">Publish a notice</h2>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="notice-language" className="font-medium">Language</label>
            <select id="notice-language" value={form.language} onChange={(e) => set("language", e.target.value as NoticeForm["language"])} className="min-h-11 rounded border border-field bg-sheet px-3">
              <option value="en">English</option>
              <option value="hi">Hindi</option>
            </select>
          </div>
          <Field label="Organisation name" value={form.organisationName} onChange={(v) => set("organisationName", v)} />
          <Field label="Website" value={form.websiteUrl} onChange={(v) => set("websiteUrl", v)} type="url" hint="Starts with https://" />
          <Field label="Grievance email" value={form.grievanceEmail} onChange={(v) => set("grievanceEmail", v)} type="email" hint="Where people send complaints about their data." />
          <TextArea label="Grievance address" value={form.grievanceAddress} onChange={(v) => set("grievanceAddress", v)} rows={2} hint="One line, with no line breaks." />
          <Field label="Name of the data protection officer (optional)" value={form.dpoName} onChange={(v) => set("dpoName", v)} />
          <TextArea label="Third parties" value={form.thirdParties} onChange={(v) => set("thirdParties", v)} hint="Organisations your data is shared with, one per line. Leave empty if there are none." />
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="size-5" checked={form.processesChildrenData} onChange={(e) => set("processesChildrenData", e.target.checked)} />
            We collect data about children
          </label>
          <Field label="Withdrawal link" value={form.withdrawalUrl} onChange={(v) => set("withdrawalUrl", v)} type="url" hint="Where a person can withdraw consent. Starts with https://. Every receipt names it." />
          <Field label="Rights request link" value={form.rightsRequestUrl} onChange={(v) => set("rightsRequestUrl", v)} type="url" hint="Where a person can ask to see, correct or erase their data. Starts with https://" />

          {form.purposes.map((p, i) => (
            <fieldset key={i} className="flex flex-col gap-3 rounded border border-rule p-3">
              <legend className="px-1 font-semibold">Purpose {i + 1}</legend>
              <Field label="Key" value={p.key} onChange={(v) => setPurpose(i, { key: v })} hint="Lowercase letters, digits and underscores, for example analytics. Your consent banner sends this." />
              <Field label="Name" value={p.name} onChange={(v) => setPurpose(i, { name: v })} hint="What the person reads, for example “Understand how the app is used”." />
              <TextArea label="Description" value={p.description} onChange={(v) => setPurpose(i, { description: v })} rows={2} />
              <TextArea label="Data items" value={p.dataItems} onChange={(v) => setPurpose(i, { dataItems: v })} hint="The data used for this purpose, one per line." />
              <Field label="How long, in words" value={p.retention} onChange={(v) => setPurpose(i, { retention: v })} hint="As the notice says it, for example “12 months”." />
              <Field label="How long, in days" value={p.retentionDays} onChange={(v) => setPurpose(i, { retentionDays: v })} hint="As receipts say it. A whole number from 0 to 36500." />
              <Field label="Purpose categories" value={p.purposeCategory} onChange={(v) => setPurpose(i, { purposeCategory: v })} hint="Separated by commas, for example analytics." />
              <Field label="Data categories" value={p.piiCategory} onChange={(v) => setPurpose(i, { piiCategory: v })} hint="Separated by commas, for example email address." />
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" className="size-5" checked={p.thirdPartyDisclosure} onChange={(e) => setPurpose(i, { thirdPartyDisclosure: e.target.checked, thirdPartyName: "" })} />
                Shared with a third party
              </label>
              {p.thirdPartyDisclosure && (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`third-${String(i)}`} className="font-medium">Third party it is disclosed to</label>
                  {thirdParties.length === 0 && <p className="text-sm text-ink-soft">List the organisations under “Third parties” first, then choose one here.</p>}
                  <select
                    id={`third-${String(i)}`}
                    value={thirdParties.includes(p.thirdPartyName) ? p.thirdPartyName : ""}
                    onChange={(e) => setPurpose(i, { thirdPartyName: e.target.value })}
                    className="min-h-11 rounded border border-field bg-sheet px-3"
                  >
                    <option value="">Choose…</option>
                    {thirdParties.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}
              {form.purposes.length > 1 && (
                <Button type="button" className={`self-start ${secondary}`} onClick={() => set("purposes", form.purposes.filter((_x, j) => j !== i))}>
                  Remove purpose {i + 1}
                </Button>
              )}
            </fieldset>
          ))}
          <Button type="button" className={`self-start ${secondary}`} disabled={form.purposes.length >= MAX_PURPOSES} onClick={() => set("purposes", [...form.purposes, emptyPurpose()])}>
            Add a purpose
          </Button>

          {problems && (
            <div key={attempt} role="alert" tabIndex={-1} ref={focusOnMount} className="rounded border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">
              <p className="font-semibold">The notice was not published.</p>
              <ul className="list-disc pl-5">
                {problems.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          <Button type="submit" className="self-start" disabled={busy}>{busy ? "Publishing…" : "Publish notice"}</Button>
        </form>
      </section>
    </div>
  );
}

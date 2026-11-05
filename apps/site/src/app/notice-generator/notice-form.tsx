"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  noticeSha256,
  renderNotice,
  validateNoticeInput,
  type FieldError,
  type NoticeInput,
  type NoticeLanguage,
} from "@saral/notice";
import NoticeSheet, { type CopyState } from "./notice-sheet";

interface PurposeDraft {
  id: number;
  name: string;
  description: string;
  dataItems: string;
  retention: string;
}

interface Draft {
  organisationName: string;
  websiteUrl: string;
  grievanceEmail: string;
  grievanceAddress: string;
  dpoName: string;
  thirdParties: string;
  processesChildrenData: boolean;
  withdrawalUrl: string;
  rightsRequestUrl: string;
}

const MAX_PURPOSES = 30;

const EMPTY_DRAFT: Draft = {
  organisationName: "",
  websiteUrl: "",
  grievanceEmail: "",
  grievanceAddress: "",
  dpoName: "",
  thirdParties: "",
  processesChildrenData: false,
  withdrawalUrl: "",
  rightsRequestUrl: "",
};

const LABELS = {
  organisationName: "Organisation name",
  websiteUrl: "Website address",
  grievanceEmail: "Email for privacy questions and complaints",
  grievanceAddress: "Postal address",
  dpoName: "Data protection officer",
  thirdParties: "Organisations you share personal data with (separate with commas, leave blank if none)",
  withdrawalUrl: "Page where people can withdraw consent",
  rightsRequestUrl: "Page where people can ask to see, correct or erase their data",
  name: "Purpose name",
  description: "What you do with the data",
  dataItems: "Personal data used (separate with commas)",
  retention: "How long you keep it",
} as const;

type FieldKey = keyof typeof LABELS;

const newPurpose = (id: number): PurposeDraft => ({ id, name: "", description: "", dataItems: "", retention: "" });
const splitList = (v: string): string[] =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** A label without its trailing hint in parentheses, for use inside an error sentence. */
const plain = (label: string): string => label.replace(/ \([^)]*\)$/, "");

/** Maps the engine's field paths to the id of the control they belong to, with a message in plain words. */
function describeErrors(errors: FieldError[], purposeCount: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of errors) {
    const purpose = /^purposes\[(\d+)\]\.(name|description|dataItems|retention)/.exec(e.field);
    if (purpose) {
      const [, index, key] = purpose as unknown as [string, string, FieldKey];
      const prefix = purposeCount > 1 ? `Purpose ${String(Number(index) + 1)}: ` : "";
      const id = `purpose-${index}-${key}`;
      if (!out.has(id)) out.set(id, `${prefix}${plain(LABELS[key])} ${e.message}`);
      continue;
    }
    const base = e.field.replace(/\[\d+\]$/, "") as FieldKey;
    if (base in LABELS && !out.has(base)) out.set(base, `${plain(LABELS[base])} ${e.message}`);
    else if (!out.has(e.field)) out.set(e.field, `${e.field || "The form"} ${e.message}`);
  }
  return out;
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error: string | undefined;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "url";
  rows?: number;
}

const controlClass =
  "mt-1 block w-full rounded-md border border-field bg-sheet px-3 py-2 text-base text-ink aria-[invalid=true]:border-stamp aria-[invalid=true]:border-2";

function Field({ id, label, hint, error, value, onChange, type = "text", rows }: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    className: controlClass,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  } as const;
  return (
    <div>
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {rows ? <textarea {...common} rows={rows} /> : <input {...common} type={type} />}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm font-medium text-stamp">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Group({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 border-t border-rule pt-5">
      <legend className="float-left mb-4 w-full text-lg font-semibold">{legend}</legend>
      {children}
    </fieldset>
  );
}

export default function NoticeForm() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [purposes, setPurposes] = useState<PurposeDraft[]>([newPurpose(1)]);
  const [nextId, setNextId] = useState(2);
  const [language, setLanguage] = useState<NoticeLanguage>("en");
  const [input, setInput] = useState<NoticeInput | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [fingerprint, setFingerprint] = useState<{ text: string; value: string } | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const summaryRef = useRef<HTMLDivElement>(null);

  const notice = useMemo(() => (input ? renderNotice(input, language) : null), [input, language]);
  const noticeText = notice?.text;

  useEffect(() => {
    if (noticeText === undefined) return;
    let cancelled = false;
    void noticeSha256(noticeText).then((value) => {
      if (!cancelled) setFingerprint({ text: noticeText, value });
    });
    return () => {
      cancelled = true;
    };
  }, [noticeText]);

  useEffect(() => {
    if (failedAttempts > 0) summaryRef.current?.focus();
  }, [failedAttempts]);

  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const setPurpose = (id: number, key: keyof Omit<PurposeDraft, "id">) => (value: string) =>
    setPurposes((list) => list.map((p) => (p.id === id ? { ...p, [key]: value } : p)));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validateNoticeInput({
      organisationName: draft.organisationName,
      websiteUrl: draft.websiteUrl,
      grievanceEmail: draft.grievanceEmail,
      grievanceAddress: draft.grievanceAddress,
      dpoName: draft.dpoName,
      purposes: purposes.map((p) => ({
        name: p.name,
        description: p.description,
        dataItems: splitList(p.dataItems),
        retention: p.retention,
      })),
      thirdParties: splitList(draft.thirdParties),
      processesChildrenData: draft.processesChildrenData,
      withdrawalUrl: draft.withdrawalUrl,
      rightsRequestUrl: draft.rightsRequestUrl,
    });
    setCopyState("idle");
    if (result.ok) {
      setErrors(new Map());
      setInput(result.value);
    } else {
      setErrors(describeErrors(result.errors, purposes.length));
      setFailedAttempts((n) => n + 1);
    }
  }

  async function copy() {
    if (notice === null) return;
    try {
      await navigator.clipboard.writeText(notice.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const err = (id: string) => errors.get(id);
  const hash = notice !== null && fingerprint?.text === notice.text ? fingerprint.value : null;

  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)] lg:items-start">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
        {errors.size > 0 ? (
          <div
            ref={summaryRef}
            role="alert"
            tabIndex={-1}
            className="rounded-md border-2 border-stamp bg-sheet p-4 font-medium text-stamp"
          >
            {errors.size} {errors.size === 1 ? "field needs" : "fields need"} attention. Each one is marked below.
          </div>
        ) : null}

        <Group legend="Your organisation">
          <Field id="organisationName" label={LABELS.organisationName} value={draft.organisationName} error={err("organisationName")} onChange={set("organisationName")} />
          <Field id="websiteUrl" label={LABELS.websiteUrl} hint="Starts with https://" type="url" value={draft.websiteUrl} error={err("websiteUrl")} onChange={set("websiteUrl")} />
          <Field id="grievanceEmail" label={LABELS.grievanceEmail} type="email" value={draft.grievanceEmail} error={err("grievanceEmail")} onChange={set("grievanceEmail")} />
          <Field id="grievanceAddress" label={LABELS.grievanceAddress} value={draft.grievanceAddress} error={err("grievanceAddress")} onChange={set("grievanceAddress")} />
          <Field id="dpoName" label={`${LABELS.dpoName} (optional)`} value={draft.dpoName} error={err("dpoName")} onChange={set("dpoName")} />
        </Group>

        <Group legend="What you collect and why">
          {purposes.map((p, i) => (
            <div key={p.id} className="flex flex-col gap-4 rounded-md border border-rule bg-sheet/70 p-4">
              <Field id={`purpose-${String(i)}-name`} label={LABELS.name} hint="For example: order updates" value={p.name} error={err(`purpose-${String(i)}-name`)} onChange={setPurpose(p.id, "name")} />
              <Field id={`purpose-${String(i)}-description`} label={LABELS.description} rows={2} value={p.description} error={err(`purpose-${String(i)}-description`)} onChange={setPurpose(p.id, "description")} />
              <Field id={`purpose-${String(i)}-dataItems`} label={LABELS.dataItems} hint="For example: name, email address" value={p.dataItems} error={err(`purpose-${String(i)}-dataItems`)} onChange={setPurpose(p.id, "dataItems")} />
              <Field id={`purpose-${String(i)}-retention`} label={LABELS.retention} hint="For example: 12 months after your last order" value={p.retention} error={err(`purpose-${String(i)}-retention`)} onChange={setPurpose(p.id, "retention")} />
              {purposes.length > 1 ? (
                <button
                  type="button"
                  className="self-start text-sm font-medium text-action underline underline-offset-2"
                  onClick={() => setPurposes((list) => list.filter((x) => x.id !== p.id))}
                >
                  Remove purpose {i + 1}
                </button>
              ) : null}
            </div>
          ))}
          {purposes.length < MAX_PURPOSES ? (
            <button
              type="button"
              className="self-start rounded-md border border-action px-4 py-2 text-sm font-medium text-action hover:bg-sheet"
              onClick={() => {
                setPurposes((list) => [...list, newPurpose(nextId)]);
                setNextId((n) => n + 1);
              }}
            >
              Add another purpose
            </button>
          ) : null}
        </Group>

        <Group legend="Who else gets the data">
          <Field id="thirdParties" label={LABELS.thirdParties} value={draft.thirdParties} error={err("thirdParties")} onChange={set("thirdParties")} />
        </Group>

        <Group legend="Children">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1.5 size-5 accent-action"
              checked={draft.processesChildrenData}
              onChange={(e) => setDraft((d) => ({ ...d, processesChildrenData: e.target.checked }))}
            />
            <span>We process personal data of children under 18</span>
          </label>
        </Group>

        <Group legend="Pages your notice points to">
          <Field id="withdrawalUrl" label={LABELS.withdrawalUrl} hint="Starts with https://" type="url" value={draft.withdrawalUrl} error={err("withdrawalUrl")} onChange={set("withdrawalUrl")} />
          <Field id="rightsRequestUrl" label={LABELS.rightsRequestUrl} hint="Starts with https://" type="url" value={draft.rightsRequestUrl} error={err("rightsRequestUrl")} onChange={set("rightsRequestUrl")} />
        </Group>

        <Group legend="Language">
          <div role="radiogroup" aria-label="Notice language" className="flex flex-col gap-2">
            {(
              [
                ["en", "English"],
                ["hi", "हिन्दी (Hindi), beta"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-3">
                <input
                  type="radio"
                  name="language"
                  className="size-5 accent-action"
                  checked={language === value}
                  onChange={() => setLanguage(value)}
                />
                <span lang={value}>{label}</span>
              </label>
            ))}
          </div>
          {language === "hi" ? (
            <p className="text-sm text-ink-soft">Hindi is a beta draft, pending human review.</p>
          ) : null}
        </Group>

        <button
          type="submit"
          className="self-start rounded-md bg-action px-6 py-3 text-base font-semibold text-white"
        >
          {input === null ? "Create notice" : "Update notice"}
        </button>
      </form>

      <div className="lg:sticky lg:top-6">
        <NoticeSheet notice={notice} fingerprint={hash} copyState={copyState} onCopy={() => void copy()} />
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, type ReactNode } from "react";
import { dueLabel } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { Alert, Button } from "./ui";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col rounded border border-rule bg-sheet p-4">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-3xl font-semibold">{value}</dd>
    </div>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert>{message}</Alert>
      <Button type="button" onClick={retry}>Try again</Button>
    </div>
  );
}

const goTo = (href: string, label: string): ReactNode => (
  <Link href={href} className="inline-flex min-h-11 items-center text-action underline">{label}</Link>
);

export function Overview() {
  const { role } = useSession();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Overview</h1>
      {role === "dpo" ? <OfficerOverview /> : <AdminOverview />}
    </div>
  );
}

function OfficerOverview() {
  const { api, now } = useSession();
  const load = useCallback(() => api.listRequests({}), [api]);
  const list = useLoad(load);
  if (list.status === "loading") return <p role="status">Loading…</p>;
  if (list.status === "error") return <Failed message={list.error} retry={list.retry} />;

  const at = new Date(now());
  const tones = list.data.map((r) => dueLabel(r.dueAt, r.state, at).tone);
  const open = tones.filter((t) => t !== "done").length;
  const overdue = tones.filter((t) => t === "overdue").length;
  const soon = tones.filter((t) => t === "soon").length;
  return (
    <>
      {overdue > 0 && <Alert>{`${String(overdue)} ${overdue === 1 ? "request is" : "requests are"} overdue.`}</Alert>}
      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Open requests" value={open} />
        <Stat label="Overdue" value={overdue} />
        <Stat label="Due within 3 days" value={soon} />
      </dl>
      {goTo("/requests", "Go to requests")}
    </>
  );
}

function AdminOverview() {
  const { api } = useSession();
  const load = useCallback(() => api.listEndpoints(), [api]);
  const list = useLoad(load);
  if (list.status === "loading") return <p role="status">Loading…</p>;
  if (list.status === "error") return <Failed message={list.error} retry={list.retry} />;
  return (
    <>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active endpoints" value={list.data.filter((e) => e.disabledAt === null).length} />
      </dl>
      <p className="text-ink-soft">Rights requests are handled by your data protection officer.</p>
      {goTo("/integrations", "Go to integrations")}
    </>
  );
}

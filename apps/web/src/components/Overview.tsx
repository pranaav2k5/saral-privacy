"use client";

import Link from "next/link";
import { useCallback, type ReactNode } from "react";
import { boardLine } from "@/lib/breach-form";
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

/**
 * Breaches that the Board has not yet been told about and whose deadline has passed, or passes within a day. It loads on its own, so a
 * failure to read breaches never hides the rest of the overview, and it says nothing when there is nothing to say.
 */
function BreachAlert() {
  const { api, now } = useSession();
  const load = useCallback(() => api.listBreaches(), [api]);
  const list = useLoad(load);
  if (list.status === "loading") return null;
  if (list.status === "error") return <p className="text-ink-soft">We could not check for breaches that are due to be reported.</p>;
  const at = new Date(now());
  const tones = list.data.filter((b) => b.boardNotifiedAt === null).map((b) => boardLine(b, at).tone);
  const overdue = tones.filter((t) => t === "overdue").length;
  const soon = tones.filter((t) => t === "soon").length;
  if (overdue === 0 && soon === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {overdue > 0 && (
        <p role="status" className="rounded border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">
          {`${String(overdue)} ${overdue === 1 ? "breach that has not been reported to the Board is" : "breaches that have not been reported to the Board are"} past the deadline.`}
        </p>
      )}
      {soon > 0 && (
        <p role="status" className="rounded border border-soon-fg bg-soon-bg px-3 py-2 text-soon-fg">
          {`${String(soon)} ${soon === 1 ? "breach must" : "breaches must"} be reported to the Board within 24 hours.`}
        </p>
      )}
      {goTo("/breaches", "Go to breaches")}
    </div>
  );
}

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
      {overdue > 0 && (
        <p role="status" className="rounded border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">{`${String(overdue)} ${overdue === 1 ? "request is" : "requests are"} overdue.`}</p>
      )}
      <BreachAlert />
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
  const loadEndpoints = useCallback(() => api.listEndpoints(), [api]);
  const loadNotices = useCallback(() => api.listNotices(), [api]);
  const endpoints = useLoad(loadEndpoints);
  const notices = useLoad(loadNotices);
  const retry = () => {
    endpoints.retry();
    notices.retry();
  };
  const failed = endpoints.status === "error" ? endpoints.error : notices.status === "error" ? notices.error : null;
  if (failed !== null) return <Failed message={failed} retry={retry} />;
  if (endpoints.status !== "ready" || notices.status !== "ready") return <p role="status">Loading…</p>;
  return (
    <>
      {notices.data.length === 0 && (
        <p role="status" className="rounded border border-soon-fg bg-soon-bg px-3 py-2 text-soon-fg">No notice has been published yet. Nobody can give consent until you publish one.</p>
      )}
      <BreachAlert />
      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Published notices" value={notices.data.length} />
        <Stat label="Active endpoints" value={endpoints.data.filter((e) => e.disabledAt === null).length} />
      </dl>
      <p className="text-ink-soft">Rights requests are handled by your data protection officer.</p>
      <div className="flex flex-wrap gap-x-6">
        {goTo("/notices", "Go to notices")}
        {goTo("/integrations", "Go to integrations")}
      </div>
    </>
  );
}

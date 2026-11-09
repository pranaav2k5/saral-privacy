"use client";

import { useCallback, useRef, useState } from "react";
import type { DeliveryRecord, Endpoint, WebhookEvent } from "@/lib/api";
import { when } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useAction } from "@/lib/use-action";
import { messageOf, useLoad } from "@/lib/use-load";
import { Alert, Button, focusOnMount } from "./ui";

/** In the order the API lists them. */
const EVENTS: readonly { id: WebhookEvent; label: string }[] = [
  { id: "consent.granted", label: "Consent given" },
  { id: "consent.withdrawn", label: "Consent withdrawn" },
  { id: "dsr.submitted", label: "Request received" },
  { id: "dsr.transitioned", label: "Request status changed" },
];
const eventLabel = (id: WebhookEvent) => EVENTS.find((e) => e.id === id)?.label ?? id;

type Confirm = { id: string; kind: "rotate" | "disable" | "enable" } | null;
interface Shown {
  url: string;
  secret: string;
  rotated: boolean;
  /** When a rotation kept the old secret working, until when. */
  oldUntil?: string;
}

const secondary = "!bg-sheet !text-action border border-action";

const tries = (n: number) => `${String(n)} ${n === 1 ? "try" : "tries"}`;

/** What happened to one delivery, in words. */
function outcome(d: DeliveryRecord): string {
  if (d.state === "delivered") return `Delivered ${when(d.deliveredAt ?? d.createdAt)}`;
  if (d.state === "failed") return `Failed after ${tries(d.attempts)}`;
  if (d.attempts === 0) return "Waiting to be sent";
  return `Waiting to be tried again (${tries(d.attempts)} so far${d.nextAttemptAt ? `, next try ${when(d.nextAttemptAt)}` : ""})`;
}

/** The delivery log of one endpoint, with a way to send a failed delivery again while the endpoint is still enabled. */
function Deliveries({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const { api } = useSession();
  const load = useCallback(() => api.listDeliveries(endpoint.id), [api, endpoint.id]);
  const log = useLoad(load);
  const again = useAction<boolean>(messageOf);
  const canResend = !endpoint.disabledAt;

  async function sendAgain(d: DeliveryRecord) {
    await again.run(async () => {
      await api.redeliver(endpoint.id, d.id);
      log.refresh();
      return true;
    });
  }

  return (
    <section aria-labelledby="deliveries-h" className="flex flex-col gap-3 rounded border border-rule bg-sheet p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="deliveries-h" ref={focusOnMount} tabIndex={-1} className="break-all text-xl font-semibold">Deliveries to {endpoint.url}</h2>
        <Button type="button" className={secondary} onClick={onClose}>Close</Button>
      </div>
      {again.error && <Alert>{again.error}</Alert>}
      {again.result && <p role="status" className="rounded border border-ok-fg bg-ok-bg px-3 py-2 text-ok-fg">It is queued again and will be sent shortly.</p>}
      {log.status === "loading" && <p role="status">Loading deliveries…</p>}
      {log.status === "error" && (
        <div className="flex flex-col items-start gap-3">
          <Alert>{log.error}</Alert>
          <Button type="button" onClick={log.retry}>Try again</Button>
        </div>
      )}
      {log.status === "ready" && log.data.length === 0 && <p>Nothing has been sent to this endpoint yet.</p>}
      {log.status === "ready" && log.data.length > 0 && (
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Deliveries to {endpoint.url}, newest first</caption>
          <thead>
            <tr className="border-b border-rule text-sm text-ink-soft">
              <th scope="col" className="py-2 pr-3">Event</th>
              <th scope="col" className="py-2 pr-3">Created</th>
              <th scope="col" className="py-2 pr-3">What happened</th>
              <th scope="col" className="py-2 pr-3">Last answer</th>
              <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {log.data.map((d) => (
              <tr key={d.id} className="border-b border-rule align-top">
                <th scope="row" className="py-2 pr-3 font-normal">{eventLabel(d.eventType)}</th>
                <td className="py-2 pr-3">{when(d.createdAt)}</td>
                <td className="py-2 pr-3">{outcome(d)}</td>
                <td className="py-2 pr-3 break-all">{d.lastError ?? ""}</td>
                <td className="py-2">
                  {d.state === "failed" && canResend && (
                    <Button type="button" className={secondary} disabled={again.busy} onClick={() => void sendAgain(d)}>
                      Send again<span className="sr-only"> ({eventLabel(d.eventType)}, {when(d.createdAt)})</span>
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function IntegrationsPage() {
  const { api, now } = useSession();
  const load = useCallback(() => api.listEndpoints(), [api]);
  const list = useLoad(load);
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<readonly WebhookEvent[]>([]);
  const [confirm, setConfirmed] = useState<Confirm>(null);
  /** For a rotation: keep the old secret working for 24 hours. Forgotten whenever a question is opened or closed. */
  const [keepOld, setKeepOld] = useState(false);
  /** The question that is open now, for an action that finishes later to check it is still the one it belongs to. */
  const openNow = useRef<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const create = useAction<void>(messageOf);
  const row = useAction<void>(messageOf);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const address = url.trim();
    if (!address.startsWith("https://")) return create.fail("Enter an address that starts with https://");
    if (chosen.length === 0) return create.fail("Choose at least one event.");
    await create.run(async () => {
      const made = await api.createEndpoint(address, EVENTS.map((x) => x.id).filter((id) => chosen.includes(id)));
      // The secret exists only in `shown`, in this component's memory, until it is acknowledged. The action keeps nothing.
      setShown({ url: made.url, secret: made.secret, rotated: false });
      setUrl("");
      setChosen([]);
      list.refresh();
    });
  }

  /** Opens or closes a question about one endpoint. Any notice about an earlier action goes, and so does the choice made in a rotation. */
  function setConfirm(next: Confirm): void {
    openNow.current = next;
    setConfirmed(next);
    setKeepOld(false);
    setNotice(null);
  }

  /**
   * Closes the question an action belongs to when the action finishes, but only if that question is still the one open: the person may
   * have cancelled it while the request was out and opened another, which must not be closed (nor its choice forgotten) by a reply to
   * the earlier one.
   */
  function closeQuestion(ep: Endpoint, kind: "rotate" | "disable" | "enable"): void {
    if (openNow.current?.id === ep.id && openNow.current.kind === kind) setConfirm(null);
  }

  async function rotate(ep: Endpoint) {
    await row.run(async () => {
      const r = await api.rotateSecret(ep.id, keepOld);
      setShown({ url: ep.url, secret: r.secret, rotated: true, ...(r.previousSecretValidUntil === null ? {} : { oldUntil: r.previousSecretValidUntil }) });
      closeQuestion(ep, "rotate");
      list.refresh();
    });
  }

  async function disable(ep: Endpoint) {
    await row.run(async () => {
      await api.disableEndpoint(ep.id);
      closeQuestion(ep, "disable");
      list.refresh();
    });
  }

  async function enable(ep: Endpoint) {
    await row.run(async () => {
      await api.enableEndpoint(ep.id);
      closeQuestion(ep, "enable");
      setNotice(`${ep.url} is on again. It will be sent events from now on.`);
      list.refresh();
    });
  }

  const status = (ep: Endpoint): string => {
    if (ep.disabledAt) return ep.disabledReason === "failures" ? `Switched off ${when(ep.disabledAt)} after repeated failures` : `Disabled ${when(ep.disabledAt)}`;
    const until = ep.previousSecretUntil;
    return until && Date.parse(until) > now() ? `Active. The previous secret works until ${when(until)}.` : "Active";
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          Saral can call your systems when something happens, for example when consent is withdrawn. Each call is signed with the secret of the endpoint, so you can check it came from Saral.
        </p>
      </div>

      {shown && (
        <section key={shown.secret} aria-labelledby="secret-h" className="flex flex-col gap-2 rounded border border-soon-fg bg-soon-bg p-4 text-soon-fg">
          <h2 id="secret-h" ref={focusOnMount} tabIndex={-1} className="font-semibold">{shown.rotated ? "New signing secret" : "Signing secret"} for {shown.url}</h2>
          <p className="break-all font-mono text-lg select-all">{shown.secret}</p>
          <p>
            This secret is shown only once. Copy it into your system now.{" "}
            {!shown.rotated
              ? "It cannot be shown again."
              : shown.oldUntil === undefined
                ? "The old secret has stopped working."
                : `The old secret keeps working until ${when(shown.oldUntil)}. Switch your system to this secret before then.`}
          </p>
          <Button type="button" className="self-start" onClick={() => setShown(null)}>I have copied the secret</Button>
        </section>
      )}

      <section aria-labelledby="endpoints-h" className="flex flex-col gap-3">
        <h2 id="endpoints-h" className="text-xl font-semibold">Endpoints</h2>
        {row.error && <Alert>{row.error}</Alert>}
        {notice && <p role="status" className="rounded border border-ok-fg bg-ok-bg px-3 py-2 text-ok-fg">{notice}</p>}
        {list.status === "loading" && <p role="status">Loading endpoints…</p>}
        {list.status === "error" && (
          <div className="flex flex-col items-start gap-3">
            <Alert>{list.error}</Alert>
            <Button type="button" onClick={list.retry}>Try again</Button>
          </div>
        )}
        {list.status === "ready" && list.data.length === 0 && <p>No endpoints yet. Add one below.</p>}
        {list.status === "ready" && list.data.length > 0 && (
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Webhook endpoints</caption>
            <thead>
              <tr className="border-b border-rule text-sm text-ink-soft">
                <th scope="col" className="py-2 pr-3">Address</th>
                <th scope="col" className="py-2 pr-3">Events</th>
                <th scope="col" className="py-2 pr-3">Status</th>
                <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((ep) => (
                <tr key={ep.id} className="border-b border-rule align-top">
                  <th scope="row" className="break-all py-2 pr-3 font-normal">{ep.url}</th>
                  <td className="py-2 pr-3">{ep.events.map(eventLabel).join(", ")}</td>
                  <td className="py-2 pr-3">{status(ep)}</td>
                  <td className="py-2">
                    {confirm?.id !== ep.id && (
                      <div className="flex flex-wrap gap-2">
                        {!ep.disabledAt && (
                          <>
                            <Button type="button" className={secondary} onClick={() => setConfirm({ id: ep.id, kind: "rotate" })}>
                              Rotate secret<span className="sr-only"> for {ep.url}</span>
                            </Button>
                            <Button type="button" className={secondary} onClick={() => setConfirm({ id: ep.id, kind: "disable" })}>
                              Disable<span className="sr-only"> {ep.url}</span>
                            </Button>
                          </>
                        )}
                        {ep.disabledAt && (
                          <Button type="button" className={secondary} onClick={() => setConfirm({ id: ep.id, kind: "enable" })}>
                            Switch on<span className="sr-only"> {ep.url}</span>
                          </Button>
                        )}
                        <Button type="button" className={secondary} onClick={() => setViewing(ep.id)}>
                          Deliveries<span className="sr-only"> for {ep.url}</span>
                        </Button>
                      </div>
                    )}
                    {confirm?.id === ep.id && (
                      <div className="flex flex-col gap-2">
                        {confirm.kind === "rotate" && (
                          <label className="flex min-h-11 items-center gap-2">
                            <input type="checkbox" className="size-5" checked={keepOld} onChange={(e) => setKeepOld(e.target.checked)} />
                            Keep the old secret working for 24 hours
                          </label>
                        )}
                        <p>
                          {confirm.kind === "rotate"
                            ? keepOld
                              ? "A new secret is made. The old secret keeps working for 24 hours, then stops, so you can switch your system over. Use this only if the old secret has not leaked."
                              : "A new secret is made and the old secret stops working at once. Choose this if the old secret may have leaked."
                            : confirm.kind === "enable"
                              ? "Saral will send events to this address again, signed with the secret it had before. The address is checked again first."
                              : "Nothing more is sent to this endpoint until you switch it on again."}
                        </p>
                        <div className="flex gap-2">
                          <Button type="button" ref={focusOnMount} disabled={row.busy} onClick={() => void (confirm.kind === "rotate" ? rotate(ep) : confirm.kind === "enable" ? enable(ep) : disable(ep))}>
                            {confirm.kind === "rotate" ? "Yes, rotate" : confirm.kind === "enable" ? "Yes, switch on" : "Yes, disable"}
                          </Button>
                          <Button type="button" className={secondary} onClick={() => setConfirm(null)}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {list.status === "ready" && viewing !== null && list.data.some((e) => e.id === viewing) && (
        <Deliveries key={viewing} endpoint={list.data.find((e) => e.id === viewing) as Endpoint} onClose={() => setViewing(null)} />
      )}

      <section aria-labelledby="add-h" className="flex flex-col gap-3 rounded border border-rule bg-sheet p-4">
        <h2 id="add-h" className="text-xl font-semibold">Add an endpoint</h2>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="endpoint-url" className="font-medium">Address (https)</label>
            <input id="endpoint-url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} className="min-h-11 rounded border border-field bg-sheet px-3" />
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="font-medium">Send me</legend>
            {EVENTS.map((ev) => (
              <label key={ev.id} className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={chosen.includes(ev.id)}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, ev.id] : c.filter((x) => x !== ev.id)))}
                />
                {ev.label}
              </label>
            ))}
          </fieldset>
          {create.error && <Alert>{create.error}</Alert>}
          <Button type="submit" className="self-start" disabled={create.busy}>{create.busy ? "Adding…" : "Add endpoint"}</Button>
        </form>
      </section>
    </div>
  );
}

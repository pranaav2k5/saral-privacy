"use client";

import { useCallback, useState } from "react";
import type { Endpoint, WebhookEvent } from "@/lib/api";
import { when } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useAction } from "@/lib/use-action";
import { messageOf, useLoad } from "@/lib/use-load";
import { Alert, Button } from "./ui";

/** In the order the API lists them. */
const EVENTS: readonly { id: WebhookEvent; label: string }[] = [
  { id: "consent.granted", label: "Consent given" },
  { id: "consent.withdrawn", label: "Consent withdrawn" },
  { id: "dsr.submitted", label: "Request received" },
  { id: "dsr.transitioned", label: "Request status changed" },
];
const eventLabel = (id: WebhookEvent) => EVENTS.find((e) => e.id === id)?.label ?? id;

type Confirm = { id: string; kind: "rotate" | "disable" } | null;
interface Shown {
  url: string;
  secret: string;
  rotated: boolean;
}

const secondary = "!bg-sheet !text-action border border-action";

export function IntegrationsPage() {
  const { api } = useSession();
  const load = useCallback(() => api.listEndpoints(), [api]);
  const list = useLoad(load);
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<readonly WebhookEvent[]>([]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const create = useAction<Endpoint>(messageOf);
  const row = useAction<void>(messageOf);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const address = url.trim();
    if (!address.startsWith("https://")) return create.fail("Enter an address that starts with https://");
    if (chosen.length === 0) return create.fail("Choose at least one event.");
    const made = await create.run(() => api.createEndpoint(address, EVENTS.map((x) => x.id).filter((id) => chosen.includes(id))));
    if (made) {
      // The secret exists only in this component's memory. It is not stored, and the server cannot show it again.
      setShown({ url: made.url, secret: (made as Endpoint & { secret: string }).secret, rotated: false });
      setUrl("");
      setChosen([]);
      list.refresh();
    }
  }

  async function rotate(ep: Endpoint) {
    await row.run(async () => {
      const r = await api.rotateSecret(ep.id);
      setShown({ url: ep.url, secret: r.secret, rotated: true });
      setConfirm(null);
    });
  }

  async function disable(ep: Endpoint) {
    await row.run(async () => {
      await api.disableEndpoint(ep.id);
      setConfirm(null);
      list.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="mt-2 max-w-prose text-ink-soft">
          Saral can call your systems when something happens, for example when consent is withdrawn. Each call is signed with the secret of the endpoint, so you can check it came from Saral.
        </p>
      </div>

      {shown && (
        <section aria-labelledby="secret-h" className="flex flex-col gap-2 rounded border border-soon-fg bg-soon-bg p-4 text-soon-fg">
          <h2 id="secret-h" className="font-semibold">{shown.rotated ? "New signing secret" : "Signing secret"} for {shown.url}</h2>
          <p className="break-all font-mono text-lg select-all">{shown.secret}</p>
          <p>This secret is shown only once. Copy it into your system now. {shown.rotated ? "The old secret has stopped working." : "It cannot be shown again."}</p>
          <Button type="button" className="self-start" onClick={() => setShown(null)}>I have copied the secret</Button>
        </section>
      )}

      <section aria-labelledby="endpoints-h" className="flex flex-col gap-3">
        <h2 id="endpoints-h" className="text-xl font-semibold">Endpoints</h2>
        {row.error && <Alert>{row.error}</Alert>}
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
                  <td className="py-2 pr-3">{ep.disabledAt ? `Disabled ${when(ep.disabledAt)}` : "Active"}</td>
                  <td className="py-2">
                    {!ep.disabledAt && confirm?.id !== ep.id && (
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" className={secondary} onClick={() => setConfirm({ id: ep.id, kind: "rotate" })}>
                          Rotate secret<span className="sr-only"> for {ep.url}</span>
                        </Button>
                        <Button type="button" className={secondary} onClick={() => setConfirm({ id: ep.id, kind: "disable" })}>
                          Disable<span className="sr-only"> {ep.url}</span>
                        </Button>
                      </div>
                    )}
                    {confirm?.id === ep.id && (
                      <div className="flex flex-col gap-2">
                        <p>
                          {confirm.kind === "rotate"
                            ? "A new secret is made and the old secret stops working at once."
                            : "Nothing more is sent to this endpoint. This cannot be undone."}
                        </p>
                        <div className="flex gap-2">
                          <Button type="button" disabled={row.busy} onClick={() => void (confirm.kind === "rotate" ? rotate(ep) : disable(ep))}>
                            {confirm.kind === "rotate" ? "Yes, rotate" : "Yes, disable"}
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

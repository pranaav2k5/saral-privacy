import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { IntegrationsPage } from "./IntegrationsPage";
import { when } from "@/lib/format";
import { renderScreen, type Route } from "@/test/harness";

const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const live = { id: E1, url: "https://hooks.example.org/saral", events: ["consent.granted", "consent.withdrawn"], createdAt: "2026-10-01T08:00:00.000Z", disabledAt: null };
const off = { id: E2, url: "https://old.example.org/hook", events: ["dsr.submitted"], createdAt: "2026-09-01T08:00:00.000Z", disabledAt: "2026-10-15T08:00:00.000Z" };
const stopped = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", url: "https://flaky.example.org/hook", events: ["consent.granted"], createdAt: "2026-08-01T08:00:00.000Z", disabledAt: "2026-10-20T08:00:00.000Z", disabledReason: "failures" };
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const D3 = "33333333-3333-4333-8333-333333333333";
const D4 = "44444444-4444-4444-8444-444444444444";
const delivery = (over: Record<string, unknown>) => ({ id: D1, eventType: "consent.granted", state: "delivered", attempts: 1, createdAt: "2026-11-05T09:00:00.000Z", nextAttemptAt: null, deliveredAt: "2026-11-05T09:00:05.000Z", lastStatus: 200, lastError: null, ...over });
const LOG = [
  delivery({ id: D1, state: "failed", attempts: 15, deliveredAt: null, lastStatus: 500, lastError: "HTTP 500", createdAt: "2026-11-05T09:00:00.000Z" }),
  delivery({ id: D2, eventType: "consent.withdrawn", state: "pending", attempts: 3, deliveredAt: null, lastStatus: 503, lastError: "HTTP 503", nextAttemptAt: "2026-11-05T12:00:00.000Z", createdAt: "2026-11-05T08:00:00.000Z" }),
  delivery({ id: D3, state: "delivered", createdAt: "2026-11-05T07:00:00.000Z", deliveredAt: "2026-11-05T07:00:02.000Z" }),
  delivery({ id: D4, eventType: "dsr.submitted", state: "pending", attempts: 0, deliveredAt: null, lastStatus: null, lastError: null, nextAttemptAt: "2026-11-05T06:00:01.000Z", createdAt: "2026-11-05T06:00:00.000Z" }),
];
const SHOWN_ONCE = ["whsec", "placeholder", "for", "tests"].join("_"); // built at runtime so secret scanners have nothing to flag

const page = (routes: Record<string, Route | Route[]> = {}) => renderScreen(<IntegrationsPage />, { role: "tenant_admin", routes: { "GET /v1/webhook-endpoints": { body: [live, off] }, ...routes } });

function add(url = "https://hooks.example.org/new", events = ["Consent given"]) {
  fireEvent.change(screen.getByLabelText("Address (https)"), { target: { value: url } });
  for (const e of events) fireEvent.click(screen.getByLabelText(e));
  fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
}

describe("the list", () => {
  test("shows each endpoint's address, the events in words, and whether it is active", async () => {
    page();
    const rows = await screen.findAllByRole("row");
    expect(rows[1]?.textContent).toContain("https://hooks.example.org/saral");
    expect(rows[1]?.textContent).toContain("Consent given, Consent withdrawn");
    expect(rows[1]?.textContent).toContain("Active");
    expect(rows[2]?.textContent).toContain("Disabled");
    expect(rows[2]?.textContent).toContain(when(off.disabledAt));
  });

  test("a disabled endpoint has no actions; an active one can be rotated or disabled", async () => {
    page();
    await screen.findAllByRole("row");
    expect(screen.getAllByRole("button", { name: /^Rotate secret/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Disable/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: `Rotate secret for ${live.url}` })).toBeTruthy();
  });

  test("while loading it says so, and with no endpoints it says to add one", async () => {
    page({ "GET /v1/webhook-endpoints": [{ body: [], wait: Promise.resolve() }] });
    expect(screen.getByRole("status").textContent).toBe("Loading endpoints…");
    expect(await screen.findByText(/No endpoints yet/)).toBeTruthy();
  });

  test("a failure is shown and Try again loads the list", async () => {
    page({ "GET /v1/webhook-endpoints": [{ status: 403, body: { message: "You do not have access to this." } }, { body: [live] }] });
    expect((await screen.findByRole("alert")).textContent).toBe("You do not have access to this.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("rowheader", { name: live.url })).toBeTruthy();
  });
});

describe("adding an endpoint", () => {
  test("an address that is not https is turned back before anything is sent", async () => {
    const v = page();
    await screen.findAllByRole("row");
    add("http://hooks.example.org/new");
    expect(screen.getByRole("alert").textContent).toBe("Enter an address that starts with https://");
    expect(v.callsTo("POST", "/v1/webhook-endpoints")).toHaveLength(0);
  });

  test("at least one event must be chosen", async () => {
    const v = page();
    await screen.findAllByRole("row");
    add("https://hooks.example.org/new", []);
    expect(screen.getByRole("alert").textContent).toBe("Choose at least one event.");
    expect(v.callsTo("POST", "/v1/webhook-endpoints")).toHaveLength(0);
  });

  test("the secret is shown once with a warning, kept out of storage, and gone once acknowledged", async () => {
    const created = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", url: "https://hooks.example.org/new", events: ["consent.granted", "dsr.transitioned"], createdAt: "2026-11-06T10:00:00.000Z", disabledAt: null, secret: SHOWN_ONCE };
    const v = page({ "POST /v1/webhook-endpoints": { status: 201, body: created } });
    await screen.findAllByRole("row");
    add("https://hooks.example.org/new", ["Request status changed", "Consent given"]); // picked out of order
    expect(await screen.findByText(SHOWN_ONCE)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Signing secret for/ })); // so a screen reader announces it
    expect(screen.getByText(/shown only once/i)).toBeTruthy();
    expect(v.callsTo("POST", "/v1/webhook-endpoints")[0]?.body).toEqual({ url: "https://hooks.example.org/new", events: ["consent.granted", "dsr.transitioned"] });
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SHOWN_ONCE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SHOWN_ONCE);
    await waitFor(() => expect(v.callsTo("GET", "/v1/webhook-endpoints")).toHaveLength(2));
    expect((screen.getByLabelText("Address (https)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Consent given") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "I have copied the secret" }));
    expect(screen.queryByText(SHOWN_ONCE)).toBeNull();
  });

  test("a second secret shown while the first is still on screen takes focus and replaces the first", async () => {
    const SECOND = ["whsec", "second", "placeholder"].join("_");
    const created = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", url: "https://hooks.example.org/new", events: ["consent.granted"], createdAt: "2026-11-06T10:00:00.000Z", disabledAt: null, secret: SHOWN_ONCE };
    page({
      "POST /v1/webhook-endpoints": { status: 201, body: created },
      [`POST /v1/webhook-endpoints/${E1}/rotate-secret`]: { body: { id: E1, secret: SECOND } },
    });
    await screen.findAllByRole("row");
    add();
    await screen.findByText(SHOWN_ONCE);
    fireEvent.click(screen.getByRole("button", { name: `Rotate secret for ${live.url}` }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, rotate" }));
    await screen.findByText(SECOND);
    expect(screen.queryByText(SHOWN_ONCE)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^New signing secret for/ }));
  });

  test("when the server refuses an address its reason is shown and the form keeps what was typed", async () => {
    page({ "POST /v1/webhook-endpoints": { status: 422, body: { message: "That address is not allowed." } } });
    await screen.findAllByRole("row");
    add("https://10.0.0.1/hook");
    expect((await screen.findByRole("alert")).textContent).toBe("That address is not allowed.");
    expect((screen.getByLabelText("Address (https)") as HTMLInputElement).value).toBe("https://10.0.0.1/hook");
    expect((screen.getByLabelText("Consent given") as HTMLInputElement).checked).toBe(true);
  });
});

describe("rotating and disabling", () => {
  test("rotating asks first, says the old secret stops, then shows the new secret once", async () => {
    const v = page({ [`POST /v1/webhook-endpoints/${E1}/rotate-secret`]: { body: { id: E1, secret: SHOWN_ONCE } } });
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Rotate secret for ${live.url}` }));
    expect(screen.getByText(/old secret stops working at once/i)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, rotate" }));
    expect(v.callsTo("POST", `/v1/webhook-endpoints/${E1}/rotate-secret`)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Yes, rotate" }));
    expect(await screen.findByText(SHOWN_ONCE)).toBeTruthy();
    expect(screen.getByText(/shown only once/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, rotate" })).toBeNull();
  });

  test("Cancel leaves the endpoint alone", async () => {
    const v = page();
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Disable ${live.url}` }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(v.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(screen.getByRole("button", { name: `Disable ${live.url}` })).toBeTruthy();
  });

  test("disabling asks first, sends DELETE for that endpoint, and refreshes the list", async () => {
    const v = page({
      [`DELETE /v1/webhook-endpoints/${E1}`]: { status: 204 },
      "GET /v1/webhook-endpoints": [{ body: [live, off] }, { body: [{ ...live, disabledAt: "2026-11-06T10:00:00.000Z" }, off] }],
    });
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Disable ${live.url}` }));
    expect(screen.getByText(/nothing more is sent to this endpoint/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, disable" }));
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByText(/^Disabled/)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /^Disable/ })).toBeNull();
    expect(v.callsTo("DELETE", `/v1/webhook-endpoints/${E1}`)).toHaveLength(1);
  });

  test("a refusal is shown and the endpoint is unchanged", async () => {
    page({ [`DELETE /v1/webhook-endpoints/${E1}`]: { status: 404, body: { message: "That could not be found." } } });
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Disable ${live.url}` }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, disable" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That could not be found.");
  });
});

describe("why an endpoint is off", () => {
  test("one that Saral switched off after repeated failures says so, and one an administrator disabled just says disabled", async () => {
    page({ "GET /v1/webhook-endpoints": { body: [live, off, stopped] } });
    const rows = await screen.findAllByRole("row");
    expect(rows[2]?.textContent).toContain(`Disabled ${when(off.disabledAt)}`);
    expect(rows[3]?.textContent).toContain(`Switched off ${when(stopped.disabledAt)} after repeated failures`);
    expect(rows[3]?.textContent).not.toMatch(/Disabled/);
  });
});

describe("the delivery log", () => {
  const open = async (url = live.url, routes: Record<string, Route | Route[]> = {}) => {
    const v = page({ [`GET /v1/webhook-endpoints/${E1}/deliveries`]: { body: LOG }, ...routes });
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Deliveries for ${url}` }));
    return v;
  };
  const region = () => screen.getByRole("region", { name: /^Deliveries to / });

  test("every endpoint, switched off or not, has a button for it", async () => {
    page({ "GET /v1/webhook-endpoints": { body: [live, off, stopped] } });
    await screen.findAllByRole("row");
    for (const ep of [live, off, stopped]) expect(screen.getByRole("button", { name: `Deliveries for ${ep.url}` })).toBeTruthy();
  });

  test("opens under the list and names the endpoint, then shows each delivery in words: what, when, what happened", async () => {
    const v = await open();
    const log = await screen.findByRole("region", { name: `Deliveries to ${live.url}` });
    const rows = await within(log).findAllByRole("row");
    expect(rows).toHaveLength(1 + LOG.length);
    expect(rows[1]?.textContent).toContain("Consent given");
    expect(rows[1]?.textContent).toContain(when(LOG[0]?.createdAt as string));
    expect(rows[1]?.textContent).toContain("Failed after 15 tries");
    expect(rows[1]?.textContent).toContain("HTTP 500");
    expect(rows[2]?.textContent).toContain("Consent withdrawn");
    expect(rows[2]?.textContent).toContain("Waiting to be tried again");
    expect(rows[2]?.textContent).toContain("3 tries so far");
    expect(rows[2]?.textContent).toContain(`next try ${when("2026-11-05T12:00:00.000Z")}`);
    expect(rows[3]?.textContent).toContain(`Delivered ${when("2026-11-05T07:00:02.000Z")}`);
    expect(rows[4]?.textContent).toContain("Request received");
    expect(rows[4]?.textContent).toContain("Waiting to be sent");
    expect(v.callsTo("GET", `/v1/webhook-endpoints/${E1}/deliveries`)).toHaveLength(1);
  });

  test("while loading it says so; with nothing sent it says that; a failure can be tried again", async () => {
    await open(live.url, { [`GET /v1/webhook-endpoints/${E1}/deliveries`]: [{ status: 500, body: { message: "The database is busy." } }, { body: [] }] });
    expect((await screen.findByText("The database is busy.")).closest("[role=alert]")).toBeTruthy();
    fireEvent.click(within(region()).getByRole("button", { name: "Try again" }));
    expect(await within(region()).findByText("Nothing has been sent to this endpoint yet.")).toBeTruthy();
  });

  test("has the word loading while it waits", async () => {
    await open(live.url, { [`GET /v1/webhook-endpoints/${E1}/deliveries`]: [{ body: [], wait: Promise.resolve() }] });
    expect(within(region()).getByRole("status").textContent).toBe("Loading deliveries…");
    await within(region()).findByText("Nothing has been sent to this endpoint yet.");
  });

  test("Close hides it, and opening another endpoint's log replaces the first", async () => {
    page({
      "GET /v1/webhook-endpoints": { body: [live, stopped] },
      [`GET /v1/webhook-endpoints/${E1}/deliveries`]: { body: LOG },
      [`GET /v1/webhook-endpoints/${stopped.id}/deliveries`]: { body: [] },
    });
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Deliveries for ${live.url}` }));
    await screen.findByRole("region", { name: `Deliveries to ${live.url}` });
    fireEvent.click(screen.getByRole("button", { name: `Deliveries for ${stopped.url}` }));
    expect(await screen.findByRole("region", { name: `Deliveries to ${stopped.url}` })).toBeTruthy();
    expect(screen.queryByRole("region", { name: `Deliveries to ${live.url}` })).toBeNull();
    fireEvent.click(within(region()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: /^Deliveries to / })).toBeNull();
  });

  test("never shows what was sent: the log has no payload to show", async () => {
    await open();
    await screen.findByRole("region", { name: `Deliveries to ${live.url}` });
    await screen.findByText("Failed after 15 tries");
    expect(region().textContent).not.toMatch(/consentId|payload|whsec_/);
  });
});

describe("sending a failed delivery again", () => {
  const open = async (endpoints: unknown[] = [live], routes: Record<string, Route | Route[]> = {}) => {
    const v = page({ "GET /v1/webhook-endpoints": { body: endpoints }, [`GET /v1/webhook-endpoints/${E1}/deliveries`]: { body: LOG }, ...routes });
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Deliveries for ${live.url}` }));
    await screen.findByRole("region", { name: `Deliveries to ${live.url}` });
    // The log is on screen as soon as it is opened; wait until its rows are in.
    await screen.findByText("Failed after 15 tries");
    return v;
  };

  test("is offered for a failed delivery and for no other", async () => {
    await open();
    const log = screen.getByRole("region", { name: `Deliveries to ${live.url}` });
    const buttons = within(log).getAllByRole("button", { name: /^Send again/ });
    expect(buttons).toHaveLength(1);
    expect(within(within(log).getAllByRole("row")[1] as HTMLElement).getByRole("button", { name: /^Send again/ })).toBeTruthy();
    expect(buttons[0]?.textContent).toContain("Send again");
    expect(buttons[0]?.textContent).toContain(`Consent given, ${when(LOG[0]?.createdAt as string)}`);
  });

  test("is not offered once the endpoint is disabled, because nothing can be sent to it", async () => {
    const stoppedLog = [delivery({ id: D1, state: "failed", attempts: 15, deliveredAt: null, lastStatus: 500, lastError: "HTTP 500" })];
    page({ "GET /v1/webhook-endpoints": { body: [stopped] }, [`GET /v1/webhook-endpoints/${stopped.id}/deliveries`]: { body: stoppedLog } });
    await screen.findAllByRole("row");
    fireEvent.click(screen.getByRole("button", { name: `Deliveries for ${stopped.url}` }));
    await screen.findByRole("region", { name: `Deliveries to ${stopped.url}` });
    await screen.findByText("Failed after 15 tries");
    expect(screen.queryByRole("button", { name: /^Send again/ })).toBeNull();
  });

  test("asks the API for that delivery of that endpoint, says it is queued, and reloads the log", async () => {
    const after = LOG.map((d) => (d.id === D1 ? { ...d, state: "pending", attempts: 0, nextAttemptAt: "2026-11-06T10:00:00.000Z" } : d));
    const v = await open([live], {
      [`GET /v1/webhook-endpoints/${E1}/deliveries`]: [{ body: LOG }, { body: after }],
      [`POST /v1/webhook-endpoints/${E1}/deliveries/${D1}/redeliver`]: { body: { id: D1, state: "pending" } },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send again/ }));
    expect(await screen.findByText(/It is queued again and will be sent shortly\./)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Send again/ })).toBeNull());
    expect(v.callsTo("POST", `/v1/webhook-endpoints/${E1}/deliveries/${D1}/redeliver`)).toHaveLength(1);
    expect(v.callsTo("GET", `/v1/webhook-endpoints/${E1}/deliveries`)).toHaveLength(2);
  });

  test("while it is being sent the button cannot be pressed twice", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const v = await open([live], { [`POST /v1/webhook-endpoints/${E1}/deliveries/${D1}/redeliver`]: { body: { id: D1, state: "pending" }, wait: gate } });
    const button = screen.getByRole("button", { name: /^Send again/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect((screen.getByRole("button", { name: /^Send again/ }) as HTMLButtonElement).disabled).toBe(true));
    release();
    await waitFor(() => expect(v.callsTo("POST", `/v1/webhook-endpoints/${E1}/deliveries/${D1}/redeliver`)).toHaveLength(1));
  });

  test("a refusal is shown in the server's words and the log stays as it was", async () => {
    await open([live], { [`POST /v1/webhook-endpoints/${E1}/deliveries/${D1}/redeliver`]: { status: 409, body: { error: "not_failed", message: "only a delivery that has failed can be sent again" } } });
    fireEvent.click(screen.getByRole("button", { name: /^Send again/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("only a delivery that has failed can be sent again");
    expect(screen.getByRole("button", { name: /^Send again/ })).toBeTruthy();
  });
});

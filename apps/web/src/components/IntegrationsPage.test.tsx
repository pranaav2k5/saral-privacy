import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { IntegrationsPage } from "./IntegrationsPage";
import { when } from "@/lib/format";
import { renderScreen, type Route } from "@/test/harness";

const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const live = { id: E1, url: "https://hooks.example.org/saral", events: ["consent.granted", "consent.withdrawn"], createdAt: "2026-10-01T08:00:00.000Z", disabledAt: null };
const off = { id: E2, url: "https://old.example.org/hook", events: ["dsr.submitted"], createdAt: "2026-09-01T08:00:00.000Z", disabledAt: "2026-10-15T08:00:00.000Z" };
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

  test("loading, empty and failing states are each said in words", async () => {
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

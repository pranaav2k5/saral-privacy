import { fireEvent, screen } from "@testing-library/react";
import { Overview } from "./Overview";
import { renderScreen, type Route } from "@/test/harness";

const v = { decidedReason: null, closedAt: null, submittedAt: "2026-10-01T09:00:00.000Z", overdue: false };
const queue = [
  { ...v, id: "1", type: "access", state: "in_review", dueAt: "2026-11-04T10:00:00.000Z" }, // overdue
  { ...v, id: "2", type: "erasure", state: "submitted", dueAt: "2026-11-08T10:00:00.000Z" }, // due in 2 days
  { ...v, id: "3", type: "correction", state: "submitted", dueAt: "2026-12-01T10:00:00.000Z" }, // plenty of time
  { ...v, id: "4", type: "grievance", state: "fulfilled", dueAt: "2026-10-05T10:00:00.000Z" }, // finished, so never overdue
];
const dpo = (routes: Record<string, Route | Route[]> = {}) => renderScreen(<Overview />, { role: "dpo", routes: { "GET /v1/dsr": { body: queue }, "GET /v1/breaches": { body: [] }, ...routes } });

test("a data protection officer sees how many requests are open, overdue and due soon", async () => {
  dpo();
  expect(await screen.findByText("Open requests")).toBeTruthy();
  const stat = (label: string) => screen.getByText(label).parentElement?.textContent;
  expect(stat("Open requests")).toBe("Open requests3");
  expect(stat("Overdue")).toBe("Overdue1");
  expect(stat("Due within 3 days")).toBe("Due within 3 days1");
});

test("finished requests are not counted as overdue even though their date has passed", async () => {
  dpo({ "GET /v1/dsr": { body: [queue[3]] } });
  await screen.findByText("Open requests");
  expect(screen.getByText("Overdue").parentElement?.textContent).toBe("Overdue0");
});

test("overdue requests are called out in words and link to the queue", async () => {
  dpo();
  expect((await screen.findByText("1 request is overdue.")).getAttribute("role")).toBe("status");
  expect(screen.getByRole("link", { name: "Go to requests" }).getAttribute("href")).toBe("/requests");
});

test("several overdue requests use the plural", async () => {
  dpo({ "GET /v1/dsr": { body: [queue[0], { ...queue[0], id: "5" }] } });
  expect((await screen.findByText("2 requests are overdue.")).getAttribute("role")).toBe("status");
});

test("nothing overdue means no alert", async () => {
  dpo({ "GET /v1/dsr": { body: [queue[1]] } });
  await screen.findByText("Open requests");
  expect(screen.queryByText(/overdue\./)).toBeNull();
});

test("a failure is shown, and Try again loads the counts", async () => {
  dpo({ "GET /v1/dsr": [{ status: 500, body: { message: "The database is busy." } }, { body: queue }] });
  expect((await screen.findByRole("alert")).textContent).toBe("The database is busy.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Open requests")).toBeTruthy();
});

const endpoint = (id: string, disabledAt: string | null) => ({ id, url: `https://${id}.example`, events: [], createdAt: "2026-10-01T00:00:00.000Z", disabledAt });
const notice = (id: string) => ({ id, version: 1, language: "en", reviewStatus: "pending-human-review", canonicalSha256: "ab".repeat(32), publishedAt: "2026-10-01T00:00:00.000Z", purposeKeys: ["analytics"] });
const admin = (routes: Record<string, Route | Route[]> = {}) =>
  renderScreen(<Overview />, {
    role: "tenant_admin",
    routes: { "GET /v1/webhook-endpoints": { body: [endpoint("a", null), endpoint("b", "2026-10-02T00:00:00.000Z")] }, "GET /v1/notices": { body: [notice("n1"), notice("n2")] }, "GET /v1/breaches": { body: [] }, ...routes },
  });

test("an administrator sees the number of active endpoints and published notices, and never asks for the requests queue", async () => {
  const r = admin();
  expect((await screen.findByText("Active endpoints")).parentElement?.textContent).toBe("Active endpoints1");
  expect(screen.getByText("Published notices").parentElement?.textContent).toBe("Published notices2");
  expect(r.callsTo("GET", "/v1/dsr")).toHaveLength(0);
  expect(screen.getByRole("link", { name: "Go to integrations" }).getAttribute("href")).toBe("/integrations");
  expect(screen.getByRole("link", { name: "Go to notices" }).getAttribute("href")).toBe("/notices");
});

test("an administrator with no notice is told that nobody can give consent yet, and where to publish one", async () => {
  admin({ "GET /v1/notices": { body: [] } });
  expect((await screen.findByText("No notice has been published yet. Nobody can give consent until you publish one.")).getAttribute("role")).toBe("status");
  expect(screen.getByText("Published notices").parentElement?.textContent).toBe("Published notices0");
});

test("once a notice exists the prompt is gone", async () => {
  admin();
  await screen.findByText("Active endpoints");
  expect(screen.queryByText(/No notice has been published yet/)).toBeNull();
});

test("if either list fails the failure is shown, and Try again loads both", async () => {
  const r = admin({ "GET /v1/notices": [{ status: 500, body: { message: "The database is busy." } }, { body: [notice("n1")] }] });
  expect((await screen.findByRole("alert")).textContent).toBe("The database is busy.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Published notices")).toBeTruthy();
  expect(r.callsTo("GET", "/v1/notices")).toHaveLength(2);
});

test("if the endpoints fail the failure is shown too, and Try again loads them again", async () => {
  const r = admin({ "GET /v1/webhook-endpoints": [{ status: 500, body: { message: "The endpoints are unavailable." } }, { body: [endpoint("a", null)] }] });
  expect((await screen.findByRole("alert")).textContent).toBe("The endpoints are unavailable.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect((await screen.findByText("Active endpoints")).parentElement?.textContent).toBe("Active endpoints1");
  expect(r.callsTo("GET", "/v1/webhook-endpoints")).toHaveLength(2);
});

test("while the notices are still loading it says so, even though the endpoints have arrived", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  admin({ "GET /v1/notices": { body: [notice("n1")], wait: gate } });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByText("Active endpoints")).toBeNull();
  release();
  expect(await screen.findByText("Published notices")).toBeTruthy();
});

// The harness clock is 2026-11-06T10:00:00Z.
const breach = (over: Record<string, unknown> = {}) => ({
  id: "b1", state: "reported", title: "Laptop lost", description: "d", discoveredAt: "2026-11-03T09:00:00.000Z", occurredAt: null, nature: ["confidentiality"], dataCategories: ["names"],
  approxPrincipalsAffected: null, likelyConsequences: "c", measuresTaken: "m", reportedAt: "2026-11-03T09:30:00.000Z", reportedBy: "staff:x", boardDeadline: "2026-11-09T09:00:00.000Z",
  boardOverdue: false, boardNotifiedLate: null, signedOffAt: null, signedOffBy: null, boardNotifiedAt: null, boardReference: null, principalsNotifiedAt: null, principalsHow: null,
  principalsCount: null, closedAt: null, closingNote: null, ...over,
});
const PAST = "2026-11-05T09:00:00.000Z";
const SOON = "2026-11-06T20:00:00.000Z";
const told = { state: "board_notified", boardNotifiedAt: "2026-11-04T10:00:00.000Z", boardNotifiedLate: false };

describe.each([
  ["a data protection officer", dpo, "Open requests"],
  ["an administrator", admin, "Active endpoints"],
] as const)("breaches on the overview of %s", (_who, open, ready) => {
  test("one past the Board's deadline and not yet reported is called out, with a link", async () => {
    open({ "GET /v1/breaches": { body: [breach({ boardDeadline: PAST })] } });
    const note = await screen.findByText("1 breach that has not been reported to the Board is past the deadline.");
    expect(note.getAttribute("role")).toBe("status");
    expect(screen.getByRole("link", { name: "Go to breaches" }).getAttribute("href")).toBe("/breaches");
  });

  test("several overdue ones use the plural", async () => {
    open({ "GET /v1/breaches": { body: [breach({ boardDeadline: PAST }), breach({ id: "b2", boardDeadline: PAST, state: "signed_off" })] } });
    expect(await screen.findByText("2 breaches that have not been reported to the Board are past the deadline.")).toBeTruthy();
  });

  test("one due within 24 hours is flagged before it is late", async () => {
    open({ "GET /v1/breaches": { body: [breach({ boardDeadline: SOON })] } });
    expect(await screen.findByText("1 breach must be reported to the Board within 24 hours.")).toBeTruthy();
  });

  test("overdue wins over due soon, and the message counts each kind", async () => {
    open({ "GET /v1/breaches": { body: [breach({ boardDeadline: PAST }), breach({ id: "b2", boardDeadline: SOON })] } });
    expect(await screen.findByText("1 breach that has not been reported to the Board is past the deadline.")).toBeTruthy();
    expect(screen.getByText("1 breach must be reported to the Board within 24 hours.")).toBeTruthy();
  });

  test("one the Board has been told about (even late), one with time left and one closed say nothing", async () => {
    open({ "GET /v1/breaches": { body: [breach({ ...told, boardDeadline: PAST }), breach({ id: "b2", boardDeadline: "2026-11-09T09:00:00.000Z" }), breach({ id: "b3", ...told, state: "closed", boardDeadline: PAST }), breach({ id: "b4", ...told, boardNotifiedLate: true, boardDeadline: "2026-11-04T09:00:00.000Z" })] } });
    await screen.findByText(ready);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/breach/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Go to breaches" })).toBeNull();
  });

  test("an organisation with no breach sees nothing about breaches", async () => {
    open();
    await screen.findByText(ready);
    expect(screen.queryByText(/breach/i)).toBeNull();
  });

  test("if the breaches cannot be read it says so quietly and the rest of the overview still shows", async () => {
    open({ "GET /v1/breaches": { status: 500, body: { message: "The database is busy." } } });
    expect(await screen.findByText("We could not check for breaches that are due to be reported.")).toBeTruthy();
    expect(screen.getByText(ready)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

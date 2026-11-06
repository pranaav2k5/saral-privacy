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
const dpo = (routes: Record<string, Route | Route[]> = {}) => renderScreen(<Overview />, { role: "dpo", routes: { "GET /v1/dsr": { body: queue }, ...routes } });

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
    routes: { "GET /v1/webhook-endpoints": { body: [endpoint("a", null), endpoint("b", "2026-10-02T00:00:00.000Z")] }, "GET /v1/notices": { body: [notice("n1"), notice("n2")] }, ...routes },
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

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
  expect((await screen.findByRole("alert")).textContent).toBe("1 request is overdue.");
  expect(screen.getByRole("link", { name: "Go to requests" }).getAttribute("href")).toBe("/requests");
});

test("several overdue requests use the plural", async () => {
  dpo({ "GET /v1/dsr": { body: [queue[0], { ...queue[0], id: "5" }] } });
  expect((await screen.findByRole("alert")).textContent).toBe("2 requests are overdue.");
});

test("nothing overdue means no alert", async () => {
  dpo({ "GET /v1/dsr": { body: [queue[1]] } });
  await screen.findByText("Open requests");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a failure is shown, and Try again loads the counts", async () => {
  dpo({ "GET /v1/dsr": [{ status: 500, body: { message: "The database is busy." } }, { body: queue }] });
  expect((await screen.findByRole("alert")).textContent).toBe("The database is busy.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Open requests")).toBeTruthy();
});

test("an administrator sees the number of active endpoints and never asks for the requests queue", async () => {
  const r = renderScreen(<Overview />, {
    role: "tenant_admin",
    routes: { "GET /v1/webhook-endpoints": { body: [{ id: "a", url: "https://x.example", events: [], createdAt: "2026-10-01T00:00:00.000Z", disabledAt: null }, { id: "b", url: "https://y.example", events: [], createdAt: "2026-10-01T00:00:00.000Z", disabledAt: "2026-10-02T00:00:00.000Z" }] } },
  });
  expect((await screen.findByText("Active endpoints")).parentElement?.textContent).toBe("Active endpoints1");
  expect(r.callsTo("GET", "/v1/dsr")).toHaveLength(0);
  expect(screen.getByRole("link", { name: "Go to integrations" }).getAttribute("href")).toBe("/integrations");
});

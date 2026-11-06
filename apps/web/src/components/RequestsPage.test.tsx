import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { RequestsPage } from "./RequestsPage";
import { when } from "@/lib/format";
import { renderScreen, type Route } from "@/test/harness";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const view = { decidedReason: null, closedAt: null };
const erasure = { ...view, id: ID1, type: "erasure", state: "submitted", submittedAt: "2026-10-30T09:00:00.000Z", dueAt: "2026-11-29T09:00:00.000Z", overdue: false };
const access = { ...view, id: ID2, type: "access", state: "in_review", submittedAt: "2026-09-20T09:00:00.000Z", dueAt: "2026-11-04T10:00:00.000Z", overdue: true };
const fixed = { ...view, id: ID3, type: "correction", state: "fulfilled", submittedAt: "2026-09-01T09:00:00.000Z", dueAt: "2026-10-01T09:00:00.000Z", overdue: false };
const queue = [access, erasure, fixed];

const page = (routes: Record<string, Route | Route[]> = {}) => renderScreen(<RequestsPage />, { role: "dpo", routes: { "GET /v1/dsr": { body: queue }, ...routes } });
const open = async (name: RegExp) => fireEvent.click(await screen.findByRole("button", { name }));

describe("the queue", () => {
  test("shows each request's type, status and how long is left, in words", async () => {
    page();
    const rows = await screen.findAllByRole("row");
    const text = rows.map((r) => r.textContent);
    expect(text[1]).toContain("Access to data");
    expect(text[1]).toContain("In review");
    expect(text[1]).toContain("Overdue by 2 days");
    expect(text[2]).toContain("Erasure");
    expect(text[2]).toContain("New");
    expect(text[2]).toContain("Due in 22 days");
    expect(text[3]).toContain("Fulfilled");
    expect(text[3]).toContain("Finished");
  });

  test("while loading it says so", () => {
    page({ "GET /v1/dsr": { body: queue, wait: new Promise(() => undefined) } });
    expect(screen.getByRole("status").textContent).toBe("Loading requests…");
  });

  test("with no requests at all it explains where they come from", async () => {
    page({ "GET /v1/dsr": { body: [] } });
    expect((await screen.findByText(/No requests yet/)).textContent).toMatch(/notice|form/i);
  });

  test("with no match for the filters it says so and offers no explanation about sources", async () => {
    page({ "GET /v1/dsr": [{ body: queue }, { body: [] }] });
    await screen.findAllByRole("row");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "closed" } });
    expect(await screen.findByText("No requests match these filters.")).toBeTruthy();
  });

  test("a failure is shown with the server's words and Try again loads the queue", async () => {
    page({ "GET /v1/dsr": [{ status: 500, body: { message: "The database is busy." } }, { body: queue }] });
    expect((await screen.findByRole("alert")).textContent).toBe("The database is busy.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByRole("row")).length).toBe(4);
  });

  test("choosing a status asks the server for that status, and Overdue only asks for overdue", async () => {
    const v = page({ "GET /v1/dsr?state=in_review": { body: [access] }, "GET /v1/dsr?state=in_review&overdue=true": { body: [access] } });
    await screen.findAllByRole("row");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in_review" } });
    await waitFor(() => expect(v.calls.some((c) => c.search === "?state=in_review")).toBe(true));
    fireEvent.click(screen.getByLabelText("Overdue only"));
    await waitFor(() => expect(v.calls.some((c) => c.search === "?state=in_review&overdue=true")).toBe(true));
  });
});

describe("one request", () => {
  const detail = { ...erasure, details: "Please delete my account." };

  test("opening a request shows what the person wrote, moves focus to it, and marks the row as selected", async () => {
    page({ [`GET /v1/dsr/${ID1}`]: { body: detail } });
    await open(/^Erasure/);
    const heading = await screen.findByRole("heading", { name: "Erasure request" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText("Please delete my account.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Erasure/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByText(when(erasure.submittedAt))).toBeTruthy();
  });

  test("a slow answer for an earlier choice never replaces the request that was opened last", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((r) => (release = r));
    page({
      [`GET /v1/dsr/${ID1}`]: { body: detail, wait: slow },
      [`GET /v1/dsr/${ID2}`]: { body: { ...access, details: "Send me my data." } },
    });
    await open(/^Erasure/);
    await open(/^Access to data/);
    await screen.findByText("Send me my data.");
    release();
    await waitFor(() => expect(screen.queryByText("Please delete my account.")).toBeNull());
    expect(screen.getByRole("heading", { name: "Access to data request" })).toBeTruthy();
  });

  test("the contact is hidden until the officer asks, and asking is said to be recorded", async () => {
    const v = page({ [`GET /v1/dsr/${ID1}`]: { body: detail }, [`POST /v1/dsr/${ID1}/reveal-contact`]: { body: { contact: "+919876543210" } } });
    await open(/^Erasure/);
    await screen.findByRole("heading", { name: "Erasure request" });
    expect(screen.queryByText("+919876543210")).toBeNull();
    expect(v.callsTo("POST", `/v1/dsr/${ID1}/reveal-contact`)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show contact details" }));
    expect(await screen.findByText("+919876543210")).toBeTruthy();
    expect(screen.getByText(/recorded in the audit log/i)).toBeTruthy();
  });

  test("when the contact cannot be shown, the reason is shown", async () => {
    page({ [`GET /v1/dsr/${ID1}`]: { body: detail }, [`POST /v1/dsr/${ID1}/reveal-contact`]: { status: 404, body: { message: "No contact was given for this request." } } });
    await open(/^Erasure/);
    await screen.findByRole("heading", { name: "Erasure request" });
    fireEvent.click(screen.getByRole("button", { name: "Show contact details" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No contact was given for this request.");
  });

  test("only the legal next steps are offered", async () => {
    page({ [`GET /v1/dsr/${ID1}`]: { body: detail } });
    await open(/^Erasure/);
    await screen.findByRole("heading", { name: "Erasure request" });
    const steps = screen.getAllByRole("button").map((b) => b.textContent).filter((t) => ["Ask for proof of identity", "Start review", "Reject", "Mark as fulfilled", "Close"].includes(t ?? ""));
    expect(steps).toEqual(["Ask for proof of identity", "Start review", "Reject"]);
  });

  test("a finished request offers no step except closing", async () => {
    page({ [`GET /v1/dsr/${ID3}`]: { body: { ...fixed, details: null } } });
    await open(/^Correction/);
    await screen.findByRole("heading", { name: "Correction request" });
    expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  test("starting a review sends one transition, says so, and refreshes the queue", async () => {
    const moved = { ...detail, state: "in_review" };
    const v = page({
      [`GET /v1/dsr/${ID1}`]: { body: detail },
      [`POST /v1/dsr/${ID1}/transition`]: { body: moved },
      "GET /v1/dsr": [{ body: queue }, { body: [access, moved, fixed] }],
    });
    await open(/^Erasure/);
    await screen.findByRole("heading", { name: "Erasure request" });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect((await screen.findByText("Moved to In review.")).getAttribute("role")).toBe("status");
    expect(v.callsTo("POST", `/v1/dsr/${ID1}/transition`)).toHaveLength(1);
    expect(v.callsTo("POST", `/v1/dsr/${ID1}/transition`)[0]?.body).toEqual({ to: "in_review" });
    // The detail follows the server's answer at once: the old steps are gone and the new ones are offered.
    expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as fulfilled" })).toBeTruthy();
    await waitFor(() => expect(v.callsTo("GET", "/v1/dsr")).toHaveLength(2));
    expect(within(screen.getByRole("table")).getAllByText("In review").length).toBe(2);
  });

  test("rejecting asks for a reason first, and sends nothing until there is one", async () => {
    const v = page({ [`GET /v1/dsr/${ID1}`]: { body: detail }, [`POST /v1/dsr/${ID1}/transition`]: { body: { ...detail, state: "rejected", decidedReason: "Not a customer." } } });
    await open(/^Erasure/);
    await screen.findByRole("heading", { name: "Erasure request" });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
    expect(screen.getByRole("alert").textContent).toBe("Give a reason for the rejection. It is kept with the request.");
    expect(v.callsTo("POST", `/v1/dsr/${ID1}/transition`)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Reason for rejecting"), { target: { value: "  Not a customer.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
    await screen.findByText("Moved to Rejected.");
    expect(v.callsTo("POST", `/v1/dsr/${ID1}/transition`)[0]?.body).toEqual({ to: "rejected", reason: "Not a customer." });
  });

  test("fulfilling needs a confirming click, and Cancel sends nothing", async () => {
    const v = page({ [`GET /v1/dsr/${ID2}`]: { body: { ...access, details: null } }, [`POST /v1/dsr/${ID2}/transition`]: { body: { ...access, state: "fulfilled" } } });
    await open(/^Access to data/);
    await screen.findByRole("heading", { name: "Access to data request" });
    fireEvent.click(screen.getByRole("button", { name: "Mark as fulfilled" }));
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(v.callsTo("POST", `/v1/dsr/${ID2}/transition`)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Mark as fulfilled" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, mark as fulfilled" }));
    await screen.findByText("Moved to Fulfilled.");
    expect(v.callsTo("POST", `/v1/dsr/${ID2}/transition`)).toHaveLength(1);
  });

  test("when the server refuses a move, its message is shown and the request stays as it was", async () => {
    page({ [`GET /v1/dsr/${ID1}`]: { body: detail }, [`POST /v1/dsr/${ID1}/transition`]: { status: 409, body: { message: "That request has already been moved." } } });
    await open(/^Erasure/);
    await screen.findByRole("heading", { name: "Erasure request" });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That request has already been moved.");
    expect(screen.getByRole("button", { name: "Start review" })).toBeTruthy();
  });

  test("a recorded rejection reason is shown to the officer", async () => {
    page({ [`GET /v1/dsr/${ID1}`]: { body: { ...detail, state: "rejected", decidedReason: "Not a customer." } } });
    await open(/^Erasure/);
    expect(await screen.findByText("Not a customer.")).toBeTruthy();
  });
});

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ConsentsPage } from "./ConsentsPage";
import { when } from "@/lib/format";
import { renderScreen, type Route } from "@/test/harness";

const N1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R1 = "11111111-1111-4111-8111-111111111111";
const SUMMARY = {
  from: "2026-10-10",
  to: "2026-11-08",
  totals: { active: 42, withdrawn: 7, expired: 1 },
  purposes: [
    { key: "analytics", active: 40, withdrawn: 6, expired: 1 },
    { key: "marketing", active: 12, withdrawn: 3, expired: 0 },
  ],
  days: [
    { date: "2026-11-06", granted: 5, withdrawn: 1 },
    { date: "2026-11-07", granted: 0, withdrawn: 0 },
    { date: "2026-11-08", granted: 9, withdrawn: 2 },
  ],
};
const consent = (over: Record<string, unknown> = {}) => ({
  id: "c1", status: "granted", grantedAt: "2026-11-05T09:00:00.000Z", withdrawnAt: null, collectionMethod: "web_sdk",
  notice: { id: N1, version: 3, language: "en" }, purposes: [{ key: "analytics", granted: true }, { key: "marketing", granted: false }], receiptId: R1, ...over,
});

const page = (routes: Record<string, Route | Route[]> = {}) =>
  renderScreen(<ConsentsPage />, { role: "dpo", routes: { "GET /v1/consents/summary": { body: SUMMARY }, ...routes } });
const find = (value: string) => {
  fireEvent.change(screen.getByLabelText("Phone number or email address"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Find consents" }));
};
const results = () => screen.getByRole("region", { name: "Consents found" });

describe("the overview", () => {
  test("shows the totals in words, the purposes agreed to, and a line for each day", async () => {
    page();
    expect(await screen.findByText("42")).toBeTruthy();
    const totals = screen.getByRole("region", { name: "In numbers" });
    expect(within(totals).getByText("Active")).toBeTruthy();
    expect(within(totals).getByText("Withdrawn")).toBeTruthy();
    expect(within(totals).getByText("Expired")).toBeTruthy();
    expect(totals.textContent).toContain("7");
    const byPurpose = screen.getByRole("table", { name: /By purpose/ });
    const rows = within(byPurpose).getAllByRole("row");
    expect(rows[1]?.textContent).toContain("analytics");
    expect(rows[1]?.textContent).toMatch(/40.*6.*1/);
    expect(rows[2]?.textContent).toContain("marketing");
    const days = within(screen.getByRole("table", { name: /Last 30 days/ })).getAllByRole("row");
    expect(days).toHaveLength(4);
    expect(days[3]?.textContent).toContain("9");
    expect(days[3]?.textContent).toContain("2");
  });

  test("asks for the last 30 days, and says which days they are", async () => {
    const v = page();
    await screen.findByText("42");
    expect(v.callsTo("GET", "/v1/consents/summary")[0]?.search).toBe("?days=30");
    expect(screen.getByText(/10 Oct 2026 to 8 Nov 2026|Oct 10, 2026 to Nov 8, 2026/)).toBeTruthy();
  });

  test("while loading it says so, and a failure shows its words and can be tried again", async () => {
    page({ "GET /v1/consents/summary": [{ status: 500, body: { message: "The database is busy." } }, { body: SUMMARY }] });
    expect(screen.getByText("Loading the numbers…")).toBeTruthy();
    expect((await screen.findByText("The database is busy.")).closest("[role=alert]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("42")).toBeTruthy();
  });

  test("with no consents yet it says so instead of showing empty tables", async () => {
    page({ "GET /v1/consents/summary": { body: { ...SUMMARY, totals: { active: 0, withdrawn: 0, expired: 0 }, purposes: [], days: [{ date: "2026-11-08", granted: 0, withdrawn: 0 }] } } });
    expect(await screen.findByText("No consent has been recorded yet.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: /By purpose/ })).toBeNull();
  });
});

describe("finding a person's consents", () => {
  test("says before anything is typed that a search is recorded in the audit log", async () => {
    page();
    await screen.findByText("42");
    expect(screen.getByText(/Every search that finds a person is recorded in the audit log/)).toBeTruthy();
  });

  test("sends the identifier in a POST body, trimmed, and shows each consent in words", async () => {
    const v = page({
      "POST /v1/consents/search": {
        body: { truncated: false, consents: [
          consent(),
          consent({ id: "c2", status: "withdrawn", withdrawnAt: "2026-11-06T10:00:00.000Z", grantedAt: "2026-10-01T09:00:00.000Z", collectionMethod: "api", notice: { id: N1, version: 2, language: "hi" }, receiptId: null }),
          consent({ id: "c3", status: "expired", collectionMethod: "dpo_entry" }),
        ] },
      },
    });
    await screen.findByText("42");
    find("  +91 98100 00001  ");
    await within(await screen.findByRole("region", { name: "Consents found" })).findAllByRole("row");
    const call = v.callsTo("POST", "/v1/consents/search")[0];
    expect(call?.body).toEqual({ identifier: "+91 98100 00001" });
    expect(call?.search).toBe("");
    const rows = within(results()).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]?.textContent).toContain("Active");
    expect(rows[1]?.textContent).toContain(when("2026-11-05T09:00:00.000Z"));
    expect(rows[1]?.textContent).toContain("Website banner");
    expect(rows[1]?.textContent).toContain("Version 3, English");
    expect(rows[1]?.textContent).toContain("Agreed: analytics");
    expect(rows[1]?.textContent).toContain("Not agreed: marketing");
    expect(rows[1]?.textContent).toContain(R1);
    expect(rows[2]?.textContent).toContain(`Withdrawn ${when("2026-11-06T10:00:00.000Z")}`);
    expect(rows[2]?.textContent).toContain("Your server (API)");
    expect(rows[2]?.textContent).toContain("Version 2, Hindi");
    expect(rows[3]?.textContent).toContain("Expired");
    expect(rows[3]?.textContent).toContain("Entered by an officer");
  });

  test("a language the page does not know is shown by its code, and a consent with no receipt says so", async () => {
    page({ "POST /v1/consents/search": { body: { truncated: false, consents: [consent({ notice: { id: N1, version: 1, language: "ta" }, receiptId: null })] } } });
    await screen.findByText("42");
    find("a@example.org");
    const rows = await within(await screen.findByRole("region", { name: "Consents found" })).findAllByRole("row");
    expect(rows[1]?.textContent).toContain("Version 1, ta");
    expect(rows[1]?.textContent).toContain("No receipt");
  });

  test("a person with no consent is told so plainly, without repeating what was typed", async () => {
    page({ "POST /v1/consents/search": { body: { consents: [], truncated: false } } });
    await screen.findByText("42");
    find("+919810099999");
    expect(await screen.findByText("No consent was found for that phone number or email address.")).toBeTruthy();
    expect(results().textContent).not.toContain("9810099999");
  });

  test("when there are more than are shown it says only the newest are", async () => {
    page({ "POST /v1/consents/search": { body: { consents: [consent()], truncated: true } } });
    await screen.findByText("42");
    find("a@example.org");
    expect(await screen.findByText(/Only the newest 100 are shown/)).toBeTruthy();
  });

  test("an empty box is turned back before anything is sent", async () => {
    const v = page();
    await screen.findByText("42");
    find("   ");
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a phone number or an email address.");
    expect(v.callsTo("POST", "/v1/consents/search")).toHaveLength(0);
  });

  test("the server's refusal is shown in its words and the box keeps what was typed", async () => {
    page({ "POST /v1/consents/search": { status: 400, body: { error: "invalid_request", field: "identifier", message: "must be an E.164 phone number (+919876543210) or an email address" } } });
    await screen.findByText("42");
    find("12345");
    expect((await screen.findByRole("alert")).textContent).toBe("must be an E.164 phone number (+919876543210) or an email address");
    expect((screen.getByLabelText("Phone number or email address") as HTMLInputElement).value).toBe("12345");
  });

  test("a second search replaces the first, and the button cannot be pressed twice while one is running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const v = page({
      "POST /v1/consents/search": [
        { body: { consents: [consent({ id: "first", purposes: [{ key: "first-purpose", granted: true }] })], truncated: false }, wait: gate },
        { body: { consents: [consent({ id: "second", purposes: [{ key: "second-purpose", granted: true }] })], truncated: false } },
      ],
    });
    await screen.findByText("42");
    find("a@example.org");
    fireEvent.click(screen.getByRole("button", { name: /^Finding/ }));
    expect((screen.getByRole("button", { name: /^Finding/ }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText(/first-purpose/);
    find("b@example.org");
    expect(await screen.findByText(/second-purpose/)).toBeTruthy();
    expect(screen.queryByText(/first-purpose/)).toBeNull();
    expect(v.callsTo("POST", "/v1/consents/search")).toHaveLength(2);
  });

  test("the identifier is kept nowhere: not in storage, and not in the address", async () => {
    page({ "POST /v1/consents/search": { body: { consents: [consent()], truncated: false } } });
    await screen.findByText("42");
    find("+919810000001");
    await screen.findByRole("region", { name: "Consents found" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Finding/ })).toBeNull());
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("9810000001");
    expect(JSON.stringify({ ...localStorage })).not.toContain("9810000001");
  });
});

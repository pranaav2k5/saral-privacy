import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AuditPage } from "./AuditPage";
import { renderScreen, type Route } from "@/test/harness";

const HASH = "ab".repeat(32);
const ROOT = "cd".repeat(32);
const ok = { ok: true, count: 42, headHash: HASH, firstSeqNo: "1", lastSeqNo: "42", merkleRoot: ROOT };
const page = (routes: Record<string, Route | Route[]> = {}) => renderScreen(<AuditPage />, { role: "tenant_admin", routes });
const verify = () => fireEvent.click(screen.getByRole("button", { name: "Verify" }));

describe("verifying the log", () => {
  test("nothing is checked until the person asks", () => {
    const v = page();
    expect(v.calls).toHaveLength(0);
  });

  test("a clean log is reported in words, with its size and fingerprints", async () => {
    const v = page({ "GET /v1/audit/verify": { body: ok } });
    verify();
    expect((await screen.findByRole("status")).textContent).toMatch(/The log is intact/);
    expect(screen.getByText("42 entries, numbered 1 to 42")).toBeTruthy();
    expect(screen.getByText(HASH)).toBeTruthy();
    expect(screen.getByText(ROOT)).toBeTruthy();
    expect(v.calls[0]?.search).toBe("");
  });

  test("a date limits the check to that day", async () => {
    const v = page({ "GET /v1/audit/verify": { body: ok } });
    fireEvent.change(screen.getByLabelText("Check only this day (optional)"), { target: { value: "2026-11-05" } });
    verify();
    await screen.findByRole("status");
    expect(v.calls[0]?.search).toBe("?date=2026-11-05");
  });

  test("a log that does not match is an alert naming the entry, never a success message", async () => {
    page({ "GET /v1/audit/verify": { body: { ok: false, failure: "hash_mismatch", seqNo: "17" } } });
    verify();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/does not match/i);
    expect(alert.textContent).toContain("entry 17");
    expect(alert.textContent).toContain("its fingerprint does not match its contents");
    expect(screen.queryByText(/The log is intact/)).toBeNull();
  });

  test("a log with no entries says so instead of claiming to be intact", async () => {
    page({ "GET /v1/audit/verify": { body: { ok: true, count: 0, headHash: HASH, firstSeqNo: null, lastSeqNo: null, merkleRoot: ROOT } } });
    verify();
    expect((await screen.findByRole("status")).textContent).toMatch(/no entries/i);
    expect(screen.queryByText(/The log is intact/)).toBeNull();
  });

  test("an unreachable server is explained, and the button is free again", async () => {
    page({ "GET /v1/audit/verify": { throws: true } });
    verify();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach the server/i);
    expect((screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the button is disabled while checking", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    page({ "GET /v1/audit/verify": { body: ok, wait: gate } });
    verify();
    expect((screen.getByRole("button", { name: "Verifying…" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByRole("status");
  });

  test("a new result replaces the old one instead of piling up", async () => {
    page({ "GET /v1/audit/verify": [{ body: ok }, { body: { ok: false, failure: "seq_gap", seqNo: "9" } }] });
    verify();
    await screen.findByText(/The log is intact/);
    verify();
    await screen.findByRole("alert");
    expect(screen.queryByText(/The log is intact/)).toBeNull();
  });
});

describe("the daily anchor", () => {
  const anchor = { version: 1, tenantId: "11111111-1111-4111-8111-111111111111", date: "2026-11-05", count: 5, firstSeqNo: "38", lastSeqNo: "42", headHash: HASH, merkleRoot: ROOT };
  const getAnchor = () => fireEvent.click(screen.getByRole("button", { name: "Get anchor" }));
  const pickDay = (d = "2026-11-05") => fireEvent.change(screen.getByLabelText("Day"), { target: { value: d } });

  test("a day is required, and nothing is sent without one", () => {
    const v = page();
    getAnchor();
    expect(screen.getByRole("alert").textContent).toBe("Choose a day.");
    expect(v.calls).toHaveLength(0);
  });

  test("shows the anchor's fields and says to keep a copy somewhere else", async () => {
    const v = page({ "GET /v1/audit/merkle-root": { body: anchor } });
    pickDay();
    getAnchor();
    expect(await screen.findByText("5 entries, numbered 38 to 42")).toBeTruthy();
    expect(screen.getByText(ROOT)).toBeTruthy();
    expect(screen.getByText(/keep a copy/i)).toBeTruthy();
    expect(v.calls[0]?.search).toBe("?date=2026-11-05");
  });

  test("a day with no entries says so plainly", async () => {
    page({ "GET /v1/audit/merkle-root": { status: 404, body: { message: "no audit entries on that day" } } });
    pickDay();
    getAnchor();
    expect((await screen.findByRole("alert")).textContent).toBe("There are no audit entries on that day.");
  });

  test("a day whose log fails verification is reported as a failure, with the entry", async () => {
    page({ "GET /v1/audit/merkle-root": { status: 409, body: { error: "chain_invalid", failure: "prev_mismatch", seqNo: "40" } } });
    pickDay();
    getAnchor();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("entry 40");
    expect(alert.textContent).toContain("it does not link to the entry before it");
  });

  test("an anchor is cleared when a different day is requested and fails", async () => {
    page({ "GET /v1/audit/merkle-root": [{ body: anchor }, { status: 404, body: {} }] });
    pickDay();
    getAnchor();
    await screen.findByText("5 entries, numbered 38 to 42");
    pickDay("2026-11-06");
    getAnchor();
    await waitFor(() => expect(screen.queryByText("5 entries, numbered 38 to 42")).toBeNull());
  });
});

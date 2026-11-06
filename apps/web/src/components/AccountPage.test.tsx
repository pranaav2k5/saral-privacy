import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AccountPage } from "./AccountPage";
import { STORAGE_KEY } from "@/lib/session";
import { renderScreen, type Call, type Route } from "@/test/harness";

const ME = { staffId: "11111111-1111-4111-8111-111111111111", email: "officer@example.org", role: "dpo", tenantId: "22222222-2222-4222-8222-222222222222", scopes: ["dpo", "auditor"] };
const NEW_SESSION = { token: "st_v1.new.sig", expiresAt: "2026-11-06T10:15:00.000Z", role: "dpo" };
const OLD = "the old passphrase";
const NEXT = "a brand new long passphrase";

const page = (routes: Record<string, Route | Route[]> = {}) => renderScreen(<AccountPage />, { role: "dpo", routes: { "GET /v1/auth/me": { body: ME }, ...routes } });
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
function fillAll(current = OLD, next = NEXT, confirm = next) {
  fill("Current password", current);
  fill("New password", next);
  fill("Confirm new password", confirm);
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Change password" }));
const posted = (v: ReturnType<typeof page>) => v.callsTo("POST", "/v1/auth/password");
const storedToken = () => (JSON.parse(sessionStorage.getItem(STORAGE_KEY) as string) as { token: string }).token;

describe("who is signed in", () => {
  test("says which account and in what role, in words", async () => {
    page();
    expect(await screen.findByText("officer@example.org")).toBeTruthy();
    expect(screen.getByText(/Data protection officer/)).toBeTruthy();
  });

  test("if the details cannot be loaded the form is still there, and the page says so", async () => {
    page({ "GET /v1/auth/me": { status: 500, body: { message: "The database is busy." } } });
    expect(await screen.findByText("We could not load your account details.")).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toBeTruthy();
  });
});

describe("the form", () => {
  test("has three password fields that a password manager can fill, and says what a good password is", async () => {
    page();
    await screen.findByText("officer@example.org");
    expect((screen.getByLabelText("Current password") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("Current password") as HTMLInputElement).autocomplete).toBe("current-password");
    expect((screen.getByLabelText("New password") as HTMLInputElement).autocomplete).toBe("new-password");
    expect((screen.getByLabelText("Confirm new password") as HTMLInputElement).autocomplete).toBe("new-password");
    expect(screen.getByText(/at least 12 characters/i)).toBeTruthy();
  });

  test.each([
    ["no current password", ["", NEXT, NEXT], "Enter your current password."],
    ["no new password", [OLD, "", ""], "Enter a new password."],
    ["a new password shorter than 12 characters", [OLD, "too short", "too short"], "The new password must be at least 12 characters."],
    ["a confirmation that does not match", [OLD, NEXT, "a different long passphrase"], "The two new passwords are not the same."],
    ["a new password that is the current one", [OLD + OLD, OLD + OLD, OLD + OLD], "The new password must be different from the current one."],
  ])("turns back %s before anything is sent", async (_n, [current, next, confirm], message) => {
    const v = page();
    await screen.findByText("officer@example.org");
    fillAll(current, next, confirm);
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(document.activeElement).toBe(alert);
    expect(posted(v)).toHaveLength(0);
  });
});

describe("changing the password", () => {
  test("sends only the two passwords, replaces the session with the new one, says the other sessions ended, and empties the fields", async () => {
    const v = page({ "POST /v1/auth/password": { body: NEW_SESSION } });
    await screen.findByText("officer@example.org");
    const before = storedToken();
    fillAll();
    submit();
    const done = await screen.findByText("Your password was changed. Every other place you were signed in has been signed out.");
    expect(done.getAttribute("role")).toBe("status");
    expect((posted(v)[0] as Call).body).toEqual({ currentPassword: OLD, newPassword: NEXT });
    expect(storedToken()).toBe("st_v1.new.sig");
    expect(storedToken()).not.toBe(before);
    for (const label of ["Current password", "New password", "Confirm new password"]) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    expect(localStorage.length).toBe(0);
    expect(JSON.stringify(sessionStorage)).not.toContain(NEXT);
  });

  test("a wrong current password is shown in the server's words and the person stays signed in with the fields still filled", async () => {
    const v = page({ "POST /v1/auth/password": { status: 422, body: { error: "wrong_password", message: "The current password is not right." } } });
    await screen.findByText("officer@example.org");
    const before = storedToken();
    fillAll();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("The current password is not right.");
    expect(storedToken()).toBe(before);
    expect(posted(v)).toHaveLength(1);
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe(NEXT);
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
  });

  test("a locked account is explained in the server's words", async () => {
    page({ "POST /v1/auth/password": { status: 403, body: { error: "locked", message: "Too many wrong passwords. Try again in 15 minutes." } } });
    await screen.findByText("officer@example.org");
    fillAll();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("Too many wrong passwords. Try again in 15 minutes.");
  });

  test("a refusal of the new password by the server names the field in words", async () => {
    page({ "POST /v1/auth/password": { status: 400, body: { error: "invalid_request", field: "newPassword", message: "must not be your email address" } } });
    await screen.findByText("officer@example.org");
    fillAll();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("The new password must not be your email address.");
  });

  test("a lost connection is explained, and the form can be sent again", async () => {
    const v = page({ "POST /v1/auth/password": [{ throws: true }, { body: NEW_SESSION }] });
    await screen.findByText("officer@example.org");
    fillAll();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("We could not reach the server");
    submit();
    await screen.findByText(/Your password was changed/);
    expect(posted(v)).toHaveLength(2);
  });

  test("a second click while the first is in flight sends nothing more, and the button says it is working", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const v = page({ "POST /v1/auth/password": { body: NEW_SESSION, wait: gate } });
    await screen.findByText("officer@example.org");
    fillAll();
    submit();
    const busy = await screen.findByRole("button", { name: "Changing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(busy.closest("form") as HTMLFormElement);
    release();
    await screen.findByText(/Your password was changed/);
    expect(posted(v)).toHaveLength(1);
  });

  test("a later refusal removes the success message, and a later success removes the refusal", async () => {
    page({ "POST /v1/auth/password": [{ body: NEW_SESSION }, { status: 422, body: { message: "The current password is not right." } }, { body: { ...NEW_SESSION, token: "st_v1.newer.sig" } }] });
    await screen.findByText("officer@example.org");
    fillAll();
    submit();
    await screen.findByText(/Your password was changed/);
    fillAll();
    submit();
    await screen.findByRole("alert");
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
    fillAll();
    submit();
    await screen.findByText(/Your password was changed/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(storedToken()).toBe("st_v1.newer.sig");
  });

  test("each new refusal takes focus again, even after focus moved to a field", async () => {
    page({ "POST /v1/auth/password": { status: 422, body: { message: "The current password is not right." } } });
    await screen.findByText("officer@example.org");
    fillAll();
    submit();
    const first = await screen.findByRole("alert");
    expect(document.activeElement).toBe(first);
    (screen.getByLabelText("Current password") as HTMLInputElement).focus();
    fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  });

  test("the browser's own validation pop-ups are off, so the page's words are what is read", async () => {
    const form = (page(), (await screen.findByText("officer@example.org"), screen.getByRole("button", { name: "Change password" }).closest("form") as HTMLFormElement));
    expect(form.noValidate).toBe(true);
  });
});

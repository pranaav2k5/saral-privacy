import { renderToString } from "react-dom/server";
import { fireEvent, screen } from "@testing-library/react";
import { AppFrame, RequireRole } from "./Shell";
import { SessionProvider } from "@/lib/session";
import { renderScreen } from "@/test/harness";

let mockPath = "/";
jest.mock("next/navigation", () => ({ usePathname: () => mockPath }));

const links = () => screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);

beforeEach(() => {
  mockPath = "/";
});

test("a data protection officer sees Overview, Requests, Consents, Breaches, Audit and Account, and not Notices or Integrations", () => {
  renderScreen(<AppFrame><p>page</p></AppFrame>, { role: "dpo" });
  expect(links()).toEqual([["Skip to content", "#main"], ["Overview", "/"], ["Requests", "/requests"], ["Consents", "/consents"], ["Breaches", "/breaches"], ["Audit", "/audit"], ["Account", "/account"]]);
});

test("an administrator sees Overview, Notices, Breaches, Audit, Integrations and Account, and not Requests", () => {
  renderScreen(<AppFrame><p>page</p></AppFrame>, { role: "tenant_admin" });
  expect(links()).toEqual([["Skip to content", "#main"], ["Overview", "/"], ["Notices", "/notices"], ["Breaches", "/breaches"], ["Audit", "/audit"], ["Integrations", "/integrations"], ["Account", "/account"]]);
});

test("the page being shown is marked as current, and only it", () => {
  mockPath = "/audit";
  renderScreen(<AppFrame><p>page</p></AppFrame>, { role: "dpo" });
  expect(screen.getAllByRole("link", { current: "page" }).map((a) => a.textContent)).toEqual(["Audit"]);
});

test("the role is named in words, and the page content sits in the main landmark that the skip link targets", () => {
  renderScreen(<AppFrame><p>page text</p></AppFrame>, { role: "dpo" });
  expect(screen.getByText("Data protection officer")).toBeTruthy();
  const main = screen.getByRole("main");
  expect(main.id).toBe("main");
  expect(main.textContent).toBe("page text");
});

test("signed out, the sign-in screen is shown and the page content is not", () => {
  renderScreen(<AppFrame><p>secret page</p></AppFrame>);
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(screen.queryByText("secret page")).toBeNull();
});

test("signing out returns to the sign-in screen and drops the stored session", () => {
  renderScreen(<AppFrame><p>secret page</p></AppFrame>, { role: "dpo" });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(sessionStorage.length).toBe(0);
});

test("before the browser has been asked about a stored session, the server-rendered page shows neither the sign-in form nor the pages", () => {
  const html = renderToString(
    <SessionProvider baseUrl="https://api.example.org">
      <AppFrame><p>secret page</p></AppFrame>
    </SessionProvider>,
  );
  expect(html).toContain("Loading");
  expect(html).not.toContain("secret page");
  expect(html).not.toContain("Password");
});

describe("RequireRole", () => {
  test("shows the page to a role that is allowed", () => {
    renderScreen(<AppFrame><RequireRole roles={["tenant_admin"]}><p>admin only</p></RequireRole></AppFrame>, { role: "tenant_admin" });
    expect(screen.getByText("admin only")).toBeTruthy();
  });
  test("tells another role it has no access, instead of showing a page that would only fail", () => {
    renderScreen(<AppFrame><RequireRole roles={["tenant_admin"]}><p>admin only</p></RequireRole></AppFrame>, { role: "dpo" });
    expect(screen.queryByText("admin only")).toBeNull();
    expect(screen.getByText("Your role does not have access to this page.")).toBeTruthy();
  });
});

describe("a person who has not yet chosen their own password", () => {
  const frame = (role: "dpo" | "tenant_admin" = "dpo") =>
    renderScreen(<AppFrame><p>the requested page</p></AppFrame>, { role, mustChangePassword: true, routes: { "GET /v1/auth/me": { body: { email: "officer@example.org" } } } });

  test("is shown the change-password form in place of any page, and the page they asked for is not shown", async () => {
    frame();
    expect(await screen.findByRole("heading", { name: "Change your password" })).toBeTruthy();
    expect(screen.queryByText("the requested page")).toBeNull();
    expect(screen.getByText(/An operator gave you this password/)).toBeTruthy();
  });

  test("has no menu to other pages, only the way out", async () => {
    frame("tenant_admin");
    await screen.findByRole("heading", { name: "Change your password" });
    expect(links()).toEqual([["Skip to content", "#main"]]);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByText("Administrator")).toBeTruthy();
  });

  test("is shown the same on any address", async () => {
    mockPath = "/requests";
    frame();
    expect(await screen.findByRole("heading", { name: "Change your password" })).toBeTruthy();
    expect(screen.queryByText("the requested page")).toBeNull();
  });

  test("gets the page they asked for as soon as the password is changed", async () => {
    mockPath = "/requests";
    const v = renderScreen(<AppFrame><p>the requested page</p></AppFrame>, {
      role: "dpo",
      mustChangePassword: true,
      routes: {
        "GET /v1/auth/me": { body: { email: "officer@example.org" } },
        "POST /v1/auth/password": { body: { token: "st_v1.new.sig", expiresAt: "2026-11-06T10:15:00.000Z", role: "dpo", mustChangePassword: false } },
      },
    });
    await screen.findByRole("heading", { name: "Change your password" });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "the one the operator gave" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a brand new long passphrase" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a brand new long passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("the requested page")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Change your password" })).toBeNull();
    expect(v.callsTo("POST", "/v1/auth/password")).toHaveLength(1);
  });

  test("an ordinary session is not held back", () => {
    renderScreen(<AppFrame><p>the requested page</p></AppFrame>, { role: "dpo" });
    expect(screen.getByText("the requested page")).toBeTruthy();
    expect(screen.queryByText(/An operator gave you this password/)).toBeNull();
  });
});

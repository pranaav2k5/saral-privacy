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

test("a data protection officer sees Overview, Requests, Audit and Account, and not Notices or Integrations", () => {
  renderScreen(<AppFrame><p>page</p></AppFrame>, { role: "dpo" });
  expect(links()).toEqual([["Skip to content", "#main"], ["Overview", "/"], ["Requests", "/requests"], ["Audit", "/audit"], ["Account", "/account"]]);
});

test("an administrator sees Overview, Notices, Audit, Integrations and Account, and not Requests", () => {
  renderScreen(<AppFrame><p>page</p></AppFrame>, { role: "tenant_admin" });
  expect(links()).toEqual([["Skip to content", "#main"], ["Overview", "/"], ["Notices", "/notices"], ["Audit", "/audit"], ["Integrations", "/integrations"], ["Account", "/account"]]);
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

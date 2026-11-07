import { screen } from "@testing-library/react";
import Integrations from "./integrations/page";
import Notices from "./notices/page";
import Requests from "./requests/page";
import { AppFrame } from "@/components/Shell";
import { renderScreen } from "@/test/harness";

jest.mock("next/navigation", () => ({ usePathname: () => "/" }));

test("an officer who opens the integrations page is told it is not for their role, and nothing is requested", () => {
  const r = renderScreen(<AppFrame><Integrations /></AppFrame>, { role: "dpo" });
  expect(screen.getByText("Your role does not have access to this page.")).toBeTruthy();
  expect(r.calls).toHaveLength(0);
});

test("an administrator who opens the requests page is told it is not for their role, and nothing is requested", () => {
  const r = renderScreen(<AppFrame><Requests /></AppFrame>, { role: "tenant_admin" });
  expect(screen.getByText("Your role does not have access to this page.")).toBeTruthy();
  expect(r.calls).toHaveLength(0);
});

test("an officer who opens the notices page is told it is not for their role, and nothing is requested", () => {
  const r = renderScreen(<AppFrame><Notices /></AppFrame>, { role: "dpo" });
  expect(screen.getByText("Your role does not have access to this page.")).toBeTruthy();
  expect(r.calls).toHaveLength(0);
});

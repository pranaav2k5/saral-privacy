import { screen } from "@testing-library/react";
import Home from "./page";
import { renderScreen } from "@/test/harness";

jest.mock("next/navigation", () => ({ usePathname: () => "/" }));

test("the home page is the Overview, for a signed-in officer", async () => {
  renderScreen(<Home />, { role: "dpo", routes: { "GET /v1/dsr": { body: [] } } });
  expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(await screen.findByText("Open requests")).toBeTruthy();
});

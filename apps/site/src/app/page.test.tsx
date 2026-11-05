import { render, screen } from "@testing-library/react";
import Home from "./page";

test("home page renders the site heading", () => {
  render(<Home />);

  expect(screen.getByRole("heading", { name: "Saral Privacy" })).toBeTruthy();
});

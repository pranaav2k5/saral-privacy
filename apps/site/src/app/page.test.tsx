import { render, screen } from "@testing-library/react";
import Home from "./page";

test("home page renders the site heading", () => {
  render(<Home />);

  expect(screen.getByRole("heading", { name: "Saral Privacy" })).toBeTruthy();
});

test("home page links to the free notice generator", () => {
  render(<Home />);

  const link = screen.getByRole("link", { name: "Write a privacy notice" });
  expect(link.getAttribute("href")).toBe("/notice-generator");
});

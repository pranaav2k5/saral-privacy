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

test("home page links to the consent receipt check", () => {
  render(<Home />);

  const link = screen.getByRole("link", { name: "Check a consent receipt" });
  expect(link.getAttribute("href")).toBe("/verify");
});

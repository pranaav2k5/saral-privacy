import { render, screen } from "@testing-library/react";
import VerifyPage from "./page";

test("the page explains what the check is, in plain words, and offers the box", () => {
  render(<VerifyPage />);
  expect(screen.getByRole("heading", { name: "Check a consent receipt" })).toBeTruthy();
  expect(screen.getByText(/You do not have to trust this page/)).toBeTruthy();
  expect(screen.getByLabelText("Consent receipt")).toBeTruthy();
});

test("the keys come from the configured API address, shown on the page", () => {
  render(<VerifyPage />);
  expect(screen.getByText("http://localhost:4000/.well-known/jwks.json")).toBeTruthy();
});

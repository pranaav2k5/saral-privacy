import { render, screen } from "@testing-library/react";
import VerifyPage from "./page";
import { API_BASE_URL } from "@/lib/config";

test("the page explains what the check is, in plain words, and offers the box", () => {
  render(<VerifyPage />);
  expect(screen.getByRole("heading", { name: "Check a consent receipt" })).toBeTruthy();
  expect(screen.getByLabelText("Consent receipt")).toBeTruthy();
});

test("it does not claim the result is independent of the site: the check runs here, and a check that does not depend on this site needs a tool of the person's own and a key from a source they trust", () => {
  render(<VerifyPage />);
  expect(screen.queryByText(/You do not have to trust this page/)).toBeNull();
  expect(screen.getByText(/someone who ran this site could change it/i)).toBeTruthy();
  expect(screen.getByText(/does not depend on this site/)).toBeTruthy();
  expect(screen.getByText(/public key from a source you trust/)).toBeTruthy();
});

test("the keys come from the configured API address, shown on the page, whatever that address is", () => {
  render(<VerifyPage />);
  expect(screen.getByText(`${API_BASE_URL}/.well-known/jwks.json`)).toBeTruthy();
});

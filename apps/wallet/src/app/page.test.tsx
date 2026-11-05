import { render, screen } from "@testing-library/react";
import Home from "./page";

test("home page renders the wallet heading", () => {
  render(<Home />);

  expect(screen.getByRole("heading", { name: "Saral DPDP Wallet" })).toBeTruthy();
});

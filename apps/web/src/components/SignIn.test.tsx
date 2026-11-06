import { useEffect } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { SignIn } from "./SignIn";
import { useSession } from "@/lib/session";
import { renderScreen } from "@/test/harness";

function Status() {
  const s = useSession();
  return <p data-testid="status">{s.status}</p>;
}
const view = (routes = {}) => renderScreen(<><SignIn /><Status /></>, { routes });

function fillCredentials(password = "correct horse") {
  fireEvent.change(screen.getByLabelText("Organisation"), { target: { value: "acme" } });
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "dpo@example.org" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
const session = { token: "st_v1.a.b", expiresAt: "2026-11-06T10:15:00.000Z", role: "dpo" };

test("asks for organisation, email and password, and nothing is submitted until they are sent", () => {
  const v = view();
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
  expect(v.calls).toHaveLength(0);
});

test("wrong details show the server's message, keep the email, and clear the password", async () => {
  view({ "POST /v1/auth/login": { status: 401, body: { message: "Check your details and try again." } } });
  fillCredentials("wrong");
  expect((await screen.findByRole("alert")).textContent).toBe("Check your details and try again.");
  expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("dpo@example.org");
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
});

test("the sign-in call carries the organisation, email and password", async () => {
  const v = view({ "POST /v1/auth/login": { status: 401, body: {} } });
  fillCredentials();
  await screen.findByRole("alert");
  expect(v.callsTo("POST", "/v1/auth/login")[0]?.body).toEqual({ tenant: "acme", email: "dpo@example.org", password: "correct horse" });
});

test("the button is disabled while the request is in flight, so one press cannot send two", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const v = view({ "POST /v1/auth/login": { status: 401, body: {}, wait: gate } });
  fillCredentials();
  const button = screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  release();
  await screen.findByRole("alert");
  expect(v.callsTo("POST", "/v1/auth/login")).toHaveLength(1);
});

test("a person who already has an authenticator app enters the code and is signed in", async () => {
  const v = view({
    "POST /v1/auth/login": { body: { challenge: "c1", mfa: "verify" } },
    "POST /v1/auth/mfa/verify": { body: session },
  });
  fillCredentials();
  fireEvent.change(await screen.findByLabelText("Authenticator code or recovery code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signedIn"));
  expect(v.callsTo("POST", "/v1/auth/mfa/verify")[0]?.body).toEqual({ challenge: "c1", code: "123456" });
  expect(v.callsTo("POST", "/v1/auth/mfa/enroll")).toHaveLength(0);
});

test("a wrong code shows the message and lets the person try again without starting over", async () => {
  view({
    "POST /v1/auth/login": { body: { challenge: "c1", mfa: "verify" } },
    "POST /v1/auth/mfa/verify": [{ status: 401, body: { message: "That code did not work." } }, { body: session }],
  });
  fillCredentials();
  const field = await screen.findByLabelText("Authenticator code or recovery code");
  fireEvent.change(field, { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That code did not work.");
  fireEvent.change(screen.getByLabelText("Authenticator code or recovery code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signedIn"));
});

test("a first sign-in shows the setup key, then the recovery codes once, and only signs in after they are acknowledged", async () => {
  view({
    "POST /v1/auth/login": { body: { challenge: "c1", mfa: "enroll" } },
    "POST /v1/auth/mfa/enroll": { body: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Saral:dpo@example.org?secret=JBSWY3DPEHPK3PXP&issuer=Saral" } },
    "POST /v1/auth/mfa/verify": { body: { ...session, recoveryCodes: ["AAAA-1111", "BBBB-2222"] } },
  });
  fillCredentials();
  expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Authenticator code or recovery code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(await screen.findByText("AAAA-1111")).toBeTruthy();
  expect(screen.getByText("BBBB-2222")).toBeTruthy();
  expect(screen.getByText(/shown only once/i)).toBeTruthy();
  expect(screen.getByTestId("status").textContent).toBe("signedOut");
  fireEvent.click(screen.getByRole("button", { name: "I have saved these codes" }));
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signedIn"));
});

test("the setup link is offered only when it really is an authenticator link", async () => {
  view({
    "POST /v1/auth/login": { body: { challenge: "c1", mfa: "enroll" } },
    "POST /v1/auth/mfa/enroll": { body: { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "javascript:alert(1)" } },
  });
  fillCredentials();
  await screen.findByText("JBSWY3DPEHPK3PXP");
  expect(screen.queryByRole("link")).toBeNull();
});

test("an unreachable server is explained in words", async () => {
  view({ "POST /v1/auth/login": { throws: true } });
  fillCredentials();
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach the server/i);
});

test("the password is not kept once the first step succeeded: starting again shows an empty field", async () => {
  view({ "POST /v1/auth/login": { body: { challenge: "c1", mfa: "verify" } } });
  fillCredentials("a secret");
  await screen.findByLabelText("Authenticator code or recovery code");
  fireEvent.click(screen.getByRole("button", { name: "Start again" }));
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
});

test("a person whose session was ended by the server is told why on the sign-in screen", async () => {
  function Probe() {
    const { status, api } = useSession();
    useEffect(() => {
      if (status === "signedIn") void api.me().catch(() => undefined);
    }, [status, api]);
    return status === "signedIn" ? <p>working</p> : <SignIn />;
  }
  renderScreen(<Probe />, { role: "dpo", routes: { "GET /v1/auth/me": { status: 401, body: {} } } });
  expect((await screen.findByRole("status")).textContent).toBe("Your session ended. Sign in again.");
});

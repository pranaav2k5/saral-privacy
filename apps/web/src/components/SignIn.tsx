"use client";

import { useId, useState, type FormEvent } from "react";
import { ApiError, type SessionInfo } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Alert, Button, Field, focusOnMount } from "./ui";

type Step =
  | { name: "credentials" }
  | { name: "code"; challenge: string; setup?: { secret: string; otpauthUrl: string } }
  | { name: "recovery"; info: SessionInfo & { recoveryCodes: string[] } };

const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

export function SignIn() {
  const { api, notice, signIn } = useSession();
  const [step, setStep] = useState<Step>({ name: "credentials" });
  const [tenant, setTenant] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const submitCredentials = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      let challenge: string;
      let mfa: "enroll" | "verify";
      try {
        ({ challenge, mfa } = await api.login(tenant.trim().toLowerCase(), email.trim(), password));
      } catch (e) {
        setPassword("");
        throw e;
      }
      setPassword("");
      if (mfa === "enroll") setStep({ name: "code", challenge, setup: await api.enroll(challenge) });
      else setStep({ name: "code", challenge });
    });
  };

  const submitCode = (ev: FormEvent, challenge: string) => {
    ev.preventDefault();
    void run(async () => {
      const info = await api.verifyMfa(challenge, code.trim());
      setCode("");
      if (info.recoveryCodes && info.recoveryCodes.length > 0) setStep({ name: "recovery", info: { ...info, recoveryCodes: info.recoveryCodes } });
      else signIn(info);
    });
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6" aria-labelledby={headingId}>
      <header>
        <p className="text-sm font-semibold tracking-wide text-ink-soft">Saral Privacy</p>
        <h1 id={headingId} ref={step.name === "recovery" ? focusOnMount : undefined} tabIndex={-1} className="text-2xl font-semibold">
          {step.name === "recovery" ? "Save your recovery codes" : "Sign in"}
        </h1>
      </header>

      {notice && step.name === "credentials" && <p role="status" className="rounded border border-rule bg-neutral-bg px-3 py-2 text-neutral-fg">{notice}</p>}
      {error && <Alert>{error}</Alert>}

      {step.name === "credentials" && (
        <form onSubmit={submitCredentials} className="flex flex-col gap-4 rounded border border-rule bg-sheet p-5">
          <Field label="Organisation short name" hint="The lowercase short name you were given, for example acme." value={tenant} onChange={setTenant} autoComplete="organization" required />
          <Field label="Work email" value={email} onChange={setEmail} type="email" autoComplete="username" required />
          <Field label="Password" value={password} onChange={setPassword} type="password" autoComplete="current-password" required />
          <Button type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</Button>
        </form>
      )}

      {step.name === "code" && (
        <form onSubmit={(ev) => submitCode(ev, step.challenge)} className="flex flex-col gap-4 rounded border border-rule bg-sheet p-5">
          {step.setup ? (
            <div className="flex flex-col gap-2">
              <p>Add this account to an authenticator app, then enter the code it shows.</p>
              <p className="text-sm text-ink-soft">Setup key</p>
              <p className="break-all font-mono text-lg tracking-wider">{step.setup.secret}</p>
              {step.setup.otpauthUrl.startsWith("otpauth://") && (
                <a className="text-action underline" href={step.setup.otpauthUrl}>Open in my authenticator app</a>
              )}
            </div>
          ) : (
            <p>Enter the code from your authenticator app.</p>
          )}
          <Field label="Authenticator code or recovery code" value={code} onChange={setCode} autoComplete="one-time-code" required focus />
          <Button type="submit" disabled={busy}>{busy ? "Checking…" : step.setup ? "Finish setup" : "Sign in"}</Button>
          <button type="button" className="self-start text-sm text-action underline" onClick={() => { setStep({ name: "credentials" }); setCode(""); setError(null); }}>
            Start again
          </button>
        </form>
      )}

      {step.name === "recovery" && (
        <section className="flex flex-col gap-4 rounded border border-rule bg-sheet p-5">
          <p>
            Each code works once if you lose your authenticator app. These codes are shown only once. Store them somewhere safe, such as a password manager.
          </p>
          <ul className="grid grid-cols-2 gap-2 font-mono">
            {step.info.recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button type="button" onClick={() => signIn(step.info)}>I have saved these codes</Button>
        </section>
      )}
    </main>
  );
}

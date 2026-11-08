"use client";

import { useCallback, useRef, useState } from "react";
import { ApiError, type Role } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { Button, Field, focusOnMount } from "./ui";

const ROLE_NAME: Record<Role, string> = { tenant_admin: "Administrator", dpo: "Data protection officer" };
const MIN = 12;
const FIELD_NAME: Record<string, string> = { currentPassword: "The current password", newPassword: "The new password" };

/** What to tell the person when the server turned the change down, in words. */
function wordsFor(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Try again.";
  const body = (e.body ?? {}) as { field?: unknown; message?: unknown };
  const name = typeof body.field === "string" ? FIELD_NAME[body.field] : undefined;
  return name !== undefined && typeof body.message === "string" ? `${name} ${body.message}.` : e.message;
}

export function AccountPage() {
  const { api, role, signIn, mustChangePassword } = useSession();
  const load = useCallback(() => api.me(), [api]);
  const me = useLoad(load);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const refuse = (message: string) => {
    setChanged(false);
    setProblem(message);
    setAttempt((n) => n + 1);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    if (current === "") return refuse("Enter your current password.");
    if (next === "") return refuse("Enter a new password.");
    if (next.length < MIN) return refuse(`The new password must be at least ${String(MIN)} characters.`);
    if (next !== confirm) return refuse("The two new passwords are not the same.");
    if (next === current) return refuse("The new password must be different from the current one.");
    running.current = true;
    setBusy(true);
    try {
      const session = await api.changePassword(current, next);
      // Every other session has ended, including the one this page was using. The answer is the one to carry on with.
      signIn(session);
      setCurrent("");
      setNext("");
      setConfirm("");
      setProblem(null);
      setChanged(true);
    } catch (err) {
      refuse(wordsFor(err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-prose flex-col gap-6">
      <h1 className="text-2xl font-semibold">Your account</h1>
      {mustChangePassword && (
        <p role="note" className="rounded border border-action bg-neutral-bg px-3 py-2">
          An operator gave you this password, so they know it. Choose your own to continue. Nothing else in the dashboard opens until you do.
        </p>
      )}
      {me.status === "ready" && (
        <p>
          Signed in as <strong>{me.data.email ?? "an unnamed account"}</strong>{role ? ` (${ROLE_NAME[role]})` : ""}.
        </p>
      )}
      {me.status === "error" && <p className="text-ink-soft">We could not load your account details.</p>}

      <section aria-labelledby="password-h" className="flex flex-col gap-4 rounded border border-rule bg-sheet p-4">
        <h2 id="password-h" className="text-xl font-semibold">Change your password</h2>
        <p className="text-ink-soft">
          Use at least {MIN} characters that are not your email address. When the password is changed, every other place you are signed in is signed out.
        </p>
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
          <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={setCurrent} />
          <Field label="New password" type="password" autoComplete="new-password" value={next} onChange={setNext} />
          <Field label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
          {problem && (
            <p key={attempt} role="alert" tabIndex={-1} ref={focusOnMount} className="rounded border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">
              {problem}
            </p>
          )}
          {changed && (
            <p role="status" className="rounded border border-ok-fg bg-ok-bg px-3 py-2 text-ok-fg">
              Your password was changed. Every other place you were signed in has been signed out.
            </p>
          )}
          <Button type="submit" className="self-start" disabled={busy}>{busy ? "Changing…" : "Change password"}</Button>
        </form>
      </section>
    </div>
  );
}

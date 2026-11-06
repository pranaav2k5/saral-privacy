"use client";

import { useId, type ComponentProps, type ReactNode } from "react";

/**
 * Ref callback that moves keyboard focus to an element when it first appears. It is one shared function, so React calls
 * it once on mount and not again on later renders. Use it when a step replaces the control that had focus.
 */
export const focusOnMount = (el: HTMLElement | null): void => {
  el?.focus();
};

/** An error message that screen readers announce when it appears. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">
      {children}
    </p>
  );
}

export function Button({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      {...props}
      className={`min-h-11 rounded bg-action px-4 py-2 font-semibold text-sheet disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    />
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  required,
  hint,
  focus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  /** Help shown under the label and read out with the field. */
  hint?: string;
  /** Focus this field when it first appears. */
  focus?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">{label}</label>
      {hint && <p id={hintId} className="text-sm text-ink-soft">{hint}</p>}
      <input
        id={id}
        ref={focus ? focusOnMount : undefined}
        aria-describedby={hint ? hintId : undefined}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 rounded border border-field bg-sheet px-3"
      />
    </div>
  );
}

"use client";

import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";

/** An error message that screen readers announce when it appears. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded border border-overdue-fg bg-overdue-bg px-3 py-2 text-overdue-fg">
      {children}
    </p>
  );
}

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">{label}</label>
      <input
        id={id}
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

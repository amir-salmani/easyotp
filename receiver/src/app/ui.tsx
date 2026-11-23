/** The few building blocks every screen uses. Tokens only, logical CSS only. */
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  danger: "bg-card text-destructive border border-destructive",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-lg px-6 text-lg font-semibold transition-opacity duration-150 active:opacity-80 disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 py-6">{children}</main>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-border bg-card p-4 text-card-foreground ${className}`}>{children}</section>;
}

/** An error, in words, with an icon. Never colour alone. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-destructive bg-card p-4 font-medium text-destructive">
      {children}
    </p>
  );
}

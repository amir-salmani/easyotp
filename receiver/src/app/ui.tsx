/** The few building blocks every screen uses. Tokens only, logical CSS only. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { COLOURS, THINGS, type Picture } from "../pictures";
import type { Lang } from "./i18n";

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

/** The colour and the thing, large, with both words: this is read aloud on a call. */
export function PictureCard({ picture, lang }: { picture: Picture; lang: Lang }) {
  const colour = COLOURS[picture.colour]!;
  const thing = THINGS[picture.thing]!;
  const other: Lang = lang === "fa" ? "en" : "fa";
  return (
    <Card className="flex flex-col items-center gap-4">
      <div
        // The one place a colour is not a token: it is the content being compared.
        style={{ backgroundColor: colour.css }}
        className="flex size-44 items-center justify-center rounded-xl border-4 border-border text-8xl"
        role="img"
        aria-label={`${thing[lang]} ${colour[lang]}`}
      >
        <span aria-hidden>{thing.emoji}</span>
      </div>
      <p className="text-center text-3xl font-bold">
        {thing[lang]} · {colour[lang]}
      </p>
      <p className="text-center text-lg text-muted-foreground" lang={other} dir={other === "fa" ? "rtl" : "ltr"}>
        {thing[other]} · {colour[other]}
      </p>
    </Card>
  );
}

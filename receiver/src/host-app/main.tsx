import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import { HostApp } from "./HostApp";
import { loadNative } from "./native";
import { HOST_STRINGS } from "./strings";

const root = createRoot(document.getElementById("root")!);
const native = await loadNative();

root.render(
  <StrictMode>
    {native ? (
      <HostApp native={native} />
    ) : (
      // Opened somewhere other than inside the app, where there is no phone to talk to.
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6" role="alert">
        <p className="font-semibold">{HOST_STRINGS.fa.outside}</p>
        <p dir="ltr" lang="en">
          {HOST_STRINGS.en.outside}
        </p>
      </main>
    )}
  </StrictMode>,
);

// Drawn: a Host trying screens it fetched keeps them only once it hears this.
requestAnimationFrame(() => native?.ready?.());

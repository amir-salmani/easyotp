import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./globals.css";
import { shell } from "./shell";

/**
 * If a screen throws while drawing, React removes everything and leaves a
 * blank page. This puts words there instead, in both languages, since the
 * chosen language is part of what failed.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6" role="alert">
        <p className="font-semibold">برنامه به مشکلی خورد و نتوانست این صفحه را نشان دهد. آن را ببندید و دوباره باز کنید.</p>
        <p dir="ltr" lang="en">
          The app hit a problem and could not show this screen. Close it and open it again.
        </p>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);

// Inside the Android app the screens are already on the device, and a WebView
// would not let a service worker read them anyway.
if ("serviceWorker" in navigator && import.meta.env.PROD && !shell) {
  void navigator.serviceWorker.register("/sw.js");
}

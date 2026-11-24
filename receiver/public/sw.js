// The Receiver's service worker. It does two things. It lets the app open with
// no network: the screens are cached, and messages already received are in
// IndexedDB. And it says so when a bridge pushes to tell this device that a
// message is waiting (DECISIONS D30). It never touches a request to a bridge,
// and it never sees a message: the push it is woken by carries nothing.
const CACHE = "easyotp-shell-v2";
// Where the app leaves the one thing this worker needs to know: the language.
const PREFS = "easyotp-prefs";

/** The page, and every built file it names. Built files carry a hash in their name. */
async function cacheShell() {
  const cache = await caches.open(CACHE);
  const page = await fetch("/", { cache: "no-store" });
  if (!page.ok) throw new Error("shell unavailable");
  const html = await page.clone().text();
  await cache.put("/", page);
  const assets = [...new Set(html.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? [])];
  await cache.addAll([...assets, "/manifest.webmanifest", "/icons/icon-192.png"]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== PREFS).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // The page itself: the network's copy when it is a good one, so a new
  // version is picked up, and the cached copy otherwise. An error page from
  // the edge is never cached and never shown in place of the app.
  if (event.request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(event.request);
          if (!res.ok) throw new Error("not ok");
          // A new page names new files. Fetch them now, while there is a network.
          event.waitUntil(cacheShell().catch(() => undefined));
          return res;
        } catch {
          return (await caches.match("/")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Built files never change under the same name, so the cached one is right.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(caches.open(CACHE).then((c) => c.put(event.request, copy)));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Everything else (the manifest, the icons) can change under the same name:
  // the network first, the cache only when there is none.
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(event.request)) ?? Response.error()));
});

const WAITING = {
  // The push that wakes this worker is empty, so it cannot tell an SMS from a
  // call that is ringing. The words cover both.
  fa: { title: "پیامک یا تماس تازه", body: "برای دیدن آن EasyOTP را باز کنید." },
  en: { title: "A new SMS or call", body: "Open EasyOTP to see it." },
};

// A bridge says a message is waiting. A browser, an iPhone above all, takes
// the address away from an app that is pushed to and shows nothing, so every
// push is shown, even when the app happens to be open.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const stored = await caches.open(PREFS).then((c) => c.match("/lang")).then((r) => r?.text()).catch(() => undefined);
      const lang = stored === "en" ? "en" : "fa";
      await self.registration.showNotification(WAITING[lang].title, {
        body: WAITING[lang].body,
        // One notification, replaced by the next: three codes are not three alarms.
        tag: "easyotp",
        renotify: true,
        icon: "/icons/icon-192.png",
        lang,
        dir: lang === "fa" ? "rtl" : "ltr",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => (clients[0] ? clients[0].focus() : self.clients.openWindow("/"))),
  );
});

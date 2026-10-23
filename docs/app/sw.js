// Keeps the planner working with no internet, for venues with bad wifi.
// The first visit saves the page, the script, the styles, and the solver on
// this device. After that the saved copy opens at once. A new release
// changes this file, so the browser installs it and uses it from the next
// visit. Event data never passes
// through here: it stays in the page and in the files you save.

const CACHE = "rotation-optimizer-0.7.0-bd51e0eea9f1";
const FILES = ["./","index.html","app.js","style.css","highs.wasm","view.html","view.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("rotation-optimizer-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(req, { ignoreSearch: true, cacheName: CACHE }).then((saved) => saved || fetch(req)));
});

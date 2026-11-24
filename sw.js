/* Offline support for the installed app. Bump VERSION when you change any file. */
const VERSION = "ostatok-v1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./calc.js", "./storage.js", "./app.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Own files: network first (updates arrive), cache when offline.
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") return cache.match("./index.html");
    throw err;
  }
}

// Fonts and the Telegram script: serve the cached copy, refresh in the background.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => { if (res.ok || res.type === "opaque") cache.put(request, res.clone()); return res; })
    .catch(() => cached);
  return cached || refresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(request));
  else if (/fonts\.(googleapis|gstatic)\.com$|telegram\.org$/.test(url.hostname)) event.respondWith(staleWhileRevalidate(request));
});

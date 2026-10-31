// Offline support: keeps the app itself available without a connection. API calls always go to the network.
const VERSION = "ac-web-v1";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "js/app.js", "js/db.js", "js/image.js", "js/ai.js", "js/drive.js", "js/csv.js", "js/camera.js", "js/config.js",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === self.location.origin;
  const cdn = /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(url.host);
  if (!sameOrigin && !cdn) return;
  // Network first for the app (so updates arrive), cache as fallback when offline.
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(m => m || (sameOrigin ? caches.match("index.html") : Response.error())))
  );
});

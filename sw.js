// Caches the app shell (network-first so updates arrive) and the OCR engine (cache-first).
// Bill data is never touched here.
const SHELL = 'shell-v2', LIB = 'lib-v1';
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== LIB).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.origin === location.origin) {
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(SHELL).then(c => c.put(r, cp)); return res; }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('index.html'))));
  } else if (u.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(LIB).then(c => c.match(r).then(m => m || fetch(r).then(res => { c.put(r, res.clone()); return res; }))));
  }
});

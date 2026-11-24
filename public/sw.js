const shell = 'hunar-shell-v3';
const assets = ['/', '/index.html', '/styles.css', '/app.mjs', '/learn.mjs', '/auth.mjs', '/choices.mjs', '/icon.svg', '/icon-192.png', '/icon-512.png', '/app.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(shell).then(cache => cache.addAll(assets)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('hunar-shell-') && key !== shell).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/pack.json') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(shell).then(cache => cache.match('/'))));
  } else if (assets.includes(url.pathname)) {
    event.respondWith(caches.open(shell).then(async cache => {
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(url.pathname, response.clone());
        return response;
      } catch {
        return (await cache.match(url.pathname)) || Response.error();
      }
    }));
  }
});

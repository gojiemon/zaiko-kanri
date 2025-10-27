// 簡易オフラインキャッシュ（Cache First）
const CACHE_NAME = 'yogu-stock-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './env.js',
  './manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : undefined)))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // 同一オリジンのみキャッシュ。GAS等のクロスオリジンは素通し
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const resClone = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
      return res;
    }).catch(() => cached))
  );
});


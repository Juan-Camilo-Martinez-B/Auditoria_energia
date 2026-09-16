// sw.js
// Service Worker con estrategia Network First con fallback a Cache para offline (RT-6)
const CACHE_NAME = 'auditoria-energia-v2';
const RECURSOS_APP_SHELL = [
  '/',
  '/favicon.ico',
  '/workers/lector_worker.js',
  '/workers/shared_state.worker.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => caches.delete(key))
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Estrategia: Network First (ir a la red primero, y si falla por estar offline, usar cache)
  event.respondWith(
    fetch(event.request)
      .then((respuestaRed) => {
        if (respuestaRed && respuestaRed.status === 200) {
          const clon = respuestaRed.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clon));
        }
        return respuestaRed;
      })
      .catch(() => {
        return caches.match(event.request).then((resp) => {
          if (resp) return resp;
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }
        });
      })
  );
});

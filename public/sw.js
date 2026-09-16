// sw.js
// Service Worker para cachear el App Shell y permitir trabajo sin conexion (RT-6, RF-8)
// Justificacion: Un Web Worker o SharedWorker solo viven mientras haya una pagina viva procesando scripts;
// un Service Worker actua como un proxy de red a nivel de navegador y puede interceptar requests HTTP incluso sin conexion.

const CACHE_NAME = 'auditoria-energia-v1';
const RECURSOS_APP_SHELL = [
  '/',
  '/favicon.ico',
  '/workers/lector_worker.js',
  '/workers/shared_state.worker.js'
];

self.addEventListener('install', (event) => {
  console.log('[Service Worker] Instalando y cacheando App Shell...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(RECURSOS_APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activado y listo para interceptar peticiones offline.');
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Borrando cache viejo:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Estrategia: Cache First con fallback a red
  event.respondWith(
    caches.match(event.request).then((respuestaCache) => {
      if (respuestaCache) {
        return respuestaCache;
      }
      return fetch(event.request).catch(() => {
        // Si no hay red y es navegacion principal, devolver el cache de raiz
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});

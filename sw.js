const CACHE_NAME = 'pwa-chat-v1';
const ASSETS = [
  '/pwa-chat-app/',
  '/pwa-chat-app/index.html',
  '/pwa-chat-app/style.css',
  '/pwa-chat-app/app.js',
  '/pwa-chat-app/manifest.json'
];
const API_CACHE = 'pwa-chat-api-v1';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== API_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname === '/pwa-chat-app/api/messages') {
    event.respondWith(networkFirstWithCache(request));
    return;
  }

  if (request.mode === 'navigate' || ASSETS.some(a => url.pathname === a)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirstWithCache(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  return cached || fetch(request);
}

async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(API_CACHE);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

self.addEventListener('sync', event => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncMessages());
  }
});

async function syncMessages() {
  const db = await openDB();
  const tx = db.transaction('outbox', 'readonly');
  const store = tx.objectStore('outbox');
  const messages = await getAll(store);

  for (const msg of messages) {
    try {
      const res = await fetch('/pwa-chat-app/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg)
      });
      if (res.ok) {
        const deleteTx = db.transaction('outbox', 'readwrite');
        deleteTx.objectStore('outbox').delete(msg.id);
        await done(deleteTx);

        const clients = await self.clients.matchAll();
        for (const client of clients) {
          client.postMessage({ type: 'message-synced', id: msg.id });
        }
      }
    } catch {
      break;
    }
  }
}

self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const options = {
      body: data.text,
      icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 rx=%2220%22 fill=%22%231a73e8%22/%3E%3Ctext x=%2250%22 y=%2268%22 font-size=%2255%22 text-anchor=%22middle%22 fill=%22white%22%3E💬%3C/text%3E%3C/svg%3E',
      badge: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 rx=%2220%22 fill=%22%231a73e8%22/%3E%3Ctext x=%2250%22 y=%2268%22 font-size=%2255%22 text-anchor=%22middle%22 fill=%22white%22%3E💬%3C/text%3E%3C/svg%3E'
    };
    event.waitUntil(self.registration.showNotification(data.sender || 'New message', options));
  } catch {
    // ignore malformed push
  }
});

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pwa-chat-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

/* msg2todo Web Push Service Worker */
self.addEventListener('push', (event) => {
  let data = { title: 'iTodo', body: '' };
  try {
    data = event.data ? event.data.json() : data;
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'iTodo', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'msg2todo-' + Date.now(),
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});

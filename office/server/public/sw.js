// AI 오피스 서비스 워커 — 홈 화면 설치와 푸시 알림만 한다. 화면·데이터는 캐시하지 않는다(항상 최신).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'AI 오피스', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'AI 오피스', {
    body: d.body || '', tag: d.tag || 'office', icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: d.url || '/' }, renotify: !!d.tag,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});

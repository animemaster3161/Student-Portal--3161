self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { /* use fallback content */ }
  const title = payload.title || 'Student Portal';
  const options = {
    body: payload.body || 'You have a new update.',
    icon: './favicon.ico',
    badge: './favicon.ico',
    tag: payload.tag || `portal-${Date.now()}`,
    // Request the platform's normal notification sound. The OS/browser still
    // controls volume, mute, focus modes, and whether sound is enabled.
    silent: false,
    data: { url: payload.url || './index.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL('./index.html', self.location.origin).href;
  try {
    const candidate = new URL(event.notification.data?.url || './index.html', self.location.origin);
    if (candidate.origin === self.location.origin && candidate.protocol === self.location.protocol) target = candidate.href;
  } catch { /* Keep the same-origin fallback target. */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

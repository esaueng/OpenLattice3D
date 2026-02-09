self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((clients) => {
    if (clients.length > 0) {
      clients[0].focus();
    } else {
      self.clients.openWindow('/');
    }
  }));
});

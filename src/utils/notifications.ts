export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (!('Notification' in window)) return null;
  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

export async function registerNotificationServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/notification-sw.js');
  } catch {
    // Ignore registration failures; fallback to page notifications.
  }
}

export async function sendNotification(
  title: string,
  options?: NotificationOptions
): Promise<boolean> {
  if (!('Notification' in window)) return false;
  const permission = await requestNotificationPermission();
  if (permission !== 'granted') return false;

  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, options);
      return true;
    } catch {
      // Fallback to page notifications.
    }
  }

  new Notification(title, options);
  return true;
}

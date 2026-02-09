export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (!('Notification' in window)) return null;
  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

let notificationRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

async function getNotificationRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (!notificationRegistrationPromise) {
    notificationRegistrationPromise = navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration) return registration;
      return navigator.serviceWorker.register('/notification-sw.js');
    }).catch(() => null);
  }
  return notificationRegistrationPromise;
}

export async function registerNotificationServiceWorker(): Promise<void> {
  await getNotificationRegistration();
}

export async function sendNotification(
  title: string,
  options?: NotificationOptions
): Promise<boolean> {
  if (!('Notification' in window)) return false;
  const permission = await requestNotificationPermission();
  if (permission !== 'granted') return false;

  const registration = await getNotificationRegistration();
  if (registration?.showNotification) {
    try {
      await registration.showNotification(title, options);
      return true;
    } catch {
      // Fallback to page notifications.
    }
  }

  new Notification(title, options);
  return true;
}

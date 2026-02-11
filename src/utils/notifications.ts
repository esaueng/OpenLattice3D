const SW_URL = '/notification-sw.js';
const SW_SCOPE = '/';

export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (!('Notification' in window)) return null;
  if (!isSecureContext) return null;
  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

let notificationRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

async function getNotificationRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !isSecureContext) return null;
  if (!notificationRegistrationPromise) {
    notificationRegistrationPromise = (async () => {
      try {
        const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);
        if (existing) return existing;
        const registered = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
        return registered;
      } catch {
        return null;
      }
    })();
  }
  return notificationRegistrationPromise;
}

async function getReadyNotificationRegistration(): Promise<ServiceWorkerRegistration | null> {
  const registration = await getNotificationRegistration();
  if (!registration) return null;

  if (registration.active) return registration;

  try {
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    return ready ?? registration;
  } catch {
    return registration;
  }
}

export async function registerNotificationServiceWorker(): Promise<void> {
  await getReadyNotificationRegistration();
}

export async function sendNotification(
  title: string,
  options?: NotificationOptions
): Promise<boolean> {
  if (!('Notification' in window) || !isSecureContext) return false;

  const permission = await requestNotificationPermission();
  if (permission !== 'granted') return false;

  const registration = await getReadyNotificationRegistration();
  if (registration?.showNotification) {
    try {
      await registration.showNotification(title, options);
      return true;
    } catch {
      // Fall through to page notification fallback.
    }
  }

  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

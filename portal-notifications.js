const DEFAULTS = {
  attendance: true,
  community: true,
  academics: true,
  emailDigest: false
};

let notificationAudioContext;
let lastNotificationSoundAt = 0;

function prepareNotificationAudio() {
  if (!('AudioContext' in window)) return;
  try {
    notificationAudioContext ||= new AudioContext();
    if (notificationAudioContext.state === 'suspended') {
      notificationAudioContext.resume().catch(() => {});
    }
  } catch { /* sound remains unavailable; visual notifications still work */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', prepareNotificationAudio, { once: true, capture: true });
  window.addEventListener('keydown', prepareNotificationAudio, { once: true });
}

export function playPortalNotificationSound() {
  if (!('AudioContext' in window)) return;
  const nowMs = Date.now();
  if (nowMs - lastNotificationSoundAt < 650) return;
  lastNotificationSoundAt = nowMs;

  try {
    notificationAudioContext ||= new AudioContext();
    const playChime = () => {
      const context = notificationAudioContext;
      const start = context.currentTime + 0.02;
      [880, 1174].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const toneStart = start + index * 0.12;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, toneStart);
        gain.gain.setValueAtTime(0.0001, toneStart);
        gain.gain.exponentialRampToValueAtTime(0.12, toneStart + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.24);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(toneStart);
        oscillator.stop(toneStart + 0.26);
      });
    };

    if (notificationAudioContext.state === 'suspended') {
      notificationAudioContext.resume().then(playChime).catch(() => {});
    } else {
      playChime();
    }
  } catch { /* sound is optional; do not block the notification */ }
}

function storageKey(userId) {
  return `mgm_portal_notifications_${userId || 'guest'}`;
}

export function getNotificationPreferences(userId) {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(storageKey(userId)) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveNotificationPreferences(userId, preferences) {
  localStorage.setItem(storageKey(userId), JSON.stringify(preferences));
}

export async function requestBrowserNotifications() {
  if (!window.isSecureContext || !('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

function decodeApplicationServerKey(value) {
  const padded = value + '='.repeat((4 - value.length % 4) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const key = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  if (key.length !== 65 || key[0] !== 4) throw new Error('The VAPID public key is invalid.');
  return key;
}

export async function subscribeToBrowserPush(applicationServerKey) {
  if (!window.isSecureContext) throw new Error('Background push requires a secure HTTPS context.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser does not support background push notifications.');
  }
  if (!applicationServerKey || applicationServerKey.includes('PASTE_')) {
    throw new Error('Add the VAPID public key to push-config.js first.');
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    throw new Error('Allow browser notifications before enabling background push.');
  }
  const expectedKey = decodeApplicationServerKey(applicationServerKey);
  const registration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const oldKey = subscription?.options?.applicationServerKey;
  const oldKeyBytes = oldKey ? new Uint8Array(oldKey) : null;
  if (subscription && oldKeyBytes && (oldKeyBytes.length !== expectedKey.length || oldKeyBytes.some((byte, index) => byte !== expectedKey[index]))) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: expectedKey
    });
  }
  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys?.auth) {
    throw new Error('The browser returned an incomplete push subscription.');
  }
  return serialized;
}

export function sendPortalNotification(userId, category, title, body) {
  const prefs = getNotificationPreferences(userId);
  if (!prefs[category]) return;
  if (document.visibilityState === 'visible') {
    playPortalNotificationSound();
    window.portalToast?.(`${title || 'Student Portal'}: ${body || 'You have a new update.'}`);
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = {
    body: body || '',
    icon: new URL('./favicon.ico', window.location.href).href,
    tag: `${category}-${Date.now()}`,
    silent: false,
    data: { url: new URL('./index.html', window.location.href).href }
  };
  const show = async () => {
    try {
      const registration = 'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistration('./')
        : null;
      if (registration) {
        await registration.showNotification(title || 'Student Portal', options);
        return;
      }
      const notification = new Notification(title || 'Student Portal', options);
      notification.onclick = () => { window.focus(); notification.close(); };
    } catch (error) {
      console.warn('Browser notification could not be shown:', error);
    }
  };
  void show();
}

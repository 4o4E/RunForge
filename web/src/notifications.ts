import { deleteWebPushSubscription, getWebPushPublicKey, saveWebPushSubscription } from './api';
import type { WebPushSubscriptionInput } from './api';

export type BrowserPushPermission = NotificationPermission | 'unsupported';

export interface BrowserPushState {
  supported: boolean;
  permission: BrowserPushPermission;
  subscribed: boolean;
  busy: boolean;
  error: string | null;
}

function localSecureHost(): boolean {
  return location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname === '[::1]'
    || location.hostname === '::1';
}

function secureContextError(): string | null {
  if (window.isSecureContext) return null;
  if (location.protocol === 'https:' || localSecureHost()) return null;
  return '移动端后台通知需要 HTTPS；通过电脑局域网 HTTP 地址访问时，浏览器不会开放 Push Service。';
}

function pushServiceErrorMessage(err: unknown): string {
  const error = err as Error;
  const raw = [error.name, error.message || String(err)].filter(Boolean).join(': ');
  if (/push service|registration failed|pushservice/i.test(raw)) {
    return [
      '浏览器 Push Service 注册失败。',
      '常见原因：当前页面不是 HTTPS、Android Chrome 无法连接系统推送服务/FCM，或 iOS 不是从主屏幕 PWA 打开。',
      `原始错误：${raw}`,
    ].join(' ');
  }
  return raw;
}

export function browserPushSupported(): boolean {
  return !secureContextError() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function currentBrowserPushPermission(): BrowserPushPermission {
  if (!browserPushSupported()) return 'unsupported';
  return Notification.permission;
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

function serializeSubscription(subscription: PushSubscription): WebPushSubscriptionInput {
  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  const keys = json.keys ?? {};
  if (!endpoint || !keys.p256dh || !keys.auth) {
    throw new Error('浏览器返回的推送订阅不完整');
  }
  return {
    endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  };
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  const secureError = secureContextError();
  if (secureError) throw new Error(secureError);
  if (!browserPushSupported()) throw new Error('当前浏览器不支持后台通知');
  try {
    await navigator.serviceWorker.register('/sw.js');
    return await navigator.serviceWorker.ready;
  } catch (err) {
    throw new Error(pushServiceErrorMessage(err));
  }
}

export async function readBrowserPushState(): Promise<BrowserPushState> {
  const secureError = secureContextError();
  if (secureError) {
    return { supported: false, permission: 'unsupported', subscribed: false, busy: false, error: secureError };
  }
  if (!browserPushSupported()) {
    return { supported: false, permission: 'unsupported', subscribed: false, busy: false, error: '当前浏览器不支持后台通知' };
  }
  const registration = await registerPushServiceWorker();
  const subscription = await registration.pushManager.getSubscription();
  return { supported: true, permission: Notification.permission, subscribed: Boolean(subscription), busy: false, error: null };
}

export async function enableBrowserPush(): Promise<BrowserPushState> {
  const secureError = secureContextError();
  if (secureError) throw new Error(secureError);
  if (!browserPushSupported()) {
    throw new Error('当前浏览器不支持后台通知');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { supported: true, permission, subscribed: false, busy: false, error: '浏览器通知权限未开启' };
  }

  const publicKey = await getWebPushPublicKey();
  if (!publicKey.enabled || !publicKey.publicKey) {
    throw new Error(publicKey.reason ?? '后端未启用 Web Push');
  }

  let registration = await registerPushServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  let subscription = existing;
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToArrayBuffer(publicKey.publicKey),
      });
    } catch (err) {
      // 部分移动浏览器在 service worker 刚安装完成时会短暂返回 push service error；
      // 强制刷新注册并等待 ready 后重试一次，避免把瞬时状态暴露给用户。
      await registration.update();
      registration = await navigator.serviceWorker.ready;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToArrayBuffer(publicKey.publicKey),
      }).catch((retryErr) => {
        throw new Error(pushServiceErrorMessage(retryErr ?? err));
      });
    }
  }
  await saveWebPushSubscription(serializeSubscription(subscription));
  return { supported: true, permission: Notification.permission, subscribed: true, busy: false, error: null };
}

export async function disableBrowserPush(): Promise<BrowserPushState> {
  if (!browserPushSupported()) {
    return { supported: false, permission: 'unsupported', subscribed: false, busy: false, error: '当前浏览器不支持后台通知' };
  }
  const registration = await registerPushServiceWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await deleteWebPushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return { supported: true, permission: Notification.permission, subscribed: false, busy: false, error: null };
}

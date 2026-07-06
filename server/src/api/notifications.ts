import { Router } from 'express';
import type { WebPushSubscriptionInput } from '@runforge/contracts';
import { store } from '../store/index.js';
import { getWebPushPublicKey } from '../notifications/push.js';

export const notificationsApi = Router();

function subscriptionFromBody(body: unknown): WebPushSubscriptionInput {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const keys = value.keys && typeof value.keys === 'object' ? value.keys as Record<string, unknown> : {};
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint.trim() : '';
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  if (!endpoint || !p256dh || !auth) {
    throw new Error('缺少浏览器推送订阅字段 endpoint / keys.p256dh / keys.auth');
  }
  return {
    endpoint,
    expirationTime: typeof value.expirationTime === 'number' ? value.expirationTime : null,
    keys: { p256dh, auth },
  };
}

notificationsApi.get('/push/public-key', async (_req, res) => {
  res.json(await getWebPushPublicKey());
});

notificationsApi.post('/push/subscriptions', async (req, res) => {
  try {
    const row = await store.upsertPushSubscription(subscriptionFromBody(req.body), req.get('user-agent') ?? null);
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

notificationsApi.delete('/push/subscriptions', async (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
  if (!endpoint) return res.status(400).json({ error: '缺少 endpoint' });
  await store.disablePushSubscription(endpoint, '用户已退订浏览器通知');
  res.status(204).send();
});

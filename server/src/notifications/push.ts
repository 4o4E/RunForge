import webPush from 'web-push';
import type { PushSubscription } from 'web-push';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { store as defaultStore } from '../store/index.js';
import type { PushSubscriptionRow, Store } from '../store/types.js';

const VAPID_SETTING_KEY = 'web_push_vapid';

interface VapidSetting {
  publicKey: string;
  privateKey: string;
}

interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  data: {
    url: string;
    runId: string;
    threadId: string;
  };
}

let cachedVapid: VapidSetting | null = null;
let vapidConfigured = false;

function textPreview(text: string, max = 140): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max - 1)}…`;
}

function rowToSubscription(row: PushSubscriptionRow): PushSubscription {
  return {
    endpoint: row.endpoint,
    expirationTime: row.expiration_time ? Date.parse(row.expiration_time) : null,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };
}

function isGoneSubscriptionError(err: unknown): boolean {
  const statusCode = typeof err === 'object' && err !== null && 'statusCode' in err
    ? Number((err as { statusCode?: unknown }).statusCode)
    : 0;
  return statusCode === 404 || statusCode === 410;
}

async function readOrCreateVapidSetting(): Promise<VapidSetting> {
  if (config.webPush.publicKey && config.webPush.privateKey) {
    return { publicKey: config.webPush.publicKey, privateKey: config.webPush.privateKey };
  }

  const { rows } = await query<{ value: VapidSetting }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [VAPID_SETTING_KEY],
  );
  const stored = rows[0]?.value;
  if (stored?.publicKey && stored?.privateKey) return stored;

  const generated = webPush.generateVAPIDKeys();
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO NOTHING`,
    [VAPID_SETTING_KEY, JSON.stringify(generated)],
  );
  const { rows: afterInsert } = await query<{ value: VapidSetting }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [VAPID_SETTING_KEY],
  );
  return afterInsert[0]?.value ?? generated;
}

export async function getWebPushPublicKey(): Promise<{ enabled: boolean; publicKey: string | null; reason?: string }> {
  try {
    const vapid = cachedVapid ?? await readOrCreateVapidSetting();
    cachedVapid = vapid;
    configureWebPush(vapid);
    return { enabled: true, publicKey: vapid.publicKey };
  } catch (err) {
    return { enabled: false, publicKey: null, reason: (err as Error).message };
  }
}

function configureWebPush(vapid: VapidSetting): void {
  if (vapidConfigured) return;
  webPush.setVapidDetails(config.webPush.subject, vapid.publicKey, vapid.privateKey);
  vapidConfigured = true;
}

async function ensureWebPushEnabled(): Promise<boolean> {
  const vapid = cachedVapid ?? await readOrCreateVapidSetting();
  cachedVapid = vapid;
  configureWebPush(vapid);
  return true;
}

async function sendPayload(row: PushSubscriptionRow, payload: PushPayload, store: Store): Promise<void> {
  try {
    await webPush.sendNotification(rowToSubscription(row), JSON.stringify(payload), { TTL: 60 * 60 * 24 });
  } catch (err) {
    if (isGoneSubscriptionError(err)) {
      await store.disablePushSubscription(row.endpoint, (err as Error).message);
      return;
    }
    console.warn(`Web Push 推送失败：${(err as Error).message}`);
  }
}

export async function notifyRunCompleted(runId: string, options: { store?: Store; output?: string } = {}): Promise<void> {
  const store = options.store ?? defaultStore;
  if (!await ensureWebPushEnabled()) return;

  const run = await store.getRun(runId);
  if (!run || run.status !== 'done') return;
  const thread = await store.getThread(run.thread_id);
  const subscriptions = await store.listEnabledPushSubscriptions();
  if (!subscriptions.length) return;

  const threadTitle = thread?.title?.trim() || thread?.fallback_title?.trim() || '对话';
  const payload: PushPayload = {
    title: 'RunForge 对话已完成',
    body: textPreview(options.output || run.output || threadTitle),
    tag: `run-completed:${run.id}`,
    url: `/chat/${encodeURIComponent(run.thread_id)}`,
    data: {
      url: `/chat/${encodeURIComponent(run.thread_id)}`,
      runId: run.id,
      threadId: run.thread_id,
    },
  };

  await Promise.all(subscriptions.map((row) => sendPayload(row, payload, store)));
}

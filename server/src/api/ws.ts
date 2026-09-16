import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import {
  externalSubscriptionSchema,
  type ExternalWebSocketFrame,
} from '@runforge/contracts';
import { runBus } from '../agent/bus.js';
import { shellBus } from '../shell/bus.js';
import { store } from '../store/index.js';
import { tokenFromWebSocketProtocols } from './auth.js';
import { looksLikeJwt, verifyAccessToken } from '../auth/jwt.js';
import type { AgentEvent } from '../agent/types.js';
import type { Scope } from '../store/types.js';
import { spaceAccess } from '../spaces/access.js';
import { externalRepository } from '../external/repository.js';
import type { ExternalRepository } from '../external/types.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { isExternalUuidToken } from '../external/token.js';

type ExternalEventStore = Pick<typeof store, 'getEventsAfterCursor'>;
type ExternalSocketRepository = Pick<ExternalRepository, 'authenticateToken' | 'getRun'>;

export interface WebSocketOptions {
  externalEventStore?: ExternalEventStore;
  externalRepository?: ExternalSocketRepository;
  externalPollIntervalMs?: number;
  externalSubscribeTimeoutMs?: number;
}

function externalTokenFromPath(rawUrl: string | undefined): string | null {
  const path = new URL(rawUrl ?? '', 'http://localhost').pathname;
  const match = /^\/api\/external\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

function sendExternalFrame(socket: WebSocket, frame: ExternalWebSocketFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function waitForSubscription(socket: WebSocket, timeoutMs: number): Promise<RawData> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('订阅消息超时'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    const onMessage = (data: RawData) => {
      cleanup();
      resolve(data);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('连接已关闭'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function handleExternalSocket(
  socket: WebSocket,
  req: IncomingMessage,
  options: WebSocketOptions,
): Promise<void> {
  const token = externalTokenFromPath(req.url);
  if (!token || !isExternalUuidToken(token)) {
    socket.close(1008, '外部访问凭证无效');
    return;
  }

  // 先注册首帧监听，避免客户端在 open 后立即发送 subscribe，而服务端仍在查 Token 时丢帧。
  const firstMessage = waitForSubscription(socket, options.externalSubscribeTimeoutMs ?? 10_000);
  const repository = options.externalRepository ?? externalRepository;
  const access = await repository.authenticateToken(hashOpaqueToken(token));
  if (!access) {
    socket.close(1008, '外部访问凭证无效');
    void firstMessage.catch(() => {});
    return;
  }

  let value: unknown;
  try {
    value = JSON.parse((await firstMessage).toString());
  } catch {
    sendExternalFrame(socket, { type: 'error', code: 'INVALID_SUBSCRIPTION', message: '订阅消息必须是有效 JSON' });
    socket.close(1008, '订阅消息无效');
    return;
  }
  const parsed = externalSubscriptionSchema.safeParse(value);
  if (!parsed.success) {
    sendExternalFrame(socket, { type: 'error', code: 'INVALID_SUBSCRIPTION', message: '订阅消息格式无效' });
    socket.close(1008, '订阅消息无效');
    return;
  }

  const subscription = parsed.data;
  const found = await repository.getRun(access, subscription.runId);
  if (!found) {
    socket.close(1008, '无权订阅该 run');
    return;
  }
  if (socket.readyState !== socket.OPEN) return;
  const scope: Scope = { tenantId: access.caller.tenantId, userId: found.executionUserId };
  const eventStore = options.externalEventStore ?? store;
  let cursor = subscription.cursor;
  let stopped = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let flushQueue = Promise.resolve();

  const cleanup = () => {
    stopped = true;
    if (wakeTimer) clearTimeout(wakeTimer);
    clearInterval(pollTimer);
    unsubscribe();
  };
  const flush = async () => {
    if (stopped || socket.readyState !== socket.OPEN) return;
    const rows = await eventStore.getEventsAfterCursor(scope, subscription.runId, cursor);
    for (const row of rows) {
      if (row.cursor <= cursor) continue;
      sendExternalFrame(socket, {
        type: 'event',
        runId: subscription.runId,
        cursor: row.cursor,
        event: row.event,
      });
      cursor = row.cursor;
      if (row.event.type === 'final' || row.event.type === 'error' || row.event.type === 'user_question') {
        socket.close(1000, 'run 已结束');
        return;
      }
    }
  };
  const queueFlush = () => {
    flushQueue = flushQueue.then(flush).catch(() => {
      if (!stopped) socket.close(1011, '事件读取失败');
    });
  };
  const wake = () => {
    if (stopped || wakeTimer) return;
    // executor 当前先发布内存事件、再落库；短暂延后读取，cursor 始终取数据库 events.id。
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      queueFlush();
    }, 10);
  };

  const unsubscribe = runBus.subscribe(subscription.runId, wake);
  const pollTimer = setInterval(queueFlush, options.externalPollIntervalMs ?? 500);
  socket.once('close', cleanup);
  socket.once('error', cleanup);
  sendExternalFrame(socket, { type: 'subscribed', runId: subscription.runId, cursor });
  queueFlush();
}

async function canViewThreadSpace(
  claims: Extract<NonNullable<ReturnType<typeof verifyAccessToken>>, { scope: 'tenant' }>,
  spaceId: string,
): Promise<boolean> {
  try {
    // JWT 中的 role 只作为身份结构传入；SpaceAccessService 会重新读取用户状态和角色，
    // 因此用户被禁用、降权或移出空间名单后，旧 token 也不能继续订阅事件。
    await spaceAccess.get({
      scope: 'tenant',
      tenantId: claims.tenant_id,
      userId: claims.sub,
      role: claims.role,
    }, spaceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * WebSocket 端点:
 * - ws://host/ws?runId=<id> 回放并推送 run 事件。
 * - ws://host/ws?runId=<id>&replay=none 仅推送新事件；前端已从 REST 恢复历史时使用。
 * - ws://host/ws?channel=shell&threadId=<id> 推送 thread 级 shell 事件。
 */
export function attachWebSocket(server: Server, options: WebSocketOptions = {}): void {
  const webWss = new WebSocketServer({ noServer: true });
  const externalWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '', 'http://localhost').pathname;
    if (path === '/ws') {
      webWss.handleUpgrade(req, socket, head, (client) => webWss.emit('connection', client, req));
      return;
    }
    if (externalTokenFromPath(req.url) !== null) {
      externalWss.handleUpgrade(req, socket, head, (client) => externalWss.emit('connection', client, req));
      return;
    }
    socket.destroy();
  });

  externalWss.on('connection', (socket, req) => {
    void handleExternalSocket(socket, req, options).catch(() => {
      if (socket.readyState === socket.OPEN) socket.close(1011, '外部 WebSocket 初始化失败');
    });
  });

  webWss.on('connection', async (socket, req) => {
    // WebSocket 只接受 access JWT(不再兼容老的静态共享 token，见
    // docs/multi-tenancy-design.md §4)：连接建立时机短，前端在建连前用
    // refresh token 换新 JWT 即可，不需要"两种凭证并存"的兼容路径。
    const token = tokenFromWebSocketProtocols(req.headers['sec-websocket-protocol']);
    const claims = looksLikeJwt(token) ? verifyAccessToken(token) : null;
    // run/shell 事件天生是租户用户的资源；系统管理员在 Phase 1 没有自己的 thread/run，
    // 不应该能借着一个合法的系统管理员 JWT 去订阅任意 runId/threadId 的事件流
    // (docs/multi-tenancy-design.md §4)。真正的"租户之间互相看不到彼此事件"还需要
    // runBus/shellBus 按 tenant_id 过滤，那是下一阶段的事，这里只堵住 scope 越界这一层。
    if (!claims || claims.scope !== 'tenant') {
      socket.close(1008, '访问 token 无效');
      return;
    }
    const scope: Scope = { tenantId: claims.tenant_id, userId: claims.sub };

    const url = new URL(req.url ?? '', 'http://localhost');
    const channel = url.searchParams.get('channel');
    const threadId = url.searchParams.get('threadId');
    const runId = url.searchParams.get('runId');
    const replay = url.searchParams.get('replay') ?? 'all';

    if (channel === 'shell') {
      if (!threadId) {
        socket.close(1008, '缺少 threadId 查询参数');
        return;
      }
      // 订阅前先按 scope 查一次归属，查不到就直接拒绝——这是完整的 {tenantId, userId}
      // 私有性规则，不只是租户边界(docs/multi-tenancy-design.md §7 的偏离记录)。
      const thread = await store.getThread(scope, threadId);
      if (!thread || !await canViewThreadSpace(claims, thread.space_id)) {
        socket.close(1008, '无权订阅该 thread');
        return;
      }

      const send = (event: AgentEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      };
      const unsubscribe = shellBus.subscribe(threadId, send);
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
      return;
    }

    if (!runId) {
      socket.close(1008, '缺少 runId 查询参数');
      return;
    }

    const run = await store.getRun(scope, runId);
    if (!run) {
      socket.close(1008, '无权订阅该 run');
      return;
    }
    const thread = await store.getThread(scope, run.thread_id);
    if (!thread || !await canViewThreadSpace(claims, thread.space_id)) {
      socket.close(1008, '无权订阅该 run');
      return;
    }

    const send = (event: AgentEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    // 新 run 订阅需要历史回放兜底；刷新/切换后的接管已经从 REST 恢复历史，
    // 此时只订阅后续 live 事件，避免完成 step 被重复播放。
    if (replay !== 'none') {
      try {
        for (const e of await store.getEvents(scope, runId)) send(e);
      } catch {
        /* 忽略回放失败 */
      }
    }

    const unsubscribe = runBus.subscribe(runId, (event) => {
      send(event);
      if (event.type === 'final' || event.type === 'error' || event.type === 'user_question') {
        socket.close(1000, 'run 已结束');
      }
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}

import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { runBus } from '../agent/bus.js';
import { shellBus } from '../shell/bus.js';
import { store } from '../store/index.js';
import { tokenFromWebSocketProtocols } from './auth.js';
import { looksLikeJwt, verifyAccessToken } from '../auth/jwt.js';
import type { AgentEvent } from '../agent/types.js';
import type { Scope } from '../store/types.js';

/**
 * WebSocket 端点:
 * - ws://host/ws?runId=<id> 回放并推送 run 事件。
 * - ws://host/ws?runId=<id>&replay=none 仅推送新事件；前端已从 REST 恢复历史时使用。
 * - ws://host/ws?channel=shell&threadId=<id> 推送 thread 级 shell 事件。
 */
export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (socket, req) => {
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
      if (!thread) {
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

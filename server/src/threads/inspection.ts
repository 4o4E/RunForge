import type { ThreadInspection } from '@runforge/contracts';
import { query } from '../db/pool.js';
import { resolveWorkspaceRootForThread } from '../files/workspaceRoot.js';
import { getSystemToolSettings } from '../settings.js';
import { store } from '../store/index.js';
import { MemoryStore } from '../store/memoryStore.js';
import { scanStoragePath } from '../usage/service.js';
import type { ThreadReadResolution } from './readAccess.js';

function excerpt(content: string): string {
  let end = 0;
  for (let count = 0; count < 240 && end < content.length; count += 1) {
    end += (content.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return content.slice(0, end);
}

async function firstUserMessages(access: ThreadReadResolution): Promise<ThreadInspection['userMessages']> {
  const { thread, executionScope } = access;
  if (store instanceof MemoryStore) {
    // 离线模式复用内存 Store 的真实消息投影；其元数据接口不支持有界读取，不能用于验证 PG 查询性能。
    const messages = await store.loadThreadMessageMetadata(executionScope, thread.id, { runId: thread.active_run_id });
    return messages
      .filter((message) => message.role === 'user')
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
      .slice(0, 3)
      .map((message) => ({ content: excerpt(message.content ?? ''), createdAt: message.created_at }));
  }

  // 与历史视图保持同一活动分支；截取和条数限制在数据库内完成，不读取整段对话或 source_ref。
  const result = await query<{ content: string; created_at: Date }>(`
    WITH RECURSIVE target AS (
      SELECT id, active_run_id FROM threads
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND space_id = $4
    ), branch AS (
      SELECT r.id, r.parent_run_id FROM runs r JOIN target t ON r.thread_id = t.id
      WHERE t.active_run_id IS NULL OR r.id = t.active_run_id
      UNION
      SELECT r.id, r.parent_run_id FROM runs r
      JOIN branch b ON r.id = b.parent_run_id
      JOIN target t ON r.thread_id = t.id
    )
    SELECT LEFT(COALESCE(m.content, ''), 240) AS content, m.created_at
    FROM messages m JOIN branch b ON b.id = m.run_id
    WHERE m.thread_id = $1 AND m.role = 'user'
    ORDER BY m.created_at, m.id LIMIT 3
  `, [thread.id, executionScope.tenantId, executionScope.userId, thread.space_id]);
  return result.rows.map((message) => ({ content: message.content, createdAt: message.created_at.toISOString() }));
}

/** 只能接收完成 threadReadAccess 授权的结果；解析执行归属仅用于读取，不赋予任何写权限。 */
export async function inspectThread(access: ThreadReadResolution): Promise<ThreadInspection> {
  const { workspaceRoot } = await getSystemToolSettings();
  // 复用现行目录规则：只统计当前 /w/{space}/c/{thread}，不搬迁或合并旧工作目录。
  const { root } = resolveWorkspaceRootForThread(access.thread, workspaceRoot);
  const [storage, userMessages] = await Promise.all([scanStoragePath(root), firstUserMessages(access)]);
  return { threadId: access.thread.id, storage, userMessages };
}

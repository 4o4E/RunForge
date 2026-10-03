import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const PREPARED_MIGRATION = '20260930010000_step_aggregate_metadata_trace';
const { Client } = pg;

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const client = new Client({ connectionString: process.env.DATABASE_URL });

function jsonArray(value) {
  return `CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END`;
}

async function tableExists(name) {
  const { rows } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`]);
  return rows[0].present;
}

async function columnsFor(name) {
  const { rows } = await client.query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
    [name],
  );
  return new Set(rows.map((row) => row.column_name));
}

async function alreadyPreparedByMigration() {
  if (!await tableExists('_prisma_migrations')) return false;
  const { rows } = await client.query(
    'SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL) AS applied',
    [PREPARED_MIGRATION],
  );
  return rows[0].applied;
}

async function attachOrphanedToolMessages() {
  const { rows } = await client.query(`
    SELECT tool.id,
      count(owner_call.value)::integer AS matches,
      max(assistant.step_id) FILTER (WHERE owner_call.value IS NOT NULL) AS step_id
    FROM messages tool
    LEFT JOIN messages assistant ON assistant.run_id = tool.run_id AND assistant.role = 'assistant'
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(assistant.tool_calls) = 'array' THEN assistant.tool_calls ELSE '[]'::jsonb END
    ) AS owner_call(value) ON owner_call.value ->> 'id' = tool.tool_call_id
    WHERE tool.role = 'tool' AND tool.step_id IS NULL
    GROUP BY tool.id
  `);
  const unresolved = rows.filter((row) => row.matches !== 1 || !row.step_id);
  if (unresolved.length) {
    throw new Error(
      `有 ${unresolved.length} 条 step_id 为空的工具消息无法唯一归属：` +
      unresolved.map((row) => `${row.id}(${row.matches} 个匹配)`).join(', '),
    );
  }
  if (!rows.length) return 0;

  const { rowCount } = await client.query(`
    UPDATE messages tool SET step_id = owner.step_id
    FROM (
      SELECT tool.id, max(assistant.step_id) AS step_id
      FROM messages tool
      JOIN messages assistant ON assistant.run_id = tool.run_id AND assistant.role = 'assistant'
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(assistant.tool_calls) = 'array' THEN assistant.tool_calls ELSE '[]'::jsonb END
      ) AS tool_call(value)
      WHERE tool.role = 'tool' AND tool.step_id IS NULL AND tool_call.value ->> 'id' = tool.tool_call_id
      GROUP BY tool.id
      HAVING count(*) = 1 AND max(assistant.step_id) IS NOT NULL
    ) owner
    WHERE tool.id = owner.id
  `);
  if (rowCount !== rows.length) throw new Error('工具消息所属 step 回填数量与唯一匹配数量不一致');
  return rowCount;
}

function runMetadataQuery({ hasEvents, runColumns, hasRunInputs }) {
  const runtimeState = runColumns.has('runtime_state') ? `COALESCE(r.runtime_state, '{}'::jsonb)` : `'{}'::jsonb`;
  const stateArray = (key) => jsonArray(`(${runtimeState} -> '${key}')`);
  const eventList = (eventType, idField) => hasEvents
    ? `SELECT e.data ->> '${idField}' AS id FROM events e WHERE e.run_id = r.id AND e.type = '${eventType}' AND e.data ->> '${idField}' IS NOT NULL`
    : 'SELECT NULL::text AS id WHERE false';
  const messageActivationList = (eventType, idField) => {
    const toolName = eventType === 'skill_activated' ? 'skill_activate' : 'mcp_activate';
    const successReceipt = eventType === 'skill_activated'
      ? `(tr.content LIKE '当前 run 的 Skill 激活结果 / Skill activation result for the current run:%'
          OR tr.content LIKE '已激活 Skill / Activated Skill:%'
          OR tr.content LIKE '已激活 skill %')`
      : `(tr.content LIKE '已激活 MCP %' OR tr.content LIKE 'MCP % 已在当前 run 激活，共 %')`;
    return `SELECT CASE
        WHEN jsonb_typeof(tool_call.value -> 'arguments') = 'object' THEN tool_call.value -> 'arguments' ->> 'id'
        WHEN jsonb_typeof(tool_call.value -> 'arguments') = 'string'
          THEN (tool_call.value ->> 'arguments')::jsonb ->> 'id'
        ELSE NULL
      END AS id
      FROM messages a
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.tool_calls) = 'array' THEN a.tool_calls ELSE '[]'::jsonb END
      ) AS tool_call(value)
      JOIN messages tr ON tr.run_id = a.run_id AND tr.role = 'tool' AND tr.tool_call_id = tool_call.value ->> 'id'
      WHERE a.run_id = r.id AND a.role = 'assistant' AND tool_call.value ->> 'name' = '${toolName}'
        AND ${successReceipt}
        AND CASE
          WHEN jsonb_typeof(tool_call.value -> 'arguments') = 'object' THEN tool_call.value -> 'arguments' ->> 'id'
          WHEN jsonb_typeof(tool_call.value -> 'arguments') = 'string'
            THEN (tool_call.value ->> 'arguments')::jsonb ->> 'id'
          ELSE NULL
        END IS NOT NULL`;
  };
  const runtimeIds = (key, eventType, idField) => `(
    SELECT COALESCE(jsonb_agg(to_jsonb(ids.id) ORDER BY ids.id), '[]'::jsonb)
    FROM (
      SELECT value AS id FROM jsonb_array_elements_text(${stateArray(key)})
      UNION
      ${eventList(eventType, idField)}
      UNION
      ${messageActivationList(eventType, idField)}
    ) ids
  )`;
  const rejectedEvents = hasEvents
    ? `SELECT e.data ->> 'model' AS id FROM events e WHERE e.run_id = r.id AND e.type = 'media_downgrade' AND e.data ->> 'reason' = 'provider_rejected' AND e.data ->> 'model' IS NOT NULL`
    : 'SELECT NULL::text AS id WHERE false';
  const appliedVersion = runColumns.has('runtime_state')
    ? `GREATEST(COALESCE((${runtimeState} ->> 'lastAppliedExternalInputVersion')::integer, 0), ${hasRunInputs ? "COALESCE((SELECT MAX(ri.version) FROM run_inputs ri WHERE ri.run_id = r.id AND ri.status = 'applied'), 0)" : '0'})`
    : hasRunInputs
      ? `COALESCE((SELECT MAX(ri.version) FROM run_inputs ri WHERE ri.run_id = r.id AND ri.status = 'applied'), 0)`
      : '0';
  const pendingColumn = runColumns.has('pending_interaction') ? 'r.pending_interaction' : 'NULL::jsonb';
  const eventPending = hasEvents
    ? `(
      SELECT CASE
        WHEN jsonb_typeof(e.data -> 'spec') = 'object' THEN e.data -> 'spec'
        WHEN e.data ->> 'question' IS NOT NULL THEN jsonb_build_object(
          'question', e.data ->> 'question', 'mode', 'text', 'options', '[]'::jsonb,
          'allowCustom', true, 'required', true
        )
      END
      FROM events e
      WHERE e.run_id = r.id AND e.type = 'user_question'
      ORDER BY e.id DESC LIMIT 1
    )`
    : 'NULL::jsonb';
  const goalSource = runColumns.has('goal_state')
    ? `COALESCE(r.goal_state, ${hasEvents ? "(SELECT e.data -> 'goal' FROM events e WHERE e.run_id = r.id AND e.type = 'plan_update' ORDER BY e.id DESC LIMIT 1)" : 'NULL::jsonb'})`
    : hasEvents
      ? `(SELECT e.data -> 'goal' FROM events e WHERE e.run_id = r.id AND e.type = 'plan_update' ORDER BY e.id DESC LIMIT 1)`
      : 'NULL::jsonb';
  const goal = `CASE
    WHEN ${goalSource} IS NULL THEN NULL
    WHEN ${goalSource} ? 'phase' THEN ${goalSource}
    ELSE ${goalSource} || jsonb_build_object('phase', CASE WHEN r.status = 'done' THEN 'completed' ELSE 'working' END)
  END`;

  return `
    INSERT INTO "_runforge_step_migration_runs" (run_id, metadata)
    SELECT r.id,
      jsonb_strip_nulls(jsonb_build_object(
        'runtime', jsonb_build_object(
          'skillIds', ${runtimeIds('skillIds', 'skill_activated', 'skillId')},
          'mcpServerIds', ${runtimeIds('mcpServerIds', 'mcp_activated', 'serverId')},
          'rejectedImageModels', (
            SELECT COALESCE(jsonb_agg(to_jsonb(ids.id) ORDER BY ids.id), '[]'::jsonb)
            FROM (
              SELECT value AS id FROM jsonb_array_elements_text(${stateArray('rejectedImageModels')})
              UNION
              ${rejectedEvents}
            ) ids
          ),
          'lastAppliedExternalInputVersion', ${appliedVersion}
        ),
        'goal', ${goal},
        'pendingInteraction', CASE
          WHEN r.status = 'waiting_for_user' THEN COALESCE(${pendingColumn}, ${eventPending})
          ELSE NULL
        END,
        'context', jsonb_build_object('collapsed', COALESCE((
          SELECT jsonb_object_agg(m.id::text, m.collapsed)
          FROM messages m WHERE m.run_id = r.id AND m.collapsed IS NOT NULL
        ), '{}'::jsonb))
      ))
    FROM runs r
    ON CONFLICT (run_id) DO UPDATE SET metadata = EXCLUDED.metadata
  `;
}

function stepArchiveQuery({ hasEvents, hasMessageMediaRefs }) {
  const eventAggregation = hasEvents
    ? `
      SELECT e.run_id, e.step_id,
        string_agg(e.data ->> 'text', '' ORDER BY e.id) FILTER (WHERE e.type = 'reasoning') AS reasoning,
        string_agg(e.data ->> 'text', '' ORDER BY e.id) FILTER (WHERE e.type = 'llm_delta') AS output,
        (array_agg(e.data - 'type' - 'step' ORDER BY e.id DESC) FILTER (WHERE e.type = 'stream_stats'))[1] AS stream_stats,
        (array_agg(jsonb_strip_nulls(jsonb_build_object(
          'inputTokens', e.data -> 'inputTokens',
          'outputTokens', e.data -> 'outputTokens',
          'cachedInputTokens', e.data -> 'cachedInputTokens'
        )) ORDER BY e.id DESC) FILTER (WHERE e.type = 'usage_update'))[1] AS usage,
        (array_agg(e.data -> 'finishReason' ORDER BY e.id DESC)
          FILTER (WHERE e.type IN ('final', 'error') AND e.data -> 'finishReason' IS NOT NULL
            AND e.data -> 'finishReason' <> 'null'::jsonb))[1] AS finish_reason,
        (array_agg(e.data -> 'rawFinishReason' ORDER BY e.id DESC)
          FILTER (WHERE e.type IN ('final', 'error') AND e.data -> 'rawFinishReason' IS NOT NULL
            AND e.data -> 'rawFinishReason' <> 'null'::jsonb))[1] AS raw_finish_reason,
        (array_agg((e.data ->> 'startedAt')::timestamptz ORDER BY e.id) FILTER (WHERE e.type IN ('reasoning', 'reasoning_timing')))[1] AS reasoning_started_at,
        MIN(e.created_at) FILTER (WHERE e.type = 'step_start') AS step_started_at,
        MAX(e.created_at) FILTER (WHERE e.type IN ('reasoning', 'reasoning_timing', 'llm_delta', 'usage_update')) AS last_output_at,
        jsonb_agg(jsonb_build_object(
          'id', e.data ->> 'id',
          'name', e.data ->> 'name',
          'arguments', CASE
            WHEN jsonb_typeof(e.data -> 'args') = 'string' THEN e.data ->> 'args'
            ELSE COALESCE(e.data -> 'args', '{}'::jsonb)::text
          END
        ) ORDER BY e.id) FILTER (WHERE e.type = 'tool_call') AS tool_calls
      FROM events e
      GROUP BY e.run_id, e.step_id
    `
    : `
      SELECT NULL::text AS run_id, NULL::text AS step_id,
        NULL::text AS reasoning, NULL::text AS output, NULL::jsonb AS stream_stats,
        NULL::jsonb AS usage, NULL::jsonb AS finish_reason, NULL::jsonb AS raw_finish_reason,
        NULL::timestamptz AS reasoning_started_at,
        NULL::timestamptz AS step_started_at,
        NULL::timestamptz AS last_output_at,
        NULL::jsonb AS tool_calls
      WHERE false
    `;
  const mediaRefs = hasMessageMediaRefs ? "NULLIF(m.media_refs, '[]'::jsonb)" : 'NULL::jsonb';
  const eventJoin = hasEvents
    ? `LEFT JOIN events te ON te.run_id = m.run_id AND te.step_id = m.step_id AND te.type = 'tool_result' AND te.data ->> 'id' = m.tool_call_id`
    : '';
  const toolStartedAt = hasEvents ? "te.data ->> 'startedAt'" : 'NULL::text';
  const toolDuration = hasEvents ? "te.data -> 'durationMs'" : 'NULL::jsonb';
  const eventOnlyToolResults = hasEvents
    ? `
      SELECT e.run_id, e.step_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'toolCallId', e.data ->> 'id',
        'content', e.data ->> 'result',
        'createdAt', e.created_at,
        'startedAt', e.data ->> 'startedAt',
        'durationMs', e.data -> 'durationMs',
        'mediaRefs', e.data -> 'mediaRefs'
      )) ORDER BY e.id) AS tool_results
      FROM events e
      WHERE e.type = 'tool_result'
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.run_id = e.run_id AND m.role = 'tool' AND m.tool_call_id = e.data ->> 'id'
        )
      GROUP BY e.run_id, e.step_id
    `
    : `SELECT NULL::text AS run_id, NULL::text AS step_id, NULL::jsonb AS tool_results WHERE false`;
  const assistantMessages = `
    SELECT DISTINCT ON (m.run_id, m.step_id) m.run_id, m.step_id, m.id, m.content, m.tool_calls, m.provider_state, m.created_at
    FROM messages m
    WHERE m.role = 'assistant' AND m.step_id IS NOT NULL
    ORDER BY m.run_id, m.step_id, m.id DESC
  `;
  const toolMessages = `
    SELECT m.run_id, m.step_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'toolCallId', m.tool_call_id,
      'content', m.content,
      'createdAt', m.created_at,
      'startedAt', ${toolStartedAt},
      'durationMs', ${toolDuration},
      'mediaRefs', ${mediaRefs}
    )) ORDER BY m.id) AS tool_results
    FROM messages m ${eventJoin}
    WHERE m.role = 'tool' AND m.step_id IS NOT NULL AND m.tool_call_id IS NOT NULL
    GROUP BY m.run_id, m.step_id
  `;

  return `
    INSERT INTO "_runforge_step_migration_steps" (step_id, run_id, result, tool_results)
    WITH event_aggregate AS (${eventAggregation}),
    assistant_messages AS (${assistantMessages}),
    tool_messages AS (${toolMessages}),
    tool_events_without_messages AS (${eventOnlyToolResults}),
    successful_responses AS (
      SELECT DISTINCT ON (i.run_id, i.step_id) i.run_id, i.step_id, i.normalized_response, i.started_at, i.ended_at
      FROM provider_invocations i
      WHERE i.purpose = 'agent' AND i.status = 'success'
        AND i.normalized_response IS NOT NULL AND i.normalized_response <> 'null'::jsonb AND i.step_id IS NOT NULL
      ORDER BY i.run_id, i.step_id, i.ended_at DESC NULLS LAST, i.started_at DESC, i.id DESC
    ),
    sources AS (
      SELECT s.id AS step_id, s.run_id, s.created_at,
        a.id AS assistant_id, a.content AS assistant_content, a.tool_calls AS assistant_tool_calls,
        a.provider_state AS assistant_provider_state, a.created_at AS assistant_created_at,
        p.normalized_response AS response, p.started_at AS response_started_at, p.ended_at AS response_ended_at,
        e.reasoning, e.output AS event_output, e.stream_stats, e.usage AS event_usage,
        e.finish_reason AS event_finish_reason, e.raw_finish_reason AS event_raw_finish_reason,
        e.reasoning_started_at, e.step_started_at, e.last_output_at, e.tool_calls AS event_tool_calls,
        tm.tool_results AS message_tool_results, te.tool_results AS event_only_results,
        COALESCE(p.started_at, e.step_started_at) AS aggregate_started_at,
        COALESCE(p.ended_at, a.created_at, e.last_output_at) AS aggregate_ended_at
      FROM steps s
      LEFT JOIN assistant_messages a ON a.run_id = s.run_id AND a.step_id = s.id
      LEFT JOIN successful_responses p ON p.run_id = s.run_id AND p.step_id = s.id
      LEFT JOIN event_aggregate e ON e.run_id = s.run_id AND e.step_id = s.id
      LEFT JOIN tool_messages tm ON tm.run_id = s.run_id AND tm.step_id = s.id
      LEFT JOIN tool_events_without_messages te ON te.run_id = s.run_id AND te.step_id = s.id
    )
    SELECT c.step_id, c.run_id,
      CASE WHEN c.assistant_id IS NULL AND c.response IS NULL THEN NULL ELSE jsonb_build_object(
        'toolCalls', COALESCE(NULLIF(c.assistant_tool_calls, 'null'::jsonb), NULLIF(c.response -> 'toolCalls', 'null'::jsonb), c.event_tool_calls, '[]'::jsonb),
        'providerState', COALESCE(NULLIF(c.assistant_provider_state, 'null'::jsonb), NULLIF(c.response -> 'providerState', 'null'::jsonb)),
        'reasoning', COALESCE(c.response ->> 'reasoning', c.reasoning),
        'output', CASE WHEN c.assistant_id IS NOT NULL THEN c.assistant_content
          ELSE COALESCE(c.response ->> 'content', c.event_output) END,
        'usage', COALESCE(NULLIF(c.response -> 'usage', 'null'::jsonb), c.event_usage),
        'streamStats', c.stream_stats,
        'finishReason', COALESCE(NULLIF(c.response -> 'finishReason', 'null'::jsonb), c.event_finish_reason),
        'rawFinishReason', COALESCE(NULLIF(c.response -> 'rawFinishReason', 'null'::jsonb), c.event_raw_finish_reason),
        'startedAt', c.aggregate_started_at,
        'reasoningStartedAt', c.reasoning_started_at,
        'endedAt', c.aggregate_ended_at,
        'durationMs', CASE
          WHEN c.aggregate_started_at IS NOT NULL AND c.aggregate_ended_at IS NOT NULL
          THEN GREATEST(0, floor(extract(epoch FROM (c.aggregate_ended_at - c.aggregate_started_at)) * 1000)::bigint)
          ELSE NULL
        END
      ) END,
      (
        SELECT COALESCE(jsonb_agg(result.value ORDER BY result.value ->> 'createdAt', result.value ->> 'toolCallId'), '[]'::jsonb)
        FROM jsonb_array_elements(
          COALESCE(c.message_tool_results, '[]'::jsonb) || COALESCE(c.event_only_results, '[]'::jsonb)
        ) AS result(value)
      )
    FROM sources c
    ON CONFLICT (step_id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      result = EXCLUDED.result,
      tool_results = EXCLUDED.tool_results
  `;
}

async function prepare() {
  await client.connect();
  await client.query('BEGIN');
  try {
    if (await alreadyPreparedByMigration()) {
      await client.query('COMMIT');
      console.log('Step 迁移归档已由目标 migration 消费，跳过准备。');
      return;
    }
    const hasRuns = await tableExists('runs');
    const hasSteps = await tableExists('steps');
    if (!hasRuns || !hasSteps) {
      await client.query('COMMIT');
      console.log('数据库尚无 runs/steps，跳过 Step 迁移准备。');
      return;
    }

    const hasEvents = await tableExists('events');
    const runColumns = await columnsFor('runs');
    const messageColumns = await columnsFor('messages');
    const hasRunInputs = await tableExists('run_inputs');
    if (!await tableExists('messages') || !await tableExists('provider_invocations')) {
      throw new Error('Step 迁移准备需要 messages 与 provider_invocations 表');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS "_runforge_step_migration_runs" (
        run_id TEXT PRIMARY KEY,
        metadata JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "_runforge_step_migration_steps" (
        step_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        result JSONB,
        tool_results JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE IF NOT EXISTS "_runforge_step_migration_manifest" (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
        source TEXT NOT NULL CHECK (source IN ('events', 'messages_provider')),
        archived_run_count INTEGER NOT NULL,
        archived_step_count INTEGER NOT NULL,
        completed_step_count INTEGER NOT NULL,
        attached_tool_message_count INTEGER NOT NULL,
        prepared_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
      );
    `);
    const previousManifest = await client.query(
      'SELECT * FROM "_runforge_step_migration_manifest" WHERE singleton = true',
    );
    if (previousManifest.rows.length) {
      const manifest = previousManifest.rows[0];
      const [sourceRunCount, sourceStepCount, archivedRunCount, archivedStepCount] = await Promise.all([
        client.query('SELECT count(*)::integer AS count FROM runs'),
        client.query('SELECT count(*)::integer AS count FROM steps'),
        client.query('SELECT count(*)::integer AS count FROM "_runforge_step_migration_runs"'),
        client.query('SELECT count(*)::integer AS count, count(*) FILTER (WHERE result IS NOT NULL)::integer AS completed FROM "_runforge_step_migration_steps"'),
      ]);
      if (
        sourceRunCount.rows[0].count !== manifest.archived_run_count
        || sourceStepCount.rows[0].count !== manifest.archived_step_count
        || archivedRunCount.rows[0].count !== manifest.archived_run_count
        || archivedStepCount.rows[0].count !== manifest.archived_step_count
        || archivedStepCount.rows[0].completed !== manifest.completed_step_count
      ) {
        throw new Error('Step 迁移归档清单与归档行数不一致，拒绝覆盖已有归档');
      }
      await client.query('COMMIT');
      console.log(
        `复用已完成的 Step 迁移归档：来源 ${manifest.source}，${manifest.archived_run_count} 个 run，` +
        `${manifest.archived_step_count} 个 step，${manifest.completed_step_count} 个已完成聚合。`,
      );
      return;
    }

    const [unmanagedRunArchive, unmanagedStepArchive] = await Promise.all([
      client.query('SELECT count(*)::integer AS count FROM "_runforge_step_migration_runs"'),
      client.query('SELECT count(*)::integer AS count FROM "_runforge_step_migration_steps"'),
    ]);
    if (unmanagedRunArchive.rows[0].count || unmanagedStepArchive.rows[0].count) {
      throw new Error('发现没有完成清单的 Step 迁移归档，拒绝覆盖其唯一历史来源');
    }

    const attachedToolMessages = await attachOrphanedToolMessages();
    await client.query(runMetadataQuery({ hasEvents, runColumns, hasRunInputs }));
    await client.query(stepArchiveQuery({ hasEvents, hasMessageMediaRefs: messageColumns.has('media_refs') }));
    const [runCount, stepCount] = await Promise.all([
      client.query('SELECT count(*)::integer AS count FROM "_runforge_step_migration_runs"'),
      client.query('SELECT count(*)::integer AS count, count(*) FILTER (WHERE result IS NOT NULL)::integer AS completed FROM "_runforge_step_migration_steps"'),
    ]);
    await client.query(
      `INSERT INTO "_runforge_step_migration_manifest" (
        singleton, source, archived_run_count, archived_step_count, completed_step_count, attached_tool_message_count
      ) VALUES (true, $1, $2, $3, $4, $5)`,
      [
        hasEvents ? 'events' : 'messages_provider',
        runCount.rows[0].count,
        stepCount.rows[0].count,
        stepCount.rows[0].completed,
        attachedToolMessages,
      ],
    );
    await client.query('COMMIT');
    console.log(
      `Step 迁移归档已准备：${runCount.rows[0].count} 个 run 元数据，${stepCount.rows[0].count} 个 step，` +
      `${stepCount.rows[0].completed} 个已完成聚合，回填 ${attachedToolMessages} 条孤立工具消息；events ${hasEvents ? '可用' : '已不存在'}。`,
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

await prepare();

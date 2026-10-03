-- 已完成模型响应与工具结果以 step 聚合为唯一正文来源；messages 继续保留顺序索引和压缩索引。
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "messages" AS m
    JOIN "steps" AS s ON s."id" = m."step_id"
    WHERE s."result" IS NOT NULL
      AND m."role" = 'assistant'
      AND m."content" IS NOT NULL
      AND m."content" IS DISTINCT FROM (s."result" ->> 'output')
  ) THEN
    RAISE EXCEPTION 'Assistant message content differs from its completed step output';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "messages" AS m
    JOIN "steps" AS s ON s."id" = m."step_id"
    WHERE s."result" IS NOT NULL
      AND m."role" = 'tool'
      AND m."content" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(s."tool_results") AS result(value)
        WHERE result.value ->> 'toolCallId' = m."tool_call_id"
          AND result.value ->> 'content' IS NOT DISTINCT FROM m."content"
      )
  ) THEN
    RAISE EXCEPTION 'Tool message content is absent from its completed step results';
  END IF;
END
$migration$;

UPDATE "messages" AS m
SET "content" = NULL,
    "tool_calls" = NULL,
    "provider_state" = NULL,
    "media_refs" = NULL
FROM "steps" AS s
WHERE m."step_id" = s."id"
  AND s."result" IS NOT NULL
  AND m."role" IN ('assistant', 'tool');

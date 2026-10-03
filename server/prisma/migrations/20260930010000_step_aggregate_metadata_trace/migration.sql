ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{"runtime":{"skillIds":[],"mcpServerIds":[],"rejectedImageModels":[],"lastAppliedExternalInputVersion":0}}'::jsonb;

ALTER TABLE "steps"
  ADD COLUMN IF NOT EXISTS "tool_results" JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $migration$
DECLARE
  has_run_archive BOOLEAN;
  has_step_archive BOOLEAN;
  has_manifest BOOLEAN;
  archived_runs INTEGER;
  archived_steps INTEGER;
  archived_completed_steps INTEGER;
  actual_runs INTEGER;
  actual_steps INTEGER;
  actual_completed_steps INTEGER;
BEGIN
  has_run_archive := to_regclass('public._runforge_step_migration_runs') IS NOT NULL;
  has_step_archive := to_regclass('public._runforge_step_migration_steps') IS NOT NULL;
  has_manifest := to_regclass('public._runforge_step_migration_manifest') IS NOT NULL;

  IF has_run_archive OR has_step_archive OR has_manifest THEN
    IF NOT (has_run_archive AND has_step_archive AND has_manifest) THEN
      RAISE EXCEPTION 'Step migration archive is incomplete';
    END IF;

    SELECT archived_run_count, archived_step_count, completed_step_count
      INTO archived_runs, archived_steps, archived_completed_steps
    FROM "_runforge_step_migration_manifest"
    WHERE singleton = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Step migration archive manifest is missing';
    END IF;

    SELECT count(*)::integer INTO actual_runs FROM "_runforge_step_migration_runs";
    SELECT count(*)::integer,
           count(*) FILTER (WHERE result IS NOT NULL)::integer
      INTO actual_steps, actual_completed_steps
    FROM "_runforge_step_migration_steps";
    IF actual_runs <> archived_runs
      OR actual_steps <> archived_steps
      OR actual_completed_steps <> archived_completed_steps THEN
      RAISE EXCEPTION 'Step migration archive does not match its completion manifest';
    END IF;

    UPDATE "runs" AS r
    SET "metadata" =
      (COALESCE(a."metadata", '{}'::jsonb) || COALESCE(r."metadata", '{}'::jsonb))
      || jsonb_build_object(
        'runtime',
          (COALESCE(a."metadata" -> 'runtime', '{}'::jsonb) || COALESCE(r."metadata" -> 'runtime', '{}'::jsonb))
          || jsonb_build_object(
            'skillIds', CASE
              WHEN jsonb_typeof(r."metadata" #> '{runtime,skillIds}') = 'array'
                AND r."metadata" #> '{runtime,skillIds}' <> '[]'::jsonb
              THEN r."metadata" #> '{runtime,skillIds}'
              ELSE COALESCE(a."metadata" #> '{runtime,skillIds}', '[]'::jsonb)
            END,
            'mcpServerIds', CASE
              WHEN jsonb_typeof(r."metadata" #> '{runtime,mcpServerIds}') = 'array'
                AND r."metadata" #> '{runtime,mcpServerIds}' <> '[]'::jsonb
              THEN r."metadata" #> '{runtime,mcpServerIds}'
              ELSE COALESCE(a."metadata" #> '{runtime,mcpServerIds}', '[]'::jsonb)
            END,
            'rejectedImageModels', CASE
              WHEN jsonb_typeof(r."metadata" #> '{runtime,rejectedImageModels}') = 'array'
                AND r."metadata" #> '{runtime,rejectedImageModels}' <> '[]'::jsonb
              THEN r."metadata" #> '{runtime,rejectedImageModels}'
              ELSE COALESCE(a."metadata" #> '{runtime,rejectedImageModels}', '[]'::jsonb)
            END,
            'lastAppliedExternalInputVersion', GREATEST(
              COALESCE((r."metadata" #>> '{runtime,lastAppliedExternalInputVersion}')::integer, 0),
              COALESCE((a."metadata" #>> '{runtime,lastAppliedExternalInputVersion}')::integer, 0)
            )
          ),
        'context', jsonb_strip_nulls(
          COALESCE(a."metadata" -> 'context', '{}'::jsonb)
          || COALESCE(r."metadata" -> 'context', '{}'::jsonb)
          || jsonb_build_object(
            'collapsed', CASE
              WHEN jsonb_typeof(r."metadata" #> '{context,collapsed}') = 'object'
                AND r."metadata" #> '{context,collapsed}' <> '{}'::jsonb
              THEN r."metadata" #> '{context,collapsed}'
              ELSE a."metadata" #> '{context,collapsed}'
            END
          )
        )
      )
      || CASE
        WHEN r."metadata" -> 'goal' IS NULL OR r."metadata" -> 'goal' = 'null'::jsonb
        THEN CASE WHEN a."metadata" ? 'goal' THEN jsonb_build_object('goal', a."metadata" -> 'goal') ELSE '{}'::jsonb END
        ELSE '{}'::jsonb
      END
      || CASE
        WHEN r."metadata" -> 'pendingInteraction' IS NULL OR r."metadata" -> 'pendingInteraction' = 'null'::jsonb
        THEN CASE WHEN a."metadata" ? 'pendingInteraction' THEN jsonb_build_object('pendingInteraction', a."metadata" -> 'pendingInteraction') ELSE '{}'::jsonb END
        ELSE '{}'::jsonb
      END
    FROM "_runforge_step_migration_runs" AS a
    WHERE a."run_id" = r."id";
    UPDATE "steps" AS s
    SET "result" = CASE
          WHEN s."result" IS NULL THEN a."result"
          ELSE s."result" || jsonb_strip_nulls(jsonb_build_object(
            'toolCalls', CASE
              WHEN jsonb_typeof(s."result" -> 'toolCalls') = 'array' THEN s."result" -> 'toolCalls'
              ELSE a."result" -> 'toolCalls'
            END,
            'providerState', CASE
              WHEN s."result" -> 'providerState' IS NOT NULL
                AND s."result" -> 'providerState' <> 'null'::jsonb
              THEN s."result" -> 'providerState'
              ELSE a."result" -> 'providerState'
            END
          ))
        END,
        "tool_results" = CASE
          WHEN s."tool_results" IS NULL OR s."tool_results" = '[]'::jsonb
          THEN COALESCE(a."tool_results", '[]'::jsonb)
          ELSE s."tool_results"
        END,
        "completed_at" = COALESCE(s."completed_at", (a."result" ->> 'endedAt')::timestamptz)
    FROM "_runforge_step_migration_steps" AS a
    WHERE a."step_id" = s."id";
  ELSIF EXISTS (SELECT 1 FROM "runs")
    OR EXISTS (SELECT 1 FROM "steps")
    OR EXISTS (SELECT 1 FROM "messages")
    OR EXISTS (SELECT 1 FROM "provider_invocations") THEN
    RAISE EXCEPTION 'Non-empty database has no prepared Step migration archive';
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "steps"
    WHERE "result" IS NOT NULL AND jsonb_typeof("result" -> 'toolCalls') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION 'A completed step has no valid toolCalls aggregate';
  END IF;
END
$migration$;

ALTER TABLE "provider_attempts"
  DROP COLUMN IF EXISTS "raw_stream";

ALTER TABLE "runs"
  DROP COLUMN IF EXISTS "goal_state",
  DROP COLUMN IF EXISTS "runtime_state",
  DROP COLUMN IF EXISTS "pending_interaction";

DROP TABLE IF EXISTS "_runforge_step_migration_steps";
DROP TABLE IF EXISTS "_runforge_step_migration_runs";
DROP TABLE IF EXISTS "_runforge_step_migration_manifest";

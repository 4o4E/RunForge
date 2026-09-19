ALTER TABLE "steps"
  ADD COLUMN "context_snapshot" JSONB;

UPDATE "steps" AS "step"
SET "context_snapshot" = (
  SELECT "invocation"."logical_request" || jsonb_build_object('capturedAt', "invocation"."started_at")
  FROM "provider_invocations" AS "invocation"
  WHERE "invocation"."step_id" = "step"."id"
    AND "invocation"."purpose" = 'agent'
  ORDER BY "invocation"."started_at" DESC, "invocation"."id" DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM "provider_invocations" AS "invocation"
  WHERE "invocation"."step_id" = "step"."id"
    AND "invocation"."purpose" = 'agent'
);

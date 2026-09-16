ALTER TABLE "external_requests"
  ADD COLUMN "source_ref" JSONB NOT NULL DEFAULT '{}';

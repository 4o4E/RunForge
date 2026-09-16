ALTER TABLE "provider_attempts"
  ADD COLUMN "error_kind" TEXT;

ALTER TABLE "provider_attempts"
  ADD CONSTRAINT "provider_attempts_error_kind_check"
    CHECK (error_kind IS NULL OR error_kind IN ('http', 'transport', 'parse', 'runtime'));

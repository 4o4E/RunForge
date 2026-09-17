DO $$
DECLARE
  setting_row RECORD;
  provider_row RECORD;
  migrated_providers JSONB;
  migrated_provider JSONB;
  resolved_protocol TEXT;
  legacy_provider TEXT;
  legacy_flavor TEXT;
BEGIN
  FOR setting_row IN
    SELECT "tenant_id", "value"
    FROM "app_settings"
    WHERE "key" = 'llm.settings'
  LOOP
    IF jsonb_typeof(setting_row."value"->'providers') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'tenant % 的 llm.settings.providers 不是数组', setting_row."tenant_id";
    END IF;

    migrated_providers := '[]'::jsonb;
    FOR provider_row IN
      SELECT "value", "ordinality"
      FROM jsonb_array_elements(setting_row."value"->'providers') WITH ORDINALITY
    LOOP
      resolved_protocol := provider_row."value"->>'protocol';
      IF resolved_protocol IS NOT NULL THEN
        IF resolved_protocol NOT IN ('openai-responses', 'openai-chat', 'anthropic-messages') THEN
          RAISE EXCEPTION 'tenant % 的 LLM 供应商 % 使用未知协议 %',
            setting_row."tenant_id",
            COALESCE(provider_row."value"->>'id', provider_row."ordinality"::text),
            resolved_protocol;
        END IF;
      ELSE
        legacy_provider := provider_row."value"->>'provider';
        legacy_flavor := provider_row."value"->>'aisdkFlavor';
        resolved_protocol := CASE
          WHEN legacy_provider = 'openai-responses' THEN 'openai-responses'
          WHEN legacy_provider = 'openai-chat' THEN 'openai-chat'
          WHEN legacy_provider = 'anthropic' THEN 'anthropic-messages'
          WHEN legacy_provider = 'aisdk' AND legacy_flavor = 'openai' THEN 'openai-responses'
          WHEN legacy_provider = 'aisdk' AND legacy_flavor = 'openai-compatible' THEN 'openai-chat'
          WHEN legacy_provider = 'aisdk' AND legacy_flavor = 'anthropic' THEN 'anthropic-messages'
          ELSE NULL
        END;
        IF resolved_protocol IS NULL THEN
          RAISE EXCEPTION 'tenant % 的 LLM 供应商 % 无法从 provider=%、aisdkFlavor=% 转换协议',
            setting_row."tenant_id",
            COALESCE(provider_row."value"->>'id', provider_row."ordinality"::text),
            COALESCE(legacy_provider, '<null>'),
            COALESCE(legacy_flavor, '<null>');
        END IF;
      END IF;

      migrated_provider := provider_row."value"
        - 'provider'
        - 'aisdkFlavor'
        - 'reasoningTag'
        - 'discoveredModelCapabilities';
      migrated_provider := jsonb_set(
        migrated_provider,
        '{protocol}',
        to_jsonb(resolved_protocol),
        true
      );
      migrated_providers := migrated_providers || jsonb_build_array(migrated_provider);
    END LOOP;

    UPDATE "app_settings"
    SET "value" = jsonb_set(setting_row."value", '{providers}', migrated_providers, false),
        "updated_at" = CURRENT_TIMESTAMP
    WHERE "tenant_id" = setting_row."tenant_id"
      AND "key" = 'llm.settings';
  END LOOP;
END $$;

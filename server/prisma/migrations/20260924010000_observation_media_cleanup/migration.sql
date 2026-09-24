CREATE FUNCTION pg_temp.sanitize_media_jsonb(
  value jsonb,
  media_context boolean DEFAULT false,
  media_mime text DEFAULT NULL,
  field_name text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item record;
  child jsonb;
  result jsonb;
  local_mime text;
  local_media boolean;
  payload text;
  detected_mime text;
  padding integer;
  byte_count integer;
  match_parts text[];
  whole_match text;
  lines text[];
  line text;
  line_parts text[];
  rebuilt text;
  parsed jsonb;
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    payload := value #>> '{}';
    IF payload ~* '^data:[^;,]+(;[^,]*)?;base64,[A-Za-z0-9+/]*={0,2}$' THEN
      detected_mime := substring(payload FROM '^data:([^;,]+)');
      payload := substring(payload FROM 'base64,([A-Za-z0-9+/]*={0,2})$');
      padding := length(payload) - length(rtrim(payload, '='));
      byte_count := GREATEST(0, floor(length(payload) * 0.75)::integer - padding);
      RETURN to_jsonb(format('[媒体二进制已省略；类型=%s；字节数=%s]', detected_mime, byte_count));
    END IF;
    FOR match_parts IN
      SELECT regexp_matches(payload, 'data:([^;,[:space:]""]+)(;[^,[:space:]""]*)?;base64,([A-Za-z0-9+/]*={0,2})', 'gi')
    LOOP
      detected_mime := match_parts[1];
      padding := length(match_parts[3]) - length(rtrim(match_parts[3], '='));
      byte_count := GREATEST(0, floor(length(match_parts[3]) * 0.75)::integer - padding);
      whole_match := format('data:%s%s;base64,%s', detected_mime, COALESCE(match_parts[2], ''), match_parts[3]);
      payload := replace(payload, whole_match,
        format('[媒体二进制已省略；类型=%s；字节数=%s]', detected_mime, byte_count));
    END LOOP;
    IF media_context
       AND field_name ~* '^(data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)$'
       AND length(payload) >= 64
       AND payload ~ '^[A-Za-z0-9+/]+={0,2}$' THEN
      padding := length(payload) - length(rtrim(payload, '='));
      byte_count := GREATEST(0, floor(length(payload) * 0.75)::integer - padding);
      RETURN to_jsonb(format('[媒体二进制已省略%s；字节数=%s]',
        CASE WHEN media_mime IS NULL THEN '' ELSE format('；类型=%s', media_mime) END,
        byte_count));
    END IF;
    IF left(btrim(payload), 1) IN ('{', '[') THEN
      BEGIN
        parsed := payload::jsonb;
      EXCEPTION WHEN others THEN
        parsed := NULL;
      END;
      IF parsed IS NOT NULL THEN
        RETURN to_jsonb(pg_temp.sanitize_media_jsonb(parsed, media_context, media_mime)::text);
      END IF;
    END IF;
    IF payload ~ '(^|\n)[[:space:]]*data:[[:space:]]*[\{\[]' THEN
      lines := string_to_array(payload, E'\n');
      rebuilt := '';
      FOREACH line IN ARRAY lines LOOP
        line_parts := regexp_match(line, '^([[:space:]]*data:[[:space:]]*)(\{.*\}|\[.*\])([\r]?)$');
        IF line_parts IS NULL THEN
          rebuilt := rebuilt || line || E'\n';
        ELSE
          rebuilt := rebuilt || line_parts[1]
            || pg_temp.sanitize_media_jsonb(line_parts[2]::jsonb, false, NULL)::text
            || line_parts[3] || E'\n';
        END IF;
      END LOOP;
      IF right(payload, 1) <> E'\n' THEN rebuilt := left(rebuilt, length(rebuilt) - 1); END IF;
      RETURN to_jsonb(rebuilt);
    END IF;
    RETURN to_jsonb(payload);
  END IF;

  IF jsonb_typeof(value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(pg_temp.sanitize_media_jsonb(entry, media_context, media_mime)), '[]'::jsonb)
      INTO result
      FROM jsonb_array_elements(value) AS entries(entry);
    RETURN result;
  END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN value; END IF;

  local_mime := COALESCE(
    value->>'media_type', value->>'mime_type', value->>'mimeType',
    value->>'content_type', value->>'contentType', media_mime
  );
  local_media := media_context
    OR COALESCE(local_mime ~* '^(image|audio|video|application/(pdf|octet-stream)|multipart/)', false)
    OR COALESCE(value->>'type' ~* '^(image|input_image|output_image|audio|input_audio|output_audio|video|input_video|file|input_file|document|base64)$', false);
  result := '{}'::jsonb;
  FOR item IN SELECT key, val FROM jsonb_each(value) AS fields(key, val) LOOP
    child := pg_temp.sanitize_media_jsonb(
      item.val,
      local_media OR item.key ~* '^(image|audio|video|file|document|inline_data|input_image|input_audio|input_video)$',
      local_mime,
      item.key
    );
    result := result || jsonb_build_object(item.key, child);
  END LOOP;
  RETURN result;
END;
$$;

UPDATE steps
SET context_snapshot = pg_temp.sanitize_media_jsonb(context_snapshot)
WHERE context_snapshot::text ~* 'data:[^",]+;base64,|"(data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)":"[A-Za-z0-9+/]{64}';

UPDATE provider_invocations
SET logical_request = pg_temp.sanitize_media_jsonb(logical_request)
WHERE logical_request::text ~* 'data:[^",]+;base64,|"(data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)":"[A-Za-z0-9+/]{64}';

UPDATE provider_invocations
SET normalized_response = pg_temp.sanitize_media_jsonb(normalized_response)
WHERE normalized_response IS NOT NULL
  AND normalized_response::text ~* 'data:[^",]+;base64,|"(data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)":"[A-Za-z0-9+/]{64}';

UPDATE provider_attempts
SET request_body = pg_temp.sanitize_media_jsonb(request_body)
WHERE request_body::text ~* 'data:[^",]+;base64,|"(data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)":"[A-Za-z0-9+/]{64}';

UPDATE provider_attempts
SET raw_stream = pg_temp.sanitize_media_jsonb(to_jsonb(raw_stream)) #>> '{}'
WHERE raw_stream IS NOT NULL
  AND raw_stream ~* 'data:[^",]+;base64,|"(data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)":"[A-Za-z0-9+/]{64}';

UPDATE provider_attempts
SET normalized_response = pg_temp.sanitize_media_jsonb(normalized_response)
WHERE normalized_response IS NOT NULL
  AND normalized_response::text ~* 'data:[^",]+;base64,|"(data|bytes|payload|file|file_bytes|file_data|image|image_data|audio|audio_data|video|video_data)":"[A-Za-z0-9+/]{64}';

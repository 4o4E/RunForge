// OpenTelemetry GenAI tracing (Phase 4). Initializes a Node tracer provider so
// the AI SDK's `experimental_telemetry` spans (chat / tool calls) and our own
// `invoke_agent` / `execute_tool` spans are exported to any OTLP backend
// (Langfuse / Laminar / Jaeger). Disabled unless OTEL_ENABLED=true, so the
// default runtime is unaffected (zero dependencies loaded at call time).
//
// IMPORTANT: initTelemetry() must run before the AI SDK is used (the SDK reads
// the global tracer at call time), so index.ts calls it first thing.

import { trace, type Span, type Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { config } from './config.js';

let sdk: NodeSDK | null = null;

const TRACER_NAME = 'my-agent';

/** Whether tracing is active this process. */
export const telemetryEnabled = config.telemetry.enabled;

export function initTelemetry(): void {
  if (!config.telemetry.enabled || sdk) return;

  const processors: SpanProcessor[] = [];
  if (config.telemetry.otlpEndpoint) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${config.telemetry.otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
      ),
    );
  }
  // Fall back to console when no OTLP endpoint is set, so enabling telemetry
  // always surfaces something useful.
  if (config.telemetry.console || processors.length === 0) {
    processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.telemetry.serviceName }),
    spanProcessors: processors,
  });
  sdk.start();

  const shutdown = () => {
    sdk?.shutdown().catch(() => {}).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const target = config.telemetry.otlpEndpoint || 'console';
  console.log(`🔭 OpenTelemetry enabled → ${target}`);
}

export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside a span named `name` with `attributes`. When telemetry is
 * disabled the global tracer is a non-recording stub, so this stays cheap and
 * needs no separate code path. Records exceptions and re-throws so error spans
 * are captured.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

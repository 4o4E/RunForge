const DEFAULT_API_BASE = "http://localhost:8080/api/runtime";
const DEFAULT_CAPABILITY_API_BASE = "http://localhost:8080/api/runtime-capabilities";

function required(value, name) {
  // 读取必需配置，缺失时给出明确错误。
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`missing required environment variable: ${name}`);
}

function runtimeHeaders(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (process.env.RUNFORGE_STEP_ID) headers["X-RunForge-Step-Id"] = process.env.RUNFORGE_STEP_ID;
  return headers;
}

export async function getDatasourceCredential(options = {}) {
  const datasourceId = required(options.datasourceId ?? process.env.DATASOURCE_ID, "DATASOURCE_ID");
  const token = required(options.token ?? process.env.WORKLOAD_TOKEN, "WORKLOAD_TOKEN");
  const profile = options.profile ?? process.env.DATASOURCE_PROFILE ?? "readonly";
  const apiBase = (
    options.apiBase
    ?? process.env.RUNFORGE_RUNTIME_API_BASE
    ?? process.env.MY_AGENT_RUNTIME_API_BASE
    ?? DEFAULT_API_BASE
  ).replace(/\/+$/, "");

  const response = await fetch(`${apiBase}/datasources/${datasourceId}/credentials`, {
    method: "POST",
    headers: runtimeHeaders(token),
    body: JSON.stringify({ profile }),
  });

  if (!response.ok) {
    throw new Error(`credential request failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export const acquireDatasourceCredential = getDatasourceCredential;

export async function getRuntimeCapabilityCredential(capability, options = {}) {
  const token = required(options.token ?? process.env.WORKLOAD_TOKEN, "WORKLOAD_TOKEN");
  const apiBase = (
    options.apiBase
    ?? process.env.RUNFORGE_RUNTIME_CAPABILITIES_API_BASE
    ?? process.env.RUNFORGE_RUNTIME_API_BASE?.replace(/\/api\/runtime\/?$/, "/api/runtime-capabilities")
    ?? DEFAULT_CAPABILITY_API_BASE
  ).replace(/\/+$/, "");

  const response = await fetch(`${apiBase}/credentials`, {
    method: "POST",
    headers: runtimeHeaders(token),
    body: JSON.stringify({ capability }),
  });

  if (!response.ok) {
    throw new Error(`runtime capability credential request failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export function redactedCredential(credential) {
  // 仅用于调试展示；不要输出 password 和完整 connection。
  const { password, connection, ...safe } = credential;
  return safe;
}

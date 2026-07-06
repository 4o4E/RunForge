import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult, type Tool as McpSdkTool } from '@modelcontextprotocol/sdk/types.js';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import type { LlmTool } from '../llm/types.js';
import { getMcpSettings, type McpServerSettings, type McpSettings } from '../settings.js';
import { isImageMediaType, normalizeRemotePath, toRemotePath } from '../files/workspace.js';

export interface McpMappedTool {
  serverId: string;
  serverLabel: string;
  originalName: string;
  mappedName: string;
  description: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
}

interface ClientEntry {
  client: Client;
  signature: string;
}

interface RenderContext {
  workspaceRoot?: string;
  serverId?: string;
  toolName?: string;
  runId?: string;
  args?: Record<string, unknown>;
}

const TOOL_PREFIX = 'mcp__';
const TOOL_SEP = '__';
const clients = new Map<string, ClientEntry>();

export function mcpToolName(serverId: string, toolName: string): string {
  return `${TOOL_PREFIX}${serverId}${TOOL_SEP}${toolName}`;
}

export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith(TOOL_PREFIX)) return null;
  const rest = name.slice(TOOL_PREFIX.length);
  const sep = rest.indexOf(TOOL_SEP);
  if (sep <= 0 || sep >= rest.length - TOOL_SEP.length) return null;
  return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + TOOL_SEP.length) };
}

function configSignature(server: McpServerSettings): string {
  return JSON.stringify({
    url: server.url,
    bearerToken: server.bearerToken,
    headers: server.headers,
  });
}

function headersForServer(server: McpServerSettings): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of server.headers) {
    if (header.name.trim()) headers[header.name.trim()] = header.value;
  }
  if (server.bearerToken.trim() && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${server.bearerToken.trim()}`;
  }
  return headers;
}

async function closeEntry(serverId: string): Promise<void> {
  const existing = clients.get(serverId);
  if (!existing) return;
  clients.delete(serverId);
  await existing.client.close().catch(() => {});
}

async function connectServer(server: McpServerSettings): Promise<Client> {
  const signature = configSignature(server);
  const existing = clients.get(server.id);
  if (existing?.signature === signature) return existing.client;
  await closeEntry(server.id);

  const client = new Client({ name: 'RunForge', version: '0.1.0' }, { capabilities: {} });
  if (!server.url.trim()) throw new Error(`MCP server ${server.id} 缺少远程 MCP URL`);
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: headersForServer(server) },
  }), { timeout: server.timeoutMs });

  clients.set(server.id, { client, signature });
  return client;
}

function schemaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : { type: 'object' };
}

async function listServerTools(server: McpServerSettings): Promise<McpMappedTool[]> {
  if (!server.enabled) return [];
  const client = await connectServer(server);
  const tools: McpSdkTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: server.timeoutMs });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const allowed = new Set(server.allowedTools);
  return tools.map((tool) => ({
    serverId: server.id,
    serverLabel: server.label || server.id,
    originalName: tool.name,
    mappedName: mcpToolName(server.id, tool.name),
    description: [
      `[MCP: ${server.label || server.id}] ${tool.title || tool.name}`,
      tool.description ?? '',
    ].filter(Boolean).join('\n'),
    parameters: schemaObject(tool.inputSchema),
    enabled: allowed.has(tool.name),
  }));
}

export async function listMcpTools(settings?: McpSettings): Promise<McpMappedTool[]> {
  const mcpSettings = settings ?? await getMcpSettings();
  const settled = await Promise.allSettled(mcpSettings.servers.map((server) => listServerTools(server)));
  return settled.flatMap((item) => item.status === 'fulfilled' ? item.value : []);
}

export async function mcpToolSchemas(settings?: McpSettings): Promise<LlmTool[]> {
  const tools = await listMcpTools(settings);
  return tools
    .filter((tool) => tool.enabled)
    .map((tool) => ({
      name: tool.mappedName,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function extensionFromMimeType(mimeType: string): string {
  const type = mimeType.toLowerCase().split(';', 1)[0].trim();
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/svg+xml') return '.svg';
  if (type === 'image/avif') return '.avif';
  if (type === 'audio/mpeg') return '.mp3';
  if (type === 'audio/wav' || type === 'audio/x-wav') return '.wav';
  if (type === 'audio/ogg') return '.ogg';
  if (type === 'application/pdf') return '.pdf';
  return '.bin';
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[\\/]+/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return segment || 'file';
}

function preferredFileName(ctx: RenderContext, mimeType: string, index: number): string {
  const rawName = typeof ctx.args?.name === 'string' ? ctx.args.name : '';
  const baseName = safePathSegment(rawName ? basename(rawName) : `${ctx.toolName ?? 'mcp-file'}-${index + 1}`);
  return extname(baseName) ? baseName : `${baseName}${extensionFromMimeType(mimeType)}`;
}

async function uniqueRemotePath(root: string, remoteDir: string, fileName: string): Promise<string> {
  const parsedExt = extname(fileName);
  const stem = parsedExt ? fileName.slice(0, -parsedExt.length) : fileName;
  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? fileName : `${stem}-${index + 1}${parsedExt}`;
    const candidate = `${remoteDir}/${candidateName}`;
    const absolute = normalizeRemotePath(candidate, root);
    try {
      await stat(absolute);
    } catch {
      return candidate;
    }
  }
  return `${remoteDir}/${stem}-${Date.now()}${parsedExt}`;
}

async function saveMcpBlob(
  data: string,
  mimeType: string,
  index: number,
  ctx: RenderContext,
): Promise<{ remotePath: string; bytes: number } | null> {
  if (!ctx.workspaceRoot) return null;
  const root = ctx.workspaceRoot;
  const remoteDir = [
    'artifacts',
    'mcp',
    safePathSegment(ctx.runId ?? 'manual'),
    safePathSegment(ctx.serverId ?? 'server'),
    safePathSegment(ctx.toolName ?? 'tool'),
  ].join('/');
  const remotePath = await uniqueRemotePath(root, remoteDir, preferredFileName(ctx, mimeType, index));
  const absolute = normalizeRemotePath(remotePath, root);
  const buffer = Buffer.from(data, 'base64');
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer);
  return { remotePath: toRemotePath(absolute, root), bytes: buffer.length };
}

function renderSavedBlob(label: string, mimeType: string, saved: { remotePath: string; bytes: number } | null): string {
  if (!saved) return `[MCP 返回${label}: ${mimeType}，未配置 workspace，无法落盘]`;
  const link = `[${saved.remotePath}](${saved.remotePath})`;
  if (isImageMediaType(mimeType)) {
    return `MCP 返回图片已保存：${link} (${mimeType}, ${saved.bytes} bytes)\n\n![MCP 返回图片](${saved.remotePath})`;
  }
  return `MCP 返回${label}已保存：${link} (${mimeType}, ${saved.bytes} bytes)`;
}

async function renderContentItem(item: CallToolResult['content'][number], index: number, ctx: RenderContext): Promise<string> {
  if (item.type === 'text') return item.text;
  if (item.type === 'image') return renderSavedBlob('图片', item.mimeType, await saveMcpBlob(item.data, item.mimeType, index, ctx));
  if (item.type === 'audio') return renderSavedBlob('音频', item.mimeType, await saveMcpBlob(item.data, item.mimeType, index, ctx));
  if (item.type === 'resource_link') return `[MCP 返回资源链接: ${item.name} ${item.uri}]`;
  if (item.type === 'resource') {
    const resource = item.resource;
    if ('text' in resource) return `[MCP 返回资源 ${resource.uri}]\n${resource.text}`;
    const mimeType = resource.mimeType ?? 'application/octet-stream';
    const saved = await saveMcpBlob(resource.blob, mimeType, index, {
      ...ctx,
      args: { ...ctx.args, name: basename(resource.uri) || ctx.args?.name },
    });
    return renderSavedBlob(`二进制资源 ${resource.uri}`, mimeType, saved);
  }
  return JSON.stringify(item);
}

export async function renderToolResult(result: CallToolResult, ctx: RenderContext = {}): Promise<string> {
  const parts: string[] = [];
  for (let index = 0; index < result.content.length; index += 1) {
    parts.push(await renderContentItem(result.content[index], index, ctx));
  }
  if (result.structuredContent) {
    parts.push(`structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }
  const text = parts.join('\n\n').trim() || '(MCP 工具没有返回内容)';
  return result.isError ? `MCP 工具返回错误：\n${text}` : text;
}

export async function callMcpTool(
  mappedName: string,
  args: Record<string, unknown>,
  settings?: McpSettings,
  ctx: { workspaceRoot?: string; runId?: string } = {},
): Promise<{ text: string; serverId: string; toolName: string }> {
  const parsed = parseMcpToolName(mappedName);
  if (!parsed) throw new Error(`不是 MCP 工具名：${mappedName}`);
  const mcpSettings = settings ?? await getMcpSettings();
  const server = mcpSettings.servers.find((item) => item.id === parsed.serverId);
  if (!server || !server.enabled) throw new Error(`MCP server 未启用：${parsed.serverId}`);
  if (!server.allowedTools.includes(parsed.toolName)) throw new Error(`MCP 工具未允许：${parsed.serverId}/${parsed.toolName}`);

  const client = await connectServer(server);
  const rawResult = await client.callTool(
    { name: parsed.toolName, arguments: args },
    CallToolResultSchema,
    { timeout: server.timeoutMs },
  );
  const result = CallToolResultSchema.parse(rawResult) as CallToolResult;
  const text = await renderToolResult(result, {
    workspaceRoot: ctx.workspaceRoot,
    runId: ctx.runId,
    serverId: parsed.serverId,
    toolName: parsed.toolName,
    args,
  });
  return {
    serverId: parsed.serverId,
    toolName: parsed.toolName,
    text: text.length <= server.maxOutput ? text : `${text.slice(0, server.maxOutput)}\n…[MCP 工具结果已截断]…`,
  };
}

export async function probeMcpServer(server: McpServerSettings): Promise<McpMappedTool[]> {
  return listServerTools({ ...server, enabled: true });
}

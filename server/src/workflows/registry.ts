import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type WorkflowSource = 'builtin' | 'user';

export interface WorkflowIndexItem {
  id: string;
  name: string;
  description: string;
  source: WorkflowSource;
  root: string;
  readonly: boolean;
  hash: string;
}

export interface WorkflowReadResult {
  workflow: WorkflowIndexItem;
  body: string;
}

interface Frontmatter {
  name: string;
  description: string;
}

const WORKFLOW_NAME_RE = /^[a-z0-9-]+$/;
const BUILTIN_SOURCE_ROOT = resolve(process.cwd(), 'src/workflows/builtin');

function parseFrontmatter(content: string, file: string): { frontmatter: Frontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) throw new Error(`${file} 缺少 WORKFLOW.md YAML frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) fields.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!WORKFLOW_NAME_RE.test(name)) throw new Error(`${file} 的 workflow name 无效: ${name}`);
  if (!description) throw new Error(`${file} 缺少 description`);
  return { frontmatter: { name, description }, body: match[2] };
}

function stripInternalComments(content: string): string {
  return content.replace(/<!--\s*@internal[\s\S]*?-->\n?/g, '');
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function hashDir(root: string): Promise<string> {
  const parts: string[] = [];
  async function walk(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const rel = path.slice(root.length + 1);
        parts.push(`${rel}\0${await readFile(path, 'utf8').catch(() => '')}`);
      }
    }
  }
  await walk(root);
  return hashContent(parts.join('\0'));
}

async function sanitizeWorkflowDir(sourceRoot: string, targetRoot: string): Promise<void> {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (src) => basename(src) !== 'openai.yaml',
  });

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name)) {
        await writeFile(path, stripInternalComments(await readFile(path, 'utf8')), 'utf8');
      }
    }
  }
  await walk(targetRoot);
}

async function readWorkflowIndexItem(root: string, source: WorkflowSource, readonly: boolean): Promise<WorkflowIndexItem> {
  const workflowPath = join(root, 'WORKFLOW.md');
  const { frontmatter } = parseFrontmatter(await readFile(workflowPath, 'utf8'), workflowPath);
  if (frontmatter.name !== basename(root)) {
    throw new Error(`${workflowPath} 的 name 必须和目录名一致`);
  }
  return {
    id: `${source}:${frontmatter.name}`,
    name: frontmatter.name,
    description: frontmatter.description,
    source,
    root,
    readonly,
    hash: await hashDir(root),
  };
}

async function listWorkflowDirs(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, 'WORKFLOW.md'))) dirs.push(path);
  }
  return dirs.sort();
}

export async function loadWorkflowIndex(workspaceRoot: string, builtinSourceRoot = BUILTIN_SOURCE_ROOT): Promise<WorkflowIndexItem[]> {
  const materializedBuiltinRoot = resolve(workspaceRoot, '.agents/workflows');
  await mkdir(materializedBuiltinRoot, { recursive: true });

  const builtinItems: WorkflowIndexItem[] = [];
  for (const sourceDir of await listWorkflowDirs(builtinSourceRoot)) {
    const targetDir = join(materializedBuiltinRoot, basename(sourceDir));
    await sanitizeWorkflowDir(sourceDir, targetDir);
    builtinItems.push(await readWorkflowIndexItem(targetDir, 'builtin', true));
  }

  const userRoot = resolve(workspaceRoot, '.workflows');
  const userItems = await Promise.all((await listWorkflowDirs(userRoot)).map((dir) => readWorkflowIndexItem(dir, 'user', false)));
  return [...userItems, ...builtinItems].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

export function selectWorkflow(workflows: WorkflowIndexItem[], nameOrId: string): WorkflowIndexItem | undefined {
  const wanted = nameOrId.trim();
  if (!wanted) return undefined;
  const exactId = workflows.find((workflow) => workflow.id === wanted);
  if (exactId) return exactId;
  const matches = workflows.filter((workflow) => workflow.name === wanted);
  return matches.find((workflow) => workflow.source === 'user') ?? matches[0];
}

export async function readWorkflow(workspaceRoot: string, nameOrId: string, builtinSourceRoot = BUILTIN_SOURCE_ROOT): Promise<WorkflowReadResult> {
  const workflows = await loadWorkflowIndex(workspaceRoot, builtinSourceRoot);
  const workflow = selectWorkflow(workflows, nameOrId);
  if (!workflow) throw new Error(`未找到 workflow: ${nameOrId}`);
  const workflowPath = join(workflow.root, 'WORKFLOW.md');
  const { body } = parseFrontmatter(await readFile(workflowPath, 'utf8'), workflowPath);
  return { workflow, body };
}

export function renderWorkflowCatalog(workflows: WorkflowIndexItem[]): string {
  if (!workflows.length) return '可用 Workflows / Available workflows: none';
  return [
    '可用 Workflows / Available workflows:',
    ...workflows.map((workflow) => `- ${workflow.name}: ${workflow.description}`),
  ].join('\n');
}

export function renderWorkflowSystemRules(): string {
  return `Workflow 使用规则 / Workflow usage rules:
- 初始 workflow 列表只用于路由和阶段选择；需要细节时调用 workflow_read。
- The initial workflow list is for routing and stage selection; call workflow_read for details.
- Workflow 是阶段协议，说明阶段目标、输入输出、gate、默认 skill 和 subagent 分工。
- A workflow is a stage protocol: stage goals, inputs, outputs, gates, default skills, and subagent delegation.
- 用户 workflow 放在 workspace 的 .workflows/<name>/WORKFLOW.md；内置 workflow 会物化到 .agents/workflows。
- User workflows live under .workflows/<name>/WORKFLOW.md; built-in workflows are materialized under .agents/workflows.
- 不要修改 .agents/workflows；如果用户要求新增或调整 workflow，写入 .workflows。
- Do not modify .agents/workflows; create or edit .workflows when the user asks for workflow changes.`;
}

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type SkillSource = 'builtin' | 'user';

export interface SkillIndexItem {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  root: string;
  readonly: boolean;
  allowedTools: string[];
  hash: string;
}

export interface SkillActivation {
  skill: SkillIndexItem;
  systemMessage: string;
}

interface Frontmatter {
  name: string;
  description: string;
  allowedTools: string[];
}

const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const BUILTIN_SOURCE_ROOT = resolve(process.cwd(), 'src/skills/builtin');

function unquoteScalar(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

function foldYamlBlock(lines: string[], folded: boolean): string {
  const normalized = lines.map((line) => line.replace(/^\s+/, '').trimEnd());
  if (!folded) return normalized.join('\n').trim();
  return normalized
    .join('\n')
    .split(/\n{2,}/)
    .map((part) => part.replace(/\n+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseFrontmatterFields(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length;) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const value = m[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      i += 1;
      while (i < lines.length && !/^([A-Za-z0-9_-]+):\s*/.test(lines[i])) {
        block.push(lines[i]);
        i += 1;
      }
      // skill 入口只需要 YAML 标量字段，支持 description: > 这类常见折叠写法。
      fields.set(key, foldYamlBlock(block, value.startsWith('>')));
      continue;
    }
    fields.set(key, unquoteScalar(value));
    i += 1;
  }
  return fields;
}

function parseFrontmatter(content: string, file: string): { frontmatter: Frontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) throw new Error(`${file} 缺少 SKILL.md YAML frontmatter`);
  const raw = match[1];
  const body = match[2];
  const fields = parseFrontmatterFields(raw);
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!SKILL_NAME_RE.test(name)) throw new Error(`${file} 的 skill name 无效: ${name}`);
  if (!description) throw new Error(`${file} 缺少 description`);
  const allowedTools = (fields.get('allowed-tools') ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { frontmatter: { name, description, allowedTools }, body };
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

async function sanitizeSkillDir(sourceRoot: string, targetRoot: string): Promise<void> {
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (src) => !src.includes(`${resolve(sourceRoot)}/agents/`) && basename(src) !== 'openai.yaml',
  });

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(md|txt|sh|py|mjs|js|ts|json|yaml|yml|sql)$/i.test(entry.name)) {
        await writeFile(path, stripInternalComments(await readFile(path, 'utf8')), 'utf8');
      }
    }
  }
  await walk(targetRoot);
}

async function readSkill(root: string, source: SkillSource, readonly: boolean): Promise<SkillIndexItem> {
  const skillPath = join(root, 'SKILL.md');
  const { frontmatter } = parseFrontmatter(await readFile(skillPath, 'utf8'), skillPath);
  if (frontmatter.name !== basename(root)) {
    throw new Error(`${skillPath} 的 name 必须和目录名一致`);
  }
  return {
    id: `${source}:${frontmatter.name}`,
    name: frontmatter.name,
    description: frontmatter.description,
    source,
    root,
    readonly,
    allowedTools: frontmatter.allowedTools,
    hash: await hashDir(root),
  };
}

async function listSkillDirs(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, 'SKILL.md'))) dirs.push(path);
  }
  return dirs.sort();
}

export async function loadSkillIndex(workspaceRoot: string, builtinSourceRoot = BUILTIN_SOURCE_ROOT): Promise<SkillIndexItem[]> {
  const materializedBuiltinRoot = resolve(workspaceRoot, '.agents/skills');
  await mkdir(materializedBuiltinRoot, { recursive: true });

  const builtinItems: SkillIndexItem[] = [];
  for (const sourceDir of await listSkillDirs(builtinSourceRoot)) {
    const targetDir = join(materializedBuiltinRoot, basename(sourceDir));
    await sanitizeSkillDir(sourceDir, targetDir);
    builtinItems.push(await readSkill(targetDir, 'builtin', true));
  }

  const userRoot = resolve(workspaceRoot, '.skills');
  const userItems = await Promise.all((await listSkillDirs(userRoot)).map((dir) => readSkill(dir, 'user', false)));
  return [...userItems, ...builtinItems].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

export function renderSkillCatalog(skills: SkillIndexItem[]): string {
  if (!skills.length) return '可用 Skills / Available skills: none';
  return [
    '可用 Skills / Available skills:',
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join('\n');
}

export function renderSkillSystemRules(): string {
  return `Skill 使用规则 / Skill usage rules:
- 初始 skill 列表只用于选择能力；需要某个 skill 时调用 skill_activate。
- The initial skill list is for routing; call skill_activate when a skill is needed.
- 激活 skill 后，你会看到该 skill 的 name、root 和 instructions。
- After a skill is activated, you will see its name, root, and instructions.
- Skill 正文里的相对路径都以该 skill 的 root 为基准解析。
- Resolve relative paths in skill instructions against that skill root.
- references、assets、scripts 都是 root 下的普通文件，可用文件工具或 shell 按需读取。
- references, assets, and scripts are normal files under root; inspect them with file tools or shell when needed.
- 不要修改 skill 目录本身；输出文件写到 workspace 的普通工作目录，除非用户明确要求编辑某个用户 skill。
- Do not modify skill directories; write outputs to normal workspace locations unless the user explicitly asks to edit a user skill.
- 脚本执行必须遵守工具策略、沙箱、网络开关和输出截断。
- Script execution must follow tool policy, sandboxing, network settings, and output limits.`;
}

export function selectSkill(skills: SkillIndexItem[], nameOrId: string): SkillIndexItem | undefined {
  const wanted = nameOrId.trim();
  if (!wanted) return undefined;
  const exactId = skills.find((skill) => skill.id === wanted);
  if (exactId) return exactId;
  const matches = skills.filter((skill) => skill.name === wanted);
  return matches.find((skill) => skill.source === 'user') ?? matches[0];
}

export async function activateSkill(workspaceRoot: string, nameOrId: string): Promise<SkillActivation> {
  const skills = await loadSkillIndex(workspaceRoot);
  const skill = selectSkill(skills, nameOrId);
  if (!skill) throw new Error(`未找到 skill: ${nameOrId}`);
  const skillPath = join(skill.root, 'SKILL.md');
  const { body } = parseFrontmatter(await readFile(skillPath, 'utf8'), skillPath);
  const systemMessage = [
    '已激活 Skill / Activated Skill:',
    `- name: ${skill.name}`,
    `- root: ${skill.root}`,
    '',
    '正文 / Instructions:',
    body.trim() || '（空正文）',
  ].join('\n');
  return { skill, systemMessage };
}

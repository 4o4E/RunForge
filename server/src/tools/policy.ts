// Tool sandbox / permission policy (Phase 6). A single enforcement point that
// every tool call passes through (see registry.runTool). It provides the trusted
// boundary for "safely calling system capabilities":
//
//   - allow/deny lists           (honored in any mode)
//   - output size cap            (honored in any mode)
//   - filesystem path confinement (enforce mode)
//   - shell enable + command denylist (enforce mode)
//   - network switch for web tools (enforce mode)
//
// Container-level isolation (E2B / microsandbox / Docker) is a complementary,
// heavier follow-up; this layer is process-local, dependency-free and always on
// the call path so it composes with whatever isolation is added later.

import { isAbsolute, relative, resolve } from 'node:path';

export interface ToolPolicyConfig {
  sandbox: 'off' | 'enforce';
  workspaceRoot: string;
  allow: string[];
  deny: string[];
  shellEnabled: boolean;
  shellDeny: string[];
  network: 'enabled' | 'disabled';
  maxOutput: number;
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

type ToolKind = 'fs-read' | 'fs-write' | 'exec' | 'net' | 'safe';

interface ToolMeta {
  kind: ToolKind;
  /** Arg keys that carry a filesystem path to confine. */
  pathArgs?: string[];
}

// Per-tool security metadata. Unknown tools default to 'safe' (only allow/deny
// and the output cap apply).
const META: Record<string, ToolMeta> = {
  file_read: { kind: 'fs-read', pathArgs: ['path'] },
  file_write: { kind: 'fs-write', pathArgs: ['path'] },
  file_edit: { kind: 'fs-write', pathArgs: ['path'] },
  glob: { kind: 'fs-read', pathArgs: ['path'] },
  grep: { kind: 'fs-read', pathArgs: ['path'] },
  shell: { kind: 'exec' },
  shell_session_open: { kind: 'exec' },
  shell_session_reuse: { kind: 'safe' },
  shell_session_list: { kind: 'safe' },
  shell_exec: { kind: 'exec' },
  shell_poll: { kind: 'safe' },
  shell_kill: { kind: 'safe' },
  shell_session_close: { kind: 'safe' },
  web_fetch: { kind: 'net' },
  web_search: { kind: 'net' },
  ask_user: { kind: 'safe' },
  write_html_artifact: { kind: 'safe' },
  update_plan: { kind: 'safe' },
  skill_activate: { kind: 'safe' },
  subagent_run: { kind: 'safe' },
  subagent_poll: { kind: 'safe' },
  subagent_list: { kind: 'safe' },
  datasource_list: { kind: 'safe' },
};

/** True when `target` resolves to a location at or under `root`. */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveFromWorkspace(root: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(root, target);
}

export interface ToolPolicy {
  readonly config: ToolPolicyConfig;
  check(name: string, args: Record<string, unknown>): PolicyDecision;
  capOutput(output: string): string;
}

export function createPolicy(cfg: ToolPolicyConfig): ToolPolicy {
  const shellDenyRes = cfg.shellDeny.map((p) => new RegExp(p, 'i'));

  function check(name: string, args: Record<string, unknown>): PolicyDecision {
    // 1) deny/allow lists — honored in every mode.
    if (cfg.deny.includes(name)) return { ok: false, reason: `工具 '${name}' 被策略拒绝` };
    if (cfg.allow.length && !cfg.allow.includes(name)) {
      return { ok: false, reason: `工具 '${name}' 不在允许列表中` };
    }
    const meta = META[name] ?? { kind: 'safe' as const };
    const materializedSkillRoot = resolve(cfg.workspaceRoot, '.agents/skills');

    // 内置 skill materialize 后是只读运行时资源；写保护不依赖 sandbox 开关。
    if (meta.kind === 'fs-write' && meta.pathArgs) {
      for (const key of meta.pathArgs) {
        const raw = args[key];
        if (raw == null || raw === '') continue;
        if (isWithin(materializedSkillRoot, resolveFromWorkspace(cfg.workspaceRoot, String(raw)))) {
          return { ok: false, reason: `内置 skill 目录只读：${materializedSkillRoot}` };
        }
      }
    }

    if (meta.kind === 'exec') {
      const command = String(args.command ?? '');
      const mentionsMaterializedSkills = command.includes('.agents/skills');
      const writeLike = /(^|[;&|]\s*)(rm|mv|cp)\b|>\s*[^&|;]*\.agents\/skills|tee\b[^&|;]*\.agents\/skills|sed\s+-i\b/.test(command);
      if (mentionsMaterializedSkills && writeLike) {
        return { ok: false, reason: `内置 skill 目录只读：${materializedSkillRoot}` };
      }
    }

    if (cfg.sandbox === 'off') return { ok: true };

    // 2) filesystem confinement.
    if ((meta.kind === 'fs-read' || meta.kind === 'fs-write') && meta.pathArgs) {
      for (const key of meta.pathArgs) {
        const raw = args[key];
        if (raw == null || raw === '') continue; // optional path (e.g. glob/grep default cwd)
        const target = resolveFromWorkspace(cfg.workspaceRoot, String(raw));
        if (!isWithin(cfg.workspaceRoot, target)) {
          return { ok: false, reason: `路径 '${String(raw)}' 超出 workspace (${cfg.workspaceRoot})` };
        }
      }
    }

    // 3) shell gating + command denylist.
    if (meta.kind === 'exec') {
      if (!cfg.shellEnabled) return { ok: false, reason: 'shell 执行已禁用' };
      const command = String(args.command ?? '');
      for (const re of shellDenyRes) {
        if (re.test(command)) return { ok: false, reason: `命令被拒绝列表拦截（${re.source}）` };
      }
    }

    // 4) 网络总开关。域名/IP 白名单不在这里假实现,当前只有全开或全断。
    if (meta.kind === 'net') {
      if (cfg.network === 'disabled') return { ok: false, reason: '网络访问已禁用' };
    }

    return { ok: true };
  }

  function capOutput(output: string): string {
    // PostgreSQL text/jsonb 都不接受 NUL 字符；工具读到二进制片段时先统一清理。
    output = output.replace(/\u0000/g, '');
    if (output.length <= cfg.maxOutput) return output;
    const dropped = output.length - cfg.maxOutput;
    const marker = `\n…[工具策略已截断 ${dropped} 个字符]…\n`;
    if (cfg.maxOutput <= marker.length) return marker.slice(0, cfg.maxOutput);
    // 截断提示也计入上限；头部便于看起点，尾部常保留错误摘要或最终结论。
    const contentBudget = cfg.maxOutput - marker.length;
    const head = Math.floor(contentBudget * 0.7);
    const tail = contentBudget - head;
    return `${output.slice(0, head)}${marker}${output.slice(output.length - tail)}`;
  }

  return { config: cfg, check, capOutput };
}

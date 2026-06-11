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
  web_fetch: { kind: 'net' },
  web_search: { kind: 'net' },
  ask_user: { kind: 'safe' },
  render_ui: { kind: 'safe' },
  update_plan: { kind: 'safe' },
  finish_conversation: { kind: 'safe' },
};

/** True when `target` resolves to a location at or under `root`. */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
    if (cfg.deny.includes(name)) return { ok: false, reason: `tool '${name}' is denied by policy` };
    if (cfg.allow.length && !cfg.allow.includes(name)) {
      return { ok: false, reason: `tool '${name}' is not in the allow-list` };
    }
    if (cfg.sandbox === 'off') return { ok: true };

    const meta = META[name] ?? { kind: 'safe' as const };

    // 2) filesystem confinement.
    if ((meta.kind === 'fs-read' || meta.kind === 'fs-write') && meta.pathArgs) {
      for (const key of meta.pathArgs) {
        const raw = args[key];
        if (raw == null || raw === '') continue; // optional path (e.g. glob/grep default cwd)
        const target = resolve(String(raw));
        if (!isWithin(cfg.workspaceRoot, target)) {
          return { ok: false, reason: `path '${String(raw)}' is outside the workspace (${cfg.workspaceRoot})` };
        }
      }
    }

    // 3) shell gating + command denylist.
    if (meta.kind === 'exec') {
      if (!cfg.shellEnabled) return { ok: false, reason: 'shell execution is disabled' };
      const command = String(args.command ?? '');
      for (const re of shellDenyRes) {
        if (re.test(command)) return { ok: false, reason: `command blocked by denylist (${re.source})` };
      }
    }

    // 4) 网络总开关。域名/IP 白名单不在这里假实现,当前只有全开或全断。
    if (meta.kind === 'net') {
      if (cfg.network === 'disabled') return { ok: false, reason: 'network access is disabled' };
    }

    return { ok: true };
  }

  function capOutput(output: string): string {
    if (output.length <= cfg.maxOutput) return output;
    const dropped = output.length - cfg.maxOutput;
    // Keep both ends — the head holds the start (e.g. a listing's first entries),
    // the tail often holds the conclusion (error summary, final lines).
    const head = Math.floor(cfg.maxOutput * 0.7);
    const tail = cfg.maxOutput - head;
    return `${output.slice(0, head)}\n…[truncated ${dropped} chars by tool policy]…\n${output.slice(output.length - tail)}`;
  }

  return { config: cfg, check, capOutput };
}

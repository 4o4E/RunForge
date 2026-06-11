// Tool sandbox / permission policy (Phase 6). A single enforcement point that
// every tool call passes through (see registry.runTool). It provides the trusted
// boundary for "safely calling system capabilities":
//
//   - allow/deny lists           (honored in any mode)
//   - output size cap            (honored in any mode)
//   - filesystem path confinement (enforce mode)
//   - shell enable + command denylist (enforce mode)
//   - web enable + host allowlist (enforce mode)
//
// Container-level isolation (E2B / microsandbox / Docker) is a complementary,
// heavier follow-up; this layer is process-local, dependency-free and always on
// the call path so it composes with whatever isolation is added later.

import { isAbsolute, relative, resolve } from 'node:path';
import { config } from '../config.js';

export interface ToolPolicyConfig {
  sandbox: 'off' | 'enforce';
  workspaceRoot: string;
  allow: string[];
  deny: string[];
  shellEnabled: boolean;
  shellDeny: string[];
  webEnabled: boolean;
  webAllowHosts: string[];
  maxOutput: number;
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

type ToolKind = 'fs-read' | 'fs-write' | 'exec' | 'net' | 'safe';

interface ToolMeta {
  kind: ToolKind;
  /** Arg keys that carry a filesystem path to confine. */
  pathArgs?: string[];
  /** Arg keys that carry a URL to gate by host. */
  urlArgs?: string[];
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
  web_fetch: { kind: 'net', urlArgs: ['url'] },
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

    // 4) network gating + host allowlist.
    if (meta.kind === 'net') {
      if (!cfg.webEnabled) return { ok: false, reason: 'web access is disabled' };
      if (cfg.webAllowHosts.length && meta.urlArgs) {
        for (const key of meta.urlArgs) {
          const raw = args[key];
          if (raw == null || raw === '') continue;
          let host: string;
          try {
            host = new URL(String(raw)).hostname;
          } catch {
            return { ok: false, reason: `invalid URL: ${String(raw)}` };
          }
          if (!cfg.webAllowHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
            return { ok: false, reason: `host '${host}' is not in the web allow-list` };
          }
        }
      }
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

/** The process-wide policy built from config. */
export const policy = createPolicy(config.tools);

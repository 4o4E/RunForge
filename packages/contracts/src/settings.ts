export type SandboxBackendName = 'auto' | 'none' | 'bwrap';

export interface ToolSettings {
  sandbox: 'off' | 'enforce';
  sandboxBackend: SandboxBackendName;
  workspaceRoot: string;
  allow: string[];
  deny: string[];
  shellEnabled: boolean;
  shellUseHostPath: boolean;
  shellAllowCommands: string[];
  network: 'enabled' | 'disabled';
  shellDeny: string[];
  maxOutput: number;
}

export type PageState = Record<string, unknown>;

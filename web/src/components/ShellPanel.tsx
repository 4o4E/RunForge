import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Circle, Paperclip, Pencil, Plug, Power, RefreshCw, Square, Terminal, X } from 'lucide-react';
import {
  closeShellSession,
  createShellSession,
  getShellCommandLogs,
  killShellCommand,
  listShellSessions,
  markShellCommand,
  renameShellSession,
  runShellCommand,
  subscribeShell,
  type ShellCommand,
  type ShellCommandLog,
  type ShellSession,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  width: number;
  threadId: string | null;
  embedded?: boolean;
  previewSessionId?: string | null;
  onClose: () => void;
  onAttach: (entry: { kind: 'shell'; path: string; name: string; size?: number; text: string }) => void;
}

const RUNNING: ShellCommand['status'][] = ['queued', 'running'];
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

function isRunning(command: ShellCommand | null | undefined): boolean {
  return !!command && RUNNING.includes(command.status);
}

function sessionTone(status: ShellSession['status']): string {
  if (status === 'busy') return 'text-foreground';
  if (status === 'idle') return 'text-muted-foreground';
  if (status === 'orphaned') return 'text-destructive';
  if (status === 'closed') return 'text-muted-foreground';
  return 'text-foreground';
}

function sessionStatusLabel(status: ShellSession['status']): string {
  if (status === 'opening') return '启动中';
  if (status === 'idle') return '空闲';
  if (status === 'busy') return '运行中';
  if (status === 'closing') return '关闭中';
  if (status === 'closed') return '已关闭';
  if (status === 'orphaned') return '失联';
  return status;
}

function commandStatusLabel(status: ShellCommand['status']): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '运行中';
  if (status === 'succeeded') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'killed') return '已终止';
  if (status === 'timed_out') return '超时';
  if (status === 'orphaned') return '失联';
  return status;
}

function actorLabel(actor: ShellCommand['actor']): string {
  if (actor === 'agent') return 'Agent';
  if (actor === 'user') return '用户';
  if (actor === 'system') return '系统';
  return actor;
}

function commandBadgeVariant(status: ShellCommand['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'timed_out' || status === 'orphaned') return 'destructive';
  if (status === 'running' || status === 'queued') return 'default';
  if (status === 'succeeded') return 'secondary';
  return 'outline';
}

function formatBytes(value: string | number): string {
  const bytes = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortCwd(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

function commandSummary(command: ShellCommand): string {
  if (command.status === 'succeeded') return `succeeded${command.exit_code != null ? `, exit ${command.exit_code}` : ''}`;
  if (command.status === 'failed') return `failed${command.exit_code != null ? `, exit ${command.exit_code}` : ''}${command.signal ? `, ${command.signal}` : ''}`;
  if (command.status === 'killed') return `killed${command.signal ? `, ${command.signal}` : ''}`;
  if (command.status === 'timed_out') return `timed out${command.signal ? `, ${command.signal}` : ''}`;
  if (command.status === 'orphaned') return 'orphaned after server restart';
  return command.status;
}

function applyTerminalControls(raw: string): string {
  const lines = [''];
  let row = 0;
  const text = raw.replace(ANSI_PATTERN, '').replace(/\u0000/g, '');
  for (const char of text) {
    if (char === '\r') {
      lines[row] = '';
    } else if (char === '\n') {
      row += 1;
      lines[row] = '';
    } else if (char === '\b') {
      lines[row] = lines[row].slice(0, -1);
    } else if (char === '\t' || char >= ' ') {
      lines[row] += char;
    }
  }
  return lines.join('\n');
}

function sortedCommands(session: ShellSession | null): ShellCommand[] {
  return [...(session?.commands ?? [])].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
}

function selectionTouchesElement(selection: Selection, element: HTMLElement): boolean {
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return (!!anchor && element.contains(anchor)) || (!!focus && element.contains(focus));
}

function clearElementSelection(element: HTMLElement | null): void {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  if (selectionTouchesElement(selection, element)) selection.removeAllRanges();
}

export function ShellPanel({ open, width, threadId, embedded = false, previewSessionId = null, onClose, onAttach }: Props) {
  const [sessions, setSessions] = useState<ShellSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [logsByCommand, setLogsByCommand] = useState<Record<string, ShellCommandLog[]>>({});
  const [commandText, setCommandText] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const liveSessions = useMemo(() => sessions.filter((session) => session.status !== 'closed'), [sessions]);
  const selectedSession = useMemo(() => {
    if (previewSessionId) return liveSessions.find((session) => session.id === previewSessionId) ?? null;
    return liveSessions.find((session) => session.id === selectedSessionId) ?? liveSessions[0] ?? null;
  }, [liveSessions, previewSessionId, selectedSessionId]);
  const commands = useMemo(() => sortedCommands(selectedSession), [selectedSession]);
  const runningCommand = useMemo(() => commands.find((command) => isRunning(command)) ?? null, [commands]);
  const hasRunningCommand = useMemo(
    () => liveSessions.some((session) => (session.commands ?? []).some((command) => isRunning(command))),
    [liveSessions],
  );
  const commandsKey = commands.map((command) => `${command.id}:${command.updated_at}`).join('|');

  const refresh = useCallback(async () => {
    if (!open || !threadId) {
      setSessions([]);
      setSelectedSessionId(null);
      setLogsByCommand({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await listShellSessions(threadId);
      setSessions(data.sessions);
      setSelectedSessionId((current) => {
        const nextLive = data.sessions.filter((session) => session.status !== 'closed');
        if (current && nextLive.some((session) => session.id === current)) return current;
        return nextLive[0]?.id ?? null;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [open, threadId]);

  const refreshCommandLogs = useCallback(async (nextCommands: ShellCommand[]) => {
    if (!nextCommands.length) {
      setLogsByCommand({});
      return;
    }
    try {
      const entries = await Promise.all(
        nextCommands.map(async (command) => {
          const data = await getShellCommandLogs(command.id, 0, 1000);
          return [command.id, data.logs] as const;
        }),
      );
      setLogsByCommand(Object.fromEntries(entries));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, previewSessionId, refresh]);

  useLayoutEffect(() => {
    // thread 或预览 session 切换时先清掉本地视图，避免旧 shell 输出和选区短暂残留。
    clearElementSelection(panelRef.current);
    setSessions([]);
    setSelectedSessionId(previewSessionId ?? null);
    setLogsByCommand({});
    setCommandText('');
    setError(null);
  }, [previewSessionId, threadId]);

  useEffect(() => {
    return () => clearElementSelection(panelRef.current);
  }, []);

  useEffect(() => {
    if (previewSessionId) setSelectedSessionId(previewSessionId);
  }, [previewSessionId]);

  useEffect(() => {
    if (!open || !threadId) return;
    const scheduleRefresh = () => {
      if (refreshTimerRef.current != null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh();
      }, 120);
    };
    const unsubscribe = subscribeShell(threadId, scheduleRefresh, () => {});
    return () => {
      if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      unsubscribe();
    };
  }, [open, refresh, threadId]);

  useEffect(() => {
    void refreshCommandLogs(commands);
  }, [commandsKey, refreshCommandLogs]);

  useEffect(() => {
    if (!open || !threadId) return;
    const interval = window.setInterval(() => {
      if (hasRunningCommand) {
        void refresh();
        void refreshCommandLogs(commands);
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [commands, hasRunningCommand, open, refresh, refreshCommandLogs, threadId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [commandsKey, logsByCommand]);

  async function createSession() {
    if (!threadId) return;
    setActing(true);
    setError(null);
    try {
      const { session } = await createShellSession(threadId, newSessionName.trim() || undefined);
      setSelectedSessionId(session.id);
      setNewSessionName('');
      setCreateOpen(false);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function closeSelectedSession() {
    if (!selectedSession) return;
    if (selectedSession.name === 'Default' || selectedSession.owner !== 'user') return;
    const force = !!runningCommand;
    if (force && !window.confirm('当前 session 还有运行中命令，确认终止命令并关闭 session？')) return;
    setActing(true);
    setError(null);
    try {
      await closeShellSession(selectedSession.id, force);
      setLogsByCommand({});
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  function openRenameDialog() {
    if (!selectedSession || selectedSession.name === 'Default' || selectedSession.owner !== 'user') return;
    setRenameName(selectedSession.name);
    setRenameOpen(true);
  }

  async function renameSelectedSession() {
    if (!selectedSession) return;
    const name = renameName.trim();
    if (!name) {
      setError('名称不能为空');
      return;
    }
    setActing(true);
    setError(null);
    try {
      await renameShellSession(selectedSession.id, name);
      setRenameOpen(false);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function sendCommand() {
    if (!selectedSession || !commandText.trim()) return;
    setActing(true);
    setError(null);
    try {
      await runShellCommand(selectedSession.id, commandText.trim());
      setCommandText('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function killRunningCommand() {
    if (!runningCommand) return;
    setActing(true);
    setError(null);
    try {
      await killShellCommand(runningCommand.id);
      await refresh();
      await refreshCommandLogs(commands);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function attachCommand(command: ShellCommand) {
    setActing(true);
    setError(null);
    try {
      const { attachment } = await markShellCommand(command.id);
      onAttach({
        kind: 'shell',
        path: `shell:${attachment.commandId}`,
        name: attachment.name,
        size: attachment.size,
        text: attachment.text,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActing(false);
    }
  }

  if (!open) return null;

  const canDeleteSelected = !!selectedSession && selectedSession.name !== 'Default' && selectedSession.owner === 'user';
  const canRenameSelected = canDeleteSelected;

  return (
    <aside ref={panelRef} className={cn('flex h-full shrink-0 flex-col bg-card', !embedded && 'border-l')} style={embedded ? undefined : { width }}>
      <div className="flex h-14 items-center gap-2 border-b px-3">
        <Terminal className="size-4 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Shell</div>
          <div className="truncate text-xs text-muted-foreground">{selectedSession?.cwd ?? selectedSession?.workspace_root ?? '当前会话没有 shell session'}</div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void refresh()} title="刷新">
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
        {!embedded && (
          <Button variant="ghost" size="icon" onClick={onClose} title="关闭面板">
            <X className="size-4" />
          </Button>
        )}
      </div>

      {error && <div className="border-b px-3 py-2 text-xs text-destructive">{error}</div>}

      {!threadId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          先选择或创建一个会话，再打开 Shell。
        </div>
      ) : (
        <>
          <div className="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
            {!previewSessionId && (
              <div className="scrollbar-thin flex min-w-0 flex-1 gap-1 overflow-x-auto">
                {liveSessions.map((session) => (
                  <Button
                    key={session.id}
                    type="button"
                    variant={session.id === selectedSession?.id ? 'secondary' : 'ghost'}
                    size="sm"
                    className={cn(
                      'h-8 min-w-28 max-w-48 justify-start px-2 text-xs',
                      session.id !== selectedSession?.id && 'text-muted-foreground',
                    )}
                    onClick={() => setSelectedSessionId(session.id)}
                    title={`${session.name} (${session.id})`}
                  >
                    <Circle className={cn('size-2.5 shrink-0 fill-current', sessionTone(session.status))} />
                    <span className="min-w-0 flex-1 truncate">{session.name}</span>
                  </Button>
                ))}
              </div>
            )}
            {previewSessionId && (
              <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                预览 {selectedSession ? selectedSession.name : `${previewSessionId}（不存在或已关闭）`}
              </div>
            )}
            <Button variant="ghost" size="icon-sm" onClick={() => setCreateOpen(true)} disabled={acting} title="创建 shell">
              <Plug className="size-3.5" />
            </Button>
            {selectedSession && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={openRenameDialog}
                  disabled={acting || !canRenameSelected}
                  title={canRenameSelected ? '改名' : 'Default 或 agent 创建的 shell 不能改名'}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void closeSelectedSession()}
                  disabled={acting || !canDeleteSelected}
                  title={canDeleteSelected ? '删除 shell' : 'Default 或 agent 创建的 shell 不能删除'}
                >
                  <Power className="size-3.5" />
                  删除
                </Button>
              </>
            )}
          </div>

          {selectedSession ? (
            <>
              <ScrollArea className="min-h-0 flex-1 bg-background" viewportClassName="h-full" viewportRef={terminalRef}>
                <div className="min-h-full px-4 py-3 font-mono text-[12px] leading-5 text-foreground">
                  <div className="mb-3 flex flex-wrap items-center gap-2 border-b pb-3 font-sans text-xs text-muted-foreground">
                    <Badge variant="outline" className="bg-background">
                      {sessionStatusLabel(selectedSession.status)}
                    </Badge>
                    <span className="min-w-0 truncate">{selectedSession.cwd}</span>
                    <span>backend: {selectedSession.backend}</span>
                    {runningCommand && (
                      <Button variant="destructive" size="sm" className="ml-auto h-7" onClick={() => void killRunningCommand()} disabled={acting} title="发送 Ctrl+C 终止命令">
                        <Square className="size-3.5" />
                        终止
                      </Button>
                    )}
                  </div>
                  {commands.length ? (
                    commands.map((command) => {
                      const logs = logsByCommand[command.id] ?? [];
                      const output = applyTerminalControls(logs.map((log) => log.chunk).join(''));
                      const bytes = formatBytes(command.output_bytes);
                      return (
                        <div key={command.id} className="border-b py-3 last:border-0">
                          <div className="whitespace-pre-wrap break-words">
                            <span className="text-muted-foreground">{shortCwd(command.cwd)}</span>
                            <span className="text-primary"> $ </span>
                            <span>{command.command}</span>
                          </div>
                          {output ? (
                            <pre className={cn('mt-2 whitespace-pre-wrap break-words', command.status === 'failed' ? 'text-destructive' : 'text-foreground')}>
                              {output}
                            </pre>
                          ) : (
                            isRunning(command) && <div className="mt-2 text-muted-foreground">等待输出...</div>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-2 font-sans text-[11px] text-muted-foreground">
                            <Badge variant={commandBadgeVariant(command.status)} className="h-5 px-1.5 py-0 text-[10px]">
                              {commandStatusLabel(command.status)}
                            </Badge>
                            <span>{actorLabel(command.actor)}</span>
                            <span>{formatTime(command.ended_at ?? command.updated_at)}</span>
                            <span>{commandSummary(command)}</span>
                            {bytes && <span>{bytes}</span>}
                            {!isRunning(command) && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="ml-auto size-6 text-muted-foreground"
                                onClick={() => void attachCommand(command)}
                                disabled={acting}
                                title="添加这次 shell 交互到输入框"
                              >
                                <Paperclip className="size-3.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="flex min-h-64 items-center justify-center text-center text-muted-foreground">
                      暂无命令。
                    </div>
                  )}
                  <div className="flex min-w-0 items-center gap-1 py-3">
                    <span className="shrink-0 text-muted-foreground">{shortCwd(selectedSession.cwd)}</span>
                    <span className="shrink-0 text-primary">$</span>
                    <Input
                      value={commandText}
                      onChange={(event) => setCommandText(event.target.value)}
                      placeholder={runningCommand ? '命令运行中' : '输入命令'}
                      disabled={!!runningCommand || acting}
                      className="h-6 min-w-0 border-0 bg-transparent px-1 py-0 font-mono text-xs text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void sendCommand();
                        }
                      }}
                    />
                  </div>
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              <div>
                <div>{previewSessionId ? '这个 shell session 不存在或已关闭。' : '当前没有可用 shell session。'}</div>
                {!previewSessionId && (
                  <Button className="mt-3" size="sm" onClick={() => setCreateOpen(true)} disabled={acting}>
                    <Plug className="size-4" />
                    创建
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建 Shell</DialogTitle>
          </DialogHeader>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">名称</span>
            <Input
              value={newSessionName}
              onChange={(event) => setNewSessionName(event.currentTarget.value)}
              placeholder="留空自动生成 User 1"
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button type="button" onClick={() => void createSession()} disabled={acting}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>改名 Shell</DialogTitle>
          </DialogHeader>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">名称</span>
            <Input
              value={renameName}
              onChange={(event) => setRenameName(event.currentTarget.value)}
              placeholder="Shell 名称"
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button type="button" onClick={() => void renameSelectedSession()} disabled={acting || !renameName.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

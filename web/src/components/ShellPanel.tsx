import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Circle, CircleX, MoreHorizontal, Paperclip, Pencil, Plug, Power, RefreshCw, Square, Terminal, X } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
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
  return date.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function commandTone(status: ShellCommand['status']): string {
  if (status === 'failed' || status === 'timed_out' || status === 'orphaned') return 'text-red-500';
  if (status === 'running' || status === 'queued') return 'text-amber-500';
  if (status === 'killed') return 'text-muted-foreground';
  return 'text-sky-500';
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

/** 命令状态和管理操作共用左侧标记，正文只保留终端输入与输出。 */
function CommandMarker({ command, acting, onAttach, onKill }: {
  command: ShellCommand;
  acting: boolean;
  onAttach: () => void;
  onKill: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const failed = ['failed', 'timed_out', 'orphaned'].includes(command.status);

  useEffect(() => () => {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
  }, []);

  function enter() {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setHovered(true);
  }

  function leave() {
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setHovered(false);
    }, 120);
  }

  return (
    <Popover open={hovered || pinned} onOpenChange={(next) => {
      if (!next) {
        setHovered(false);
        setPinned(false);
      }
    }}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className={cn('inline-flex size-4 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', commandTone(command.status))}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onClick={() => {
            setPinned(!pinned);
            setHovered(!pinned);
          }}
          aria-label={`${commandStatusLabel(command.status)}：${command.command}，查看命令详情`}
        >
          {failed ? <CircleX className="size-2.5" /> : <Circle className="size-2 fill-current" />}
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        className="w-72 space-y-3 p-3"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className={commandTone(command.status)}>{commandStatusLabel(command.status)}</span>
          <span className="text-muted-foreground">· {actorLabel(command.actor)}</span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">目录</dt><dd className="break-all font-mono">{command.cwd}</dd>
          <dt className="text-muted-foreground">开始</dt><dd>{formatTime(command.started_at)}</dd>
          {command.ended_at && <><dt className="text-muted-foreground">结束</dt><dd>{formatTime(command.ended_at)}</dd></>}
          {command.exit_code != null && <><dt className="text-muted-foreground">退出码</dt><dd>{command.exit_code}</dd></>}
          {command.signal && <><dt className="text-muted-foreground">信号</dt><dd>{command.signal}</dd></>}
          {formatBytes(command.output_bytes) && <><dt className="text-muted-foreground">输出量</dt><dd>{formatBytes(command.output_bytes)}</dd></>}
          {command.attention && <><dt className="text-muted-foreground">提示</dt><dd className="break-words">{command.attention}</dd></>}
        </dl>
        <div className="flex gap-2">
          {isRunning(command) ? (
            <Button variant="destructive" size="sm" onClick={onKill} disabled={acting}>
              <Square className="size-3.5" />终止命令
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onAttach} disabled={acting}>
              <Paperclip className="size-3.5" />附加到输入框
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
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
  const commandInputRef = useRef<HTMLInputElement>(null);
  const focusCommandAfterSendRef = useRef(false);
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
    focusCommandAfterSendRef.current = false;
  }, [previewSessionId, threadId]);

  useEffect(() => {
    if (!open || acting || runningCommand || !selectedSession || !focusCommandAfterSendRef.current) return;
    commandInputRef.current?.focus();
    focusCommandAfterSendRef.current = false;
  }, [acting, open, runningCommand, selectedSession]);

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
    focusCommandAfterSendRef.current = true;
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
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <Terminal className="mx-1 size-4 shrink-0 text-muted-foreground" />
        {!threadId ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Shell</span>
        ) : !previewSessionId ? (
          <div className="scrollbar-thin flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {liveSessions.map((session) => (
              <Button
                key={session.id}
                type="button"
                variant={session.id === selectedSession?.id ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 min-w-20 max-w-40 justify-start gap-1.5 px-2 text-xs"
                onClick={() => setSelectedSessionId(session.id)}
                title={`${session.name} (${session.id})`}
              >
                <Circle className={cn('size-2 shrink-0 fill-current', sessionTone(session.status))} />
                <span className="truncate">{session.name}</span>
              </Button>
            ))}
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs">{selectedSession?.name ?? previewSessionId}</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Shell 操作" aria-label="Shell 操作">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="space-y-1 text-xs">
              <div>{selectedSession?.name ?? 'Shell'} · {selectedSession ? sessionStatusLabel(selectedSession.status) : '无会话'}</div>
              {selectedSession && <div className="break-all font-mono font-normal text-muted-foreground">{selectedSession.cwd} · {selectedSession.backend}</div>}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void refresh()}>
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />刷新
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!threadId || acting} onSelect={() => setCreateOpen(true)}>
              <Plug className="size-4" />创建 Shell
            </DropdownMenuItem>
            <DropdownMenuItem disabled={acting || !canRenameSelected} onSelect={openRenameDialog}>
              <Pencil className="size-4" />重命名 Shell
            </DropdownMenuItem>
            <DropdownMenuItem disabled={acting || !canDeleteSelected} onSelect={() => void closeSelectedSession()}>
              <Power className="size-4" />删除 Shell
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!embedded && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} title="关闭面板">
            <X className="size-4" />
          </Button>
        )}
      </div>

      {error && <div className="border-b px-3 py-2 text-xs text-destructive">{error}</div>}

      {!threadId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          先选择或创建一个会话，再打开 Shell。
        </div>
      ) : selectedSession ? (
        <ScrollArea className="min-h-0 flex-1 bg-zinc-950 text-zinc-200" viewportClassName="h-full" viewportRef={terminalRef}>
          <div className="min-h-full py-2 pl-1 pr-3 font-mono text-sm leading-5">
            {commands.map((command) => {
              const logs = logsByCommand[command.id] ?? [];
              // 一次命令输出末尾的换行由下一条提示符接续，保留更早的空行。
              const output = applyTerminalControls(logs.map((log) => log.chunk).join('')).replace(/\n$/, '');
              return (
                <div key={command.id} className="grid grid-cols-[12px_minmax(0,1fr)] gap-x-1">
                  <CommandMarker
                    command={command}
                    acting={acting}
                    onAttach={() => void attachCommand(command)}
                    onKill={() => void killRunningCommand()}
                  />
                  <div className="min-w-0 whitespace-pre-wrap break-words">
                    <span className="text-zinc-400">{command.cwd}</span>
                    <span className="text-sky-400"> $ </span>
                    <span>{command.command}</span>
                  </div>
                  {output && <pre className="col-start-2 min-w-0 whitespace-pre-wrap break-words font-mono text-inherit">{output}</pre>}
                </div>
              );
            })}
            <div className="grid grid-cols-[12px_minmax(0,1fr)] gap-x-1">
              <div className="col-start-2 flex min-w-0 items-center gap-1">
                <span className="max-w-[60%] min-w-0 truncate text-zinc-400" title={selectedSession.cwd}>{selectedSession.cwd}</span>
                <span className="shrink-0 text-sky-400">$</span>
                <Input
                  ref={commandInputRef}
                  value={commandText}
                  onChange={(event) => setCommandText(event.target.value)}
                  placeholder={runningCommand ? '命令运行中' : '输入命令'}
                  disabled={!!runningCommand || acting}
                  className="h-5 min-w-0 border-0 bg-transparent px-0 py-0 font-mono text-sm text-zinc-200 shadow-none placeholder:text-zinc-500 focus-visible:ring-0"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendCommand();
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </ScrollArea>
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

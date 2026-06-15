// agent 层对外事件类型来自共享协议包，避免前后端手动维护两份联合类型。
export type {
  AgentEvent,
  AskUserAnswer,
  AskUserMode,
  AskUserOption,
  AskUserSpec,
  RunStatus,
  StreamStage,
  StreamStats,
  TimedEventFields,
} from '@my-agent/contracts';

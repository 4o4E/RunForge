import { randomUUID } from 'node:crypto';
import type { LlmMessage, LlmResult, LlmTool, Provider } from '../types.js';

/**
 * Deterministic, network-free provider for offline runs and demos.
 *
 * Behavior:
 *  - If the latest message is a tool result, finalize with a short summary.
 *  - Else if the user input starts with "glob " or "shell ", call that tool once.
 *  - Else echo the user input as the final answer.
 */
export function createMockProvider(): Provider {
  return {
    name: 'mock',
    async complete(messages: LlmMessage[], _tools: LlmTool[]): Promise<LlmResult> {
      const last = messages[messages.length - 1];
      if (last?.role === 'tool') {
        return { content: `Done. Tool result:\n${(last.content ?? '').slice(0, 500)}`, toolCalls: [] };
      }

      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const text = (lastUser?.content ?? '').trim();

      const glob = text.match(/^glob\s+(.+)$/i);
      if (glob) {
        return {
          content: null,
          toolCalls: [{ id: randomUUID(), name: 'glob', arguments: JSON.stringify({ pattern: glob[1] }) }],
        };
      }
      const shell = text.match(/^shell\s+(.+)$/i);
      if (shell) {
        return {
          content: null,
          toolCalls: [{ id: randomUUID(), name: 'shell', arguments: JSON.stringify({ command: shell[1] }) }],
        };
      }
      return { content: `You said: ${text}`, toolCalls: [] };
    },
  };
}

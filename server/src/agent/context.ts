import type { LlmMessage } from '../llm/types.js';

const SYSTEM_PROMPT = `You are my-agent, a general-purpose autonomous assistant.

You operate in a loop: think, optionally call tools, observe results, and continue
until the task is complete. Then give a concise final answer.

Guidelines:
- Prefer tools to act on the world (run commands, read/write files, search the web).
- Call one or more tools when they help; otherwise answer directly.
- When you have enough information, stop calling tools and write the final answer.
- Be concise. State assumptions you made instead of asking when possible.`;

/**
 * Holds the working message list for a single run: a fresh system prompt, the
 * prior thread history (for multi-turn memory), and the new user input.
 */
export class Context {
  private messages: LlmMessage[] = [];

  constructor(priorMessages: LlmMessage[], userInput: string) {
    this.messages.push({ role: 'system', content: SYSTEM_PROMPT });
    this.messages.push(...priorMessages);
    this.messages.push({ role: 'user', content: userInput });
  }

  all(): LlmMessage[] {
    return this.messages;
  }

  add(message: LlmMessage): void {
    this.messages.push(message);
  }
}

export { SYSTEM_PROMPT };

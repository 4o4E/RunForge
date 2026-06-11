import type { Tool } from './types.js';

/**
 * Ask the user a clarifying question.
 *
 * In this skeleton the agent runs autonomously, so we don't truly block for input —
 * the question is surfaced as an event (see the executor) and echoed back. Wire this
 * to a real human-in-the-loop channel (WebSocket prompt + resume) when needed.
 */
export const askUserTool: Tool = {
  name: 'ask_user',
  description: 'Ask the user a clarifying question when the task is ambiguous. Use sparingly.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
    },
    required: ['question'],
  },
  async run(args) {
    const question = String(args.question ?? '');
    return `Question surfaced to user: "${question}". (No interactive answer available in this run; proceed with a reasonable assumption and state it.)`;
  },
};

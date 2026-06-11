import { Router } from 'express';
import { executeRun } from '../agent/executor.js';
import { store } from '../store/index.js';

export const api = Router();

// --- Threads ---

// Create a thread
api.post('/threads', async (req, res) => {
  const title = req.body?.title ? String(req.body.title) : undefined;
  const thread = await store.createThread(title);
  res.status(201).json(thread);
});

// List threads
api.get('/threads', async (_req, res) => {
  res.json(await store.listThreads());
});

// Thread detail (thread + its runs, each with its events) — used to restore a conversation.
api.get('/threads/:id', async (req, res) => {
  const thread = await store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  const runs = await store.listRuns(thread.id);
  const withEvents = await Promise.all(
    runs.map(async (run) => ({ ...run, events: await store.getEvents(run.id) })),
  );
  res.json({ thread, runs: withEvents });
});

// Start a run inside a thread
api.post('/threads/:id/runs', async (req, res) => {
  const thread = await store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  const input = String(req.body?.input ?? '').trim();
  if (!input) return res.status(400).json({ error: 'input is required' });

  const run = await store.createRun(thread.id, input);
  // Fire-and-forget: the loop runs in-process and streams events over WS.
  void executeRun(run.id);
  res.status(201).json({ id: run.id, threadId: thread.id, status: run.status });
});

// --- Runs ---

// Run detail (run + events). Events are grouped by step on the client.
api.get('/runs/:id', async (req, res) => {
  const run = await store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const events = await store.getEvents(run.id);
  res.json({ run, events });
});

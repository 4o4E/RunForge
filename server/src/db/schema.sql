-- Agent persistence schema (PostgreSQL)
-- Conversation hierarchy: thread → run → step → (messages, events)

CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One run = one user turn in a thread (input → agent works → output)
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | error
  input       TEXT NOT NULL,
  output      TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One step = one iteration of the agent loop (one LLM turn + its tool calls)
CREATE TABLE IF NOT EXISTS steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,                  -- 1-based step number within the run
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     TEXT REFERENCES steps(id) ON DELETE CASCADE,  -- null for the initial user message
  role        TEXT NOT NULL,                     -- user | assistant | tool
  content     TEXT,
  tool_calls  JSONB,                             -- assistant tool call requests
  tool_call_id TEXT,                             -- for role=tool
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     TEXT REFERENCES steps(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL DEFAULT 0,        -- step index this event belongs to
  type        TEXT NOT NULL,                     -- step_start | llm_delta | tool_call | tool_result | final | error
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, idx);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_threads_created ON threads(created_at DESC);

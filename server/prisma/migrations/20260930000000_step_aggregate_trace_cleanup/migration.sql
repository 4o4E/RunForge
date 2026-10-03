-- 流式分片改写入按 run 分隔的本地 trace；数据库只保留一次模型请求的聚合结果和恢复状态。
ALTER TABLE "steps"
  ADD COLUMN "result" JSONB,
  ADD COLUMN "completed_at" TIMESTAMPTZ(6);

ALTER TABLE "runs"
  ADD COLUMN "runtime_state" JSONB NOT NULL DEFAULT '{"skillIds":[],"mcpServerIds":[],"rejectedImageModels":[],"lastAppliedExternalInputVersion":0}',
  ADD COLUMN "pending_interaction" JSONB;

-- 旧表约 99% 为 reasoning/llm_delta/stream_stats 分片，没有其他表引用；完成态继续由
-- runs、steps、messages、shell 和 subagent 表保存，因此不做高成本回填。
DROP TABLE "events";

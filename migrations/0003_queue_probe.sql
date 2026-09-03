-- Phase 0 Queue 探针：重试/延迟/状态迁移/DLQ 证据。
-- 探针关联只能使用 job_id，不得创建或保留 probe_id。
-- Cron 审计不得存 payload、URL、异常原文或 secret。

CREATE TABLE queue_probe_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempt INTEGER,
  requested_delay_seconds INTEGER,
  occurred_at TEXT NOT NULL
);
CREATE INDEX queue_probe_events_job_idx ON queue_probe_events(job_id, id);

CREATE TABLE cron_invocations (
  invocation_id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  selected_count INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT
);

CREATE TABLE cron_invocation_jobs (
  invocation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  send_result TEXT NOT NULL CHECK (send_result IN ('selected', 'sent', 'failed')),
  send_delay_seconds INTEGER,
  error_code TEXT,
  PRIMARY KEY (invocation_id, job_id),
  FOREIGN KEY (invocation_id) REFERENCES cron_invocations(invocation_id)
);
CREATE INDEX cron_invocation_jobs_invocation_idx ON cron_invocation_jobs(invocation_id, job_id);

ALTER TABLE enrichment_jobs ADD COLUMN probe_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrichment_jobs ADD COLUMN fail_next_cron_send INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrichment_jobs ADD COLUMN enqueued_at TEXT;

-- Phase 0 wire shape 捕获：只存 procedure/类型/状态/字段名/数据类型，
-- 绝不存 raw body、headers、cookies、authorization、URL 值或任何 header 值。

CREATE TABLE phase0_capture_session (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('extension', 'mobile', 'contract')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  started_at TEXT NOT NULL
);

CREATE TABLE protocol_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  client TEXT NOT NULL,
  procedure TEXT NOT NULL,
  procedure_type TEXT NOT NULL,
  input_shape TEXT NOT NULL,
  output_shape TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX protocol_events_run_idx ON protocol_events(run_id, id);

CREATE TABLE protocol_http_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  client TEXT NOT NULL,
  method TEXT NOT NULL,
  is_batch INTEGER NOT NULL CHECK (is_batch IN (0, 1)),
  procedures TEXT NOT NULL,
  request_envelope_shape TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_envelope_shape TEXT NOT NULL,
  fixed_test_header_seen INTEGER NOT NULL CHECK (fixed_test_header_seen IN (0, 1)),
  cors_fixed_header_requested INTEGER CHECK (cors_fixed_header_requested IN (0, 1)),
  cors_fixed_header_allowed INTEGER CHECK (cors_fixed_header_allowed IN (0, 1)),
  cors_origin_matched INTEGER CHECK (cors_origin_matched IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX protocol_http_events_run_idx ON protocol_http_events(run_id, id);

CREATE TABLE protocol_route_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  client TEXT NOT NULL,
  method TEXT NOT NULL,
  route_template TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  request_shape TEXT NOT NULL,
  response_shape TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX protocol_route_events_run_idx ON protocol_route_events(run_id, id);

-- =====================================================================
--  DYNASTY SCOREBOARD — D1 SCHEMA
--  Persists: client record, statements, report history,
--            fiscal-quarter start, nudge preference, exception state.
--  Binding: env.DB  (D1)   |  Blobs: env.R2  (R2 bucket)
--  Deploy:  wrangler d1 execute dynasty_scoreboard --file=schema/schema.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- clients — one row per employer/client. Drives both clocks + state.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  cid                TEXT PRIMARY KEY,          -- e.g. DP-2026-0714
  company            TEXT NOT NULL,
  carrier            TEXT,
  renewal_date       TEXT,                      -- ISO yyyy-mm-dd
  annual_waste       INTEGER DEFAULT 0,         -- dollars (whole)

  -- lifecycle / state machine:
  --   'light'      : Room 101 teaser board, 30-day clock
  --   'awaiting_wire' : $10k Frost wire initiated, not yet confirmed
  --   'awaiting_statement' : payment confirmed, waiting on first billing stmt
  --   'full'       : 12-month board lit
  --   'gray'       : full board but current month's statement missing
  --   'exception'  : HITL 24-hour hold
  status             TEXT NOT NULL DEFAULT 'light',

  light_activated_at TEXT,                      -- starts 30-day light clock
  full_activated_at  TEXT,                      -- starts 12-month full clock

  fiscal_q_start_month INTEGER DEFAULT 1,       -- 1..12; month client's fiscal year begins
                                                --   drives quarterly report cadence

  nudge_pref         TEXT DEFAULT 'Quarterly',  -- Quarterly|Monthly|Weekly|Daily
  nudge_asked        INTEGER DEFAULT 0,         -- 0/1 — modal shown once

  exception_reason   TEXT,                      -- populated when status='exception'
  exception_since    TEXT,                      -- ISO timestamp exception opened

  created_at         TEXT DEFAULT (datetime('now')),
  updated_at         TEXT DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- statements — one row per uploaded monthly billing statement.
--   PDF blob lives in R2 at statements/<cid>/<month_index>.pdf
--   month_index is 1..12 relative to full_activated_at.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS statements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cid           TEXT NOT NULL REFERENCES clients(cid) ON DELETE CASCADE,
  month_index   INTEGER NOT NULL,               -- 1..12
  r2_key        TEXT NOT NULL,                   -- statements/<cid>/<month_index>.pdf
  file_name     TEXT,
  bytes         INTEGER,
  validated     INTEGER DEFAULT 0,              -- 1 once engine parsed & confirmed savings
  validated_savings INTEGER DEFAULT 0,          -- dollars validated this month
  uploaded_at   TEXT DEFAULT (datetime('now')),
  UNIQUE (cid, month_index)
);

-- ---------------------------------------------------------------------
-- reports — report history (initial + quarterly). HTML archived in R2.
--   r2_key: reports/<cid>/<yyyy-mm-dd>-<kind>.html
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cid           TEXT NOT NULL REFERENCES clients(cid) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                   -- 'initial' | 'quarterly'
  fiscal_quarter TEXT,                           -- e.g. 'FY2026-Q1' (null for initial)
  r2_key        TEXT NOT NULL,
  realized_to_date INTEGER,                      -- snapshot at generation
  fee_to_date   INTEGER,
  emailed_to    TEXT,
  generated_at  TEXT DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- report_schedule — upcoming quarterly report run dates per client,
--   computed from fiscal_q_start_month. A cron Worker sweeps due rows.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cid           TEXT NOT NULL REFERENCES clients(cid) ON DELETE CASCADE,
  fiscal_quarter TEXT NOT NULL,                  -- 'FY2026-Q1'
  due_date      TEXT NOT NULL,                   -- ISO date report should fire
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|sent|skipped
  sent_report_id INTEGER,                        -- FK reports.id once fired
  UNIQUE (cid, fiscal_quarter)
);

CREATE INDEX IF NOT EXISTS idx_stmt_cid   ON statements(cid);
CREATE INDEX IF NOT EXISTS idx_rep_cid    ON reports(cid);
CREATE INDEX IF NOT EXISTS idx_sched_due  ON report_schedule(due_date, status);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- 002：作业台账模块（hw_ledger 台账表 + students 小组字段）
-- 台账：以「日期+科目+填报人」为一行，内含表扬/未交/问题三份名单；永久留存（无删除）
ALTER TABLE students ADD COLUMN group_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS hw_ledger (
  id            TEXT PRIMARY KEY,
  class_id      TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  record_date   TEXT NOT NULL,
  subjects      TEXT NOT NULL DEFAULT '[]',   -- JSON 数组：涉及科目（多选）
  reporter      TEXT NOT NULL DEFAULT '',     -- 统计填报人
  praise_names  TEXT NOT NULL DEFAULT '[]',   -- JSON 数组 [{id,name}]：作业表扬名单
  missing_names TEXT NOT NULL DEFAULT '[]',   -- JSON 数组 [{id,name}]：未交作业名单
  problem_names TEXT NOT NULL DEFAULT '[]',   -- JSON 数组 [{id,name}]：作业问题/点名名单
  note          TEXT NOT NULL DEFAULT '',     -- 特殊备注
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hw_ledger_class_date ON hw_ledger(class_id, record_date);
CREATE INDEX IF NOT EXISTS idx_hw_ledger_reporter ON hw_ledger(reporter);

-- 学生谈话记录（谈心/家访/电话/微信/约谈 等分类；单人归档，按日期倒序）
CREATE TABLE IF NOT EXISTS talk_records (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  talk_type   TEXT NOT NULL CHECK (talk_type IN
    ('谈心','批评','鼓励','家访','电话','微信','约谈','周记回复','家长来访','其他')),
  stage       TEXT NOT NULL DEFAULT 'middle' CHECK (stage IN ('primary','middle')),
  summary     TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  follow_up   TEXT NOT NULL DEFAULT '',
  recorder    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_talk_student_date ON talk_records(student_id, date DESC);
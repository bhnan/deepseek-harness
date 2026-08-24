-- 学生成长档案工作台 schema v1（04 数据结构设计文档定稿，冻结）
-- 迁移脚本只增不改：后续变更新建 002_xxx.sql 并升级 schema_version

CREATE TABLE IF NOT EXISTS schema_version (
  version      INTEGER PRIMARY KEY,
  applied_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  grade       TEXT NOT NULL,
  stage       TEXT NOT NULL CHECK (stage IN ('primary','middle')),
  role        TEXT NOT NULL CHECK (role IN ('homeroom','subject')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_classes_stage_role ON classes(stage, role);

CREATE TABLE IF NOT EXISTS students (
  id             TEXT PRIMARY KEY,
  class_id       TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  student_no     TEXT NOT NULL DEFAULT '',
  gender         TEXT CHECK (gender IN ('男','女')),
  birth_date     TEXT,
  school_id      TEXT NOT NULL DEFAULT '',
  id_card        TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  parent1_name   TEXT NOT NULL DEFAULT '',
  parent1_phone  TEXT NOT NULL DEFAULT '',
  parent2_name   TEXT NOT NULL DEFAULT '',
  parent2_phone  TEXT NOT NULL DEFAULT '',
  guardian_note  TEXT NOT NULL DEFAULT '',
  special_note   TEXT NOT NULL DEFAULT '',
  allergy_note   TEXT NOT NULL DEFAULT '',
  manage_note    TEXT NOT NULL DEFAULT '',
  is_boarding    INTEGER NOT NULL DEFAULT 0,
  pressure_level TEXT NOT NULL DEFAULT '中' CHECK (pressure_level IN ('低','中','高')),
  puberty_status TEXT NOT NULL DEFAULT '',
  goal_note      TEXT NOT NULL DEFAULT '',
  subject_note   TEXT NOT NULL DEFAULT '',
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_no ON students(class_id, student_no) WHERE student_no <> '';
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id, active);

CREATE TABLE IF NOT EXISTS exams (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('placement','weekly','monthly','midterm','final','mock','subject','other')),
  date        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exams_class_date ON exams(class_id, date DESC);

CREATE TABLE IF NOT EXISTS exam_scores (
  id            TEXT PRIMARY KEY,
  exam_id       TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  score         REAL NOT NULL,
  class_rank    INTEGER,
  grade_rank    INTEGER,
  question_scores TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (exam_id, student_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_scores_exam ON exam_scores(exam_id);
CREATE INDEX IF NOT EXISTS idx_scores_student ON exam_scores(student_id, subject);

CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  date        TEXT NOT NULL,
  title       TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT '',
  deadline    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','closed')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id, date DESC);

CREATE TABLE IF NOT EXISTS assignment_records (
  id           TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('excellent','normal','late','missing','slack','copy')),
  issue_note   TEXT NOT NULL DEFAULT '',
  rectify_note TEXT NOT NULL DEFAULT '',
  recorded_at  TEXT NOT NULL,
  UNIQUE (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_arec_student ON assignment_records(student_id);

CREATE TABLE IF NOT EXISTS moral_records (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('emotion','family','relationship','conduct','reward','punish','volunteer','other')),
  stage       TEXT NOT NULL CHECK (stage IN ('primary','middle')),
  content     TEXT NOT NULL,
  follow_up   TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moral_student_date ON moral_records(student_id, date DESC);

CREATE TABLE IF NOT EXISTS talents (
  id         TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  name       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT '',
  potential  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_talents_student ON talents(student_id);

CREATE TABLE IF NOT EXISTS honors (
  id          TEXT PRIMARY KEY,
  student_id  TEXT REFERENCES students(id) ON DELETE CASCADE,
  class_id    TEXT REFERENCES classes(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('school','district','city','province','national')),
  event       TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL,
  material_id TEXT REFERENCES materials(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  CHECK (student_id IS NOT NULL OR class_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_honors_student ON honors(student_id);
CREATE INDEX IF NOT EXISTS idx_honors_class ON honors(class_id);

CREATE TABLE IF NOT EXISTS materials (
  id          TEXT PRIMARY KEY,
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('student','class')),
  student_id  TEXT REFERENCES students(id) ON DELETE CASCADE,
  class_id    TEXT REFERENCES classes(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN ('class_performance','sports','activity','daily','award_cert','class_honor','photo','df_activity','df_honor','other')),
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  event_date  TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  semester    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  CHECK ((owner_type='student' AND student_id IS NOT NULL) OR (owner_type='class' AND class_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_materials_owner ON materials(owner_type, student_id, class_id);
CREATE INDEX IF NOT EXISTS idx_materials_semester ON materials(semester, class_id);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('talk','home_school','periodic')),
  stage       TEXT NOT NULL CHECK (stage IN ('primary','middle')),
  content     TEXT NOT NULL,
  period      TEXT NOT NULL DEFAULT '',
  saved       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_student ON comments(student_id, type);

CREATE TABLE IF NOT EXISTS phrases (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL CHECK (category IN ('homework','supervise','safety','material','custom')),
  stage      TEXT NOT NULL CHECK (stage IN ('primary','middle')),
  tone       TEXT NOT NULL CHECK (tone IN ('strict','gentle')),
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  favorite   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phrases_cat ON phrases(category, stage);

CREATE TABLE IF NOT EXISTS layers_snapshot (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL CHECK (stage IN ('primary','middle')),
  rule_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layers_class ON layers_snapshot(class_id);

CREATE TABLE IF NOT EXISTS student_layers (
  id          TEXT PRIMARY KEY,
  class_id    TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  layer       TEXT NOT NULL CHECK (layer IN ('advanced','middle','basic')),
  source      TEXT NOT NULL CHECK (source IN ('auto','manual')),
  updated_at  TEXT NOT NULL,
  UNIQUE (class_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_sl_class ON student_layers(class_id, layer);

CREATE TABLE IF NOT EXISTS communications (
  id                TEXT PRIMARY KEY,
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id          TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('talk','home_visit','parent_meet','chat')),
  date              TEXT NOT NULL,
  time              TEXT NOT NULL DEFAULT '',
  location          TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  sync_status       TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','synced','failed')),
  calendar_event_id TEXT NOT NULL DEFAULT '',
  calendar_semester_id TEXT NOT NULL DEFAULT '',
  sync_error        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comms_date ON communications(date);
CREATE INDEX IF NOT EXISTS idx_comms_sync ON communications(sync_status);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id          TEXT PRIMARY KEY,
  library     TEXT NOT NULL CHECK (library IN ('classic','psychology','master','quote')),
  category    TEXT NOT NULL CHECK (category IN ('class_management','problem_student','cross_stage','home_school','df_teaching','mental_health','self_growth')),
  stage       TEXT NOT NULL DEFAULT 'all' CHECK (stage IN ('all','primary','middle')),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  favorite    INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ki_lib ON knowledge_items(library, category);
CREATE INDEX IF NOT EXISTS idx_ki_fav ON knowledge_items(favorite);

CREATE TABLE IF NOT EXISTS push_logs (
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('manager','df_teaching','psychology','quote')),
  item_id     TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  round       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (date, kind)
);

CREATE TABLE IF NOT EXISTS undo_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  op          TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  ts          TEXT NOT NULL
);

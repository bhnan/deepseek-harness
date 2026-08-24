# 数据 Schema 规范 —— 教师教学工作日历

日期：2026-08-19
状态：v1 定稿（随总览需求规划收官定稿）。本文档是数据管道（Python 写入）与 DSH 插件前端（TypeScript 读取）之间数据结构的**权威定义**；`2026-08-19-teacher-calendar-data-requirements.md` 的实体清单与本文件字段完全一致，字段定义以本文件为准。

## 1. 核心原则

1. **版本化**：每个数据文件顶层携带 `schema_version`（字符串 `"major.minor"`）。minor 演进只增字段（读取方按默认值兼容旧文件）；major 演进才允许删改字段，须提供迁移脚本（§3.5）。
2. **学期隔离（G6）**：学期业务数据（固定排课/临时调课/授课内容/事件/生日）按学期目录 `data/<semester_id>/` 隔离存放，互不覆盖、永久留存、可历史回溯；全局资产（班级库/主题/词库/设置）存 `data/_global/`。跨学期引用一律禁止。
3. **派生字段分层、不落库（R1/R3/R4/R6）**：学期总周数、当前周、月视图周次栏、进度百分比、当日课表（固定排课+临时调课合并）、课程顺延结果均为派生值，由规则引擎实时计算，**不写入任何数据文件**；存储中只保留计算输入（起止日期、固定课程、临时调课等）。schema 中不出现派生字段，避免双写不一致。
4. **枚举约束**：全部枚举字段在 Python jsonschema 与 TS zod 双侧硬校验——未知值写入被拒（Python fail-fast），读取时降级占位（TS，不崩溃）。
5. **命名一致**：JSON 字段统一**英文 snake_case**（跨 Python/TS 安全）；中文仅出现在 CSV 模板表头（I1 用户填写界面）与界面显示文案。中文列名 → 字段映射只存在于导入模板定义（§2.12）。**两份数据文档的字段名、类型、枚举完全一致，本文件为权威。**

### 全局格式约定

| 项 | 约定 |
|----|------|
| 日期 | ISO 8601 `YYYY-MM-DD`（如 `2026-09-01`） |
| 生日月日 | ISO 8601 无年日期 `--MM-DD`（如 `--11-09`） |
| 时间 | `HH:MM`（24 小时制，如 `14:00`） |
| 时间戳 | RFC 3339 带时区（本地 `+08:00`，如 `2026-08-19T10:00:00+08:00`） |
| 颜色 | hex `#RRGGBB`（大写十六进制，如 `#4C8BF5`） |
| id | 通用 `<前缀>-<8位十六进制>`（如 `cls-3f2a1b9c`）；学期 id 结构化 `{year}-{spring\|autumn}-{1\|2}`；词库 id 序号化（`ce-0001` / `tp-01`） |
| 文件顶层信封 | `{"schema_version": "1.0", "data_quality"?: {...}, "data": {...}}`；`data_quality` 可选，损坏/降级时由校验工具标注（X4）；无 meta 信封 |

## 2. 各实体字段级定义

### 2.1 semester（D1/R2，学期注册表）—— 数据文件 `data/semesters.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {
        "id": "2026-autumn-1",
        "name": "2026秋季第一学期",
        "year": 2026,
        "season": "autumn",
        "semester_index": 1,
        "start_date": "2026-09-01",
        "end_date": "2027-01-17",
        "created_at": "2026-08-19T10:00:00+08:00",
        "updated_at": "2026-08-19T10:00:00+08:00"
      }
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | 学期唯一标识，结构化 `{year}-{spring\|autumn}-{1\|2}`，与学期目录名一致 | — |
| name | string | 是 | 标准化显示名「年份+春季/秋季+第一/第二学期」；校验断言其等于 year/season/semester_index 生成的规范名 | — |
| year | integer | 是 | 学年起始年份 | 如 `2026` |
| season | string | 是 | 学期季节 | `spring` / `autumn` |
| semester_index | integer | 是 | 学期序号 | `1` / `2` |
| start_date | string | 是 | 开学日期（ISO 日期） | — |
| end_date | string | 是 | 放假结束日期（学期最后一天），须晚于 start_date | — |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- **名称-日期强制联动绑定（R2）**：内置绑定表——`2026秋季第一学期 = 2026-09-01 ~ 2027-01-17`；`2027春季第二学期 = 2027-02-22 ~ 2027-07-06`。新建学期按 year/season/semester_index 查绑定表自动填默认起止日期；编辑学期弹窗内可查看/修改起止日期（F1）。
- **派生（不落库）**：学期总周数、当前周、进度百分比、月视图周次栏——由规则引擎 R1/R6 依 start_date/end_date 实时计算（见 §2.14）。
- **管理完全开放**：可自由新建/编辑/删除任意学期（含系统默认，无灰显无拦截）；删除默认移入回收目录（见待确认项 9）。

### 2.2 class（D2，班级库）—— 数据文件 `data/_global/classes.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "cls-3f2a1b9c", "stage": "middle", "name": "七（1）班", "color": "#4C8BF5", "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"},
      {"id": "cls-8a7b6c5d", "stage": "primary", "name": "启航班", "color": "#F5A623", "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `cls-<8位十六进制>` | — |
| stage | string | 是 | 学段，小学/初中双独立预设库、学段分离自由切换（F5） | `primary`（小学）/ `middle`（初中） |
| name | string | 是 | 自定义班级名称，任意格式（七（1）班、启航班等） | — |
| color | string | 是 | 专属固定配色 hex；新增课程下拉选班自动匹配预设颜色，禁手输、禁临时取色（F5） | hex `#RRGGBB` |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- 无数量限制（5-8+ 个班）；班级库**跨学期全局共享**（同一教师多年复用）。
- 被固定课程/授课内容/生日引用的班级删除受引用保护（§3.7），防止悬空引用。

### 2.3 fixed_course（D3，固定排课）—— 数据文件 `data/<semester_id>/fixed_courses.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "fc-a1b2c3d4", "class_id": "cls-3f2a1b9c", "weekday": 1, "period": 2, "done_dates": ["2026-09-01"], "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-09-01T12:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `fc-<8位十六进制>` | — |
| class_id | string | 是 | 授课班级，引用 class.id（D2） | — |
| weekday | integer | 是 | 星期几（ISO 8601，周一=1） | 1–7 |
| period | integer | 是 | 节次（默认上限 1–12，可配置） | ≥1 |
| done_dates | string[] | 否 | 该课程已完成上课的日期列表（F2 今日待办完成状态，按日记录，可随时取消，永久留存；默认 `[]`） | ISO 日期数组 |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- **固定排课**：班级排课每周固定复用（D3/F4），无 date/week 字段——视图按学期周展开。
- **派生（不落库）**：当日课表 = 固定排课 + 临时调课合并结果（R4）；课程顺延后时段（R3）；「本学期第 X 周」周数（R1）。
- 唯一约束：同一 class_id + weekday + period 唯一（写入前校验；冲突由 R3 顺延逻辑消除）。
- 批量导入走 I1 courses_import 模板。

### 2.4 temporary_change（R4，临时调课，D3 族）—— 数据文件 `data/<semester_id>/temporary_changes.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "tch-9f8e7d6c", "fixed_course_id": "fc-a1b2c3d4", "class_id": "cls-3f2a1b9c", "week": 5, "original_date": "2026-09-29", "original_period": 2, "new_date": "2026-10-01", "new_period": 3, "note": "与周三对调", "done": false, "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `tch-<8位十六进制>` | — |
| fixed_course_id | string | 是 | 被调课的固定课程，引用 fixed_course.id（D3） | — |
| class_id | string | 是 | 授课班级（冗余，便于按班查询），引用 class.id | — |
| week | integer | 是 | 生效周，学期周序号（R1 口径，1 起） | 1–学期总周数 |
| original_date | string | 是 | 原上课日（ISO 日期） | — |
| original_period | integer | 是 | 原节次 | ≥1 |
| new_date | string | 是 | 调课后新上课日（ISO 日期） | — |
| new_period | integer | 是 | 调课后新节次 | ≥1 |
| note | string | 否 | 调课说明 | — |
| done | boolean | 否 | 是否已完成（F2 今日待办完成状态；默认 `false`） | `true` / `false` |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- **临时调课仅当周生效（R4）**：week 为单一取值，下周自动恢复固定排课；与固定排课的合并为派生（不落库）。
- 区分明确：**固定排课**长期复用（§2.3），**临时调课**只影响指定周。

### 2.5 teaching_content（D4，授课内容）—— 数据文件 `data/<semester_id>/teaching_content.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "tc-1a2b3c4d", "class_id": "cls-3f2a1b9c", "week": 1, "weekday": 1, "period": 1, "content": "第一课·一.1", "source": "preset", "preset_id": "tp-01", "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"},
      {"id": "tc-2b3c4d5e", "class_id": "cls-3f2a1b9c", "week": 1, "weekday": 3, "period": 2, "content": "第一课·一.2", "source": "custom", "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `tc-<8位十六进制>` | — |
| class_id | string | 是 | 授课班级，引用 class.id | — |
| week | integer | 是 | 学期周序号（与周视图「本学期第 X 周」同口径） | 1–学期总周数 |
| weekday | integer | 否 | 星期（1=周一 … 7=周日）；该班每周仅一节课时可省略 | 1–7 |
| period | integer | 否 | 当日节次（1 起）；该班每周仅一节课时可省略 | ≥1 |
| content | string | 是 | 授课内容最终文本（词库选中或手动自定义） | — |
| source | string | 是 | 内容来源 | `preset`（预设词库下拉选填）/ `custom`（手动自定义） |
| preset_id | string | 否 | source=preset 时必填，引用授课预设词库 id（`tp-`） | — |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- **授课班级/授课内容双模块解耦（F4）**：班级排课在 fixed_course 每周固定复用，授课内容按「班级+周+课时位」独立更新——改排课不影响内容、改内容不影响排课。
- **内容序列（R3 顺延的运算对象）**：同一班级的全部内容条目按 `(week, weekday, period)` 升序排列即构成该班**授课内容序列**（如 [一.1, 一.2, 一.3, 一.4]）；顺延 = 替换某课时位内容后，该位置之后的内容**链式后移**到该班后续课时位（改写 week/weekday/period 归属，规则见 rule-spec §2.3 SH1–SH8）。
- 唯一约束：class_id + week + weekday + period（weekday/period 省略时退化为 class_id + week，每周每班一条）。
- 预设词库见 §2.9 teaching_preset（D4 子资产，内置静态）。

### 2.6 event（D5，事务/事件）—— 数据文件 `data/<semester_id>/events.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "ev-5a6b7c8d", "type": "activity", "title": "期中考试监考", "date": "2026-11-09", "time": "14:00", "location": "教学楼 A 栋", "participants": ["初一全体教师"], "notes": "提前 20 分钟到场", "requirements": "携带监考牌", "color": "#E8A33D", "done": false, "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `ev-<8位十六进制>` | — |
| type | string | 是 | 事件类型（事务两类：课程/活动；学期视图统一归类左侧标准事件体系，类型精简去重） | `course`（课程）/ `activity`（活动） |
| title | string | 是 | 事件标题 | — |
| date | string | 是 | 事件日期（ISO 日期） | — |
| time | string | 否 | 时间（五要素详情之「时间」） | `HH:MM` |
| location | string | 否 | 地点（五要素详情之「地点」） | — |
| participants | string[] | 否 | 参与人员（五要素详情之「参与人员」） | — |
| notes | string | 否 | 注意事项（五要素详情之「注意事项」） | — |
| requirements | string | 否 | 工作要求（五要素详情之「工作要求」） | — |
| color | string | 是 | 类型专属分类配色，支持用户自主修改（F11） | hex `#RRGGBB` |
| done | boolean | 否 | 是否已完成（F2 今日待办完成状态；默认 `false`） | `true` / `false` |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- **五要素详情** = time/location/participants/notes/requirements，事件自定义详情完整承载。
- 精准筛选（F12）按 type 单选/多选、一键恢复全显（前端行为，存储只依赖 type 枚举）。
- 生日事件统一归入学期视图左侧事件体系（F10），但生日数据实体独立（D6，§2.7）——学期视图将生日作为第三类**呈现**（前端合并展示，不落库为 event）。

### 2.7 birthday（D6，师生生日）—— 数据文件 `data/<semester_id>/birthdays.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "bd-7c8d9e0f", "role": "student", "name": "李明", "birthday": "--11-09", "class_id": "cls-3f2a1b9c", "note": "", "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"},
      {"id": "bd-0f1e2d3c", "role": "teacher", "name": "王芳", "birthday": "--03-02", "class_id": null, "note": "", "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `bd-<8位十六进制>` | — |
| role | string | 是 | 身份 | `teacher`（教师）/ `student`（学生） |
| name | string | 是 | 姓名 | — |
| birthday | string | 是 | 生日，ISO 8601 无年日期；闰年 `--02-29` 允许，非闰年展示由规则引擎 R7 处理 | `--MM-DD` |
| class_id | string/null | 否 | 学生所属班级，引用 class.id；教师可为 `null` | — |
| note | string | 否 | 备注 | — |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- **R7 展示规则**：仅周视图顶部星期日期栏展示姓名 + 月视图对应日期轻量化提醒，**课时区禁重复展示、不遮挡**——为前端/规则引擎约束，非存储约束。
- 批量导入/导出走 I1（birthdays_import / birthdays_export 模板）。

### 2.8 theme（D7，主题配置）—— 数据文件 `data/_global/theme.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "themes": {
      "fresh": {
        "name": "经典小清新",
        "day_bg": {"workday": "#FFFFFF", "weekend_holiday": "#F0F4FF", "today": "#E8F4FD"},
        "course_area_today_bg": "#D6E9FF",
        "font": {"family": "PingFang SC, Microsoft YaHei, sans-serif", "size": 14, "weight": "normal"},
        "accent": "#4C8BF5"
      },
      "guofeng":   {"name": "国风雅致",   "day_bg": {"workday": "#FFFDF5", "weekend_holiday": "#F5EDE0", "today": "#FBEED8"}, "course_area_today_bg": "#F3E3C8", "font": {"family": "Songti SC, SimSun, serif", "size": 14, "weight": "normal"}, "accent": "#8B5E3C"},
      "minimal":   {"name": "极简艺术",   "day_bg": {"workday": "#FAFAFA", "weekend_holiday": "#F0F0F0", "today": "#ECECEC"}, "course_area_today_bg": "#E2E2E2", "font": {"family": "Helvetica Neue, Arial, sans-serif", "size": 14, "weight": "normal"}, "accent": "#333333"},
      "tech":      {"name": "轻量科技",   "day_bg": {"workday": "#F8FAFC", "weekend_holiday": "#E2E8F0", "today": "#DBEAFE"}, "course_area_today_bg": "#BFDBFE", "font": {"family": "SF Pro Display, Segoe UI, sans-serif", "size": 14, "weight": "normal"}, "accent": "#2563EB"},
      "warm":      {"name": "温柔治愈暖风", "day_bg": {"workday": "#FFF9F5", "weekend_holiday": "#FDE8E0", "today": "#FFE3D6"}, "course_area_today_bg": "#FFD2BE", "font": {"family": "PingFang SC, Microsoft YaHei, sans-serif", "size": 14, "weight": "normal"}, "accent": "#E8836A"}
    }
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| themes | object | 是 | 五套主题定义，键为 theme_id | `fresh` / `guofeng` / `minimal` / `tech` / `warm` |
| themes[].name | string | 是 | 主题中文名 | 经典小清新 / 国风雅致 / 极简艺术 / 轻量科技 / 温柔治愈暖风 |
| themes[].day_bg | object | 是 | **日期底色三层级**（F14） | — |
| day_bg.workday | string | 是 | 工作日统一底色 | hex `#RRGGBB` |
| day_bg.weekend_holiday | string | 是 | 周末与法定节假日专属区分底色 | hex `#RRGGBB` |
| day_bg.today | string | 是 | 当日柔和高亮底色 | hex `#RRGGBB` |
| course_area_today_bg | string | 是 | 当日课程区域柔和底色（无边框，浅蓝/浅粉系）；仅顶部星期表头可高亮（F4） | hex `#RRGGBB` |
| font | object | 否 | 字体规范（字体工整舒适、重点适度突出、简洁高级） | — |
| font.family | string | 否 | 字体族 | — |
| font.size | integer | 否 | 字号（px） | ≥12 |
| font.weight | string | 否 | 字重 | `normal` / `medium` / `bold` |
| accent | string | 否 | 主题强调色 | hex `#RRGGBB` |

补充说明：

- 当前选中主题只存于 settings.json 的 `theme_id`（D9）；theme.json 为五套主题的**静态定义**（内置静态资产，随应用版本更新），仅变更视觉样式、不改数据功能布局逻辑（F14）；用户编辑色板留 P1（见待确认项 6）。
- 日期底色三层级与 G5 节假日标注配合：节假日文字提醒由 holidays.json（§2.13）驱动，底色按 day_bg.weekend_holiday 呈现。

### 2.9 culture_entry 与 teaching_preset（D8/D4 词库，内置静态）—— 数据文件 `data/_global/culture_library.json`、`data/_global/teaching_presets.json`

culture_entry（素养词库，D8/C1）：

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "ce-gy-0001", "category": "education_proverb", "original_text": "学而不思则罔，思而不学则殆", "vernacular_translation": "只学习不思考就会迷惘，只思考不学习就会疑惑", "plain_explanation": "强调学与思必须结合，缺一不可，可用于启发式教学讨论", "tags": ["论语", "学思结合"], "difficulty": "入门", "source": "《论语·为政》", "created_at": "2026-08-19T00:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `ce-<类别码前缀>-<4位序号>`（全局唯一，类别码前缀：gy 古语 / sc 诗词 / ln 理念 / ll 理论 / xl 心理） | — |
| category | string | 是 | 内容类别（五大类，**与内容库规范 §2.0 类别码一致**） | `education_proverb`（教育古语）/ `classic_poetry`（古典诗词）/ `education_philosophy`（国内外教育理念）/ `education_theory`（教育学理论）/ `education_psychology`（教育心理学知识点） |
| original_text | string | 是 | 原文（文言内容为原文，非文言类为标题或要点） | — |
| vernacular_translation | string | 文言类必填 | 白话翻译（教育古语/古典诗词**必填**；其余类原文为文言或外文时建议填写） | — |
| plain_explanation | string | 是（所有类） | 通俗释义（面向教师、结合课堂场景的解读，写作规范见内容库规范 §6.2） | — |
| tags | string[] | 是 | 适用场景标签（建议 1–3 个） | — |
| difficulty | string | 否 | 难度标记 | `入门` / `进阶` / `专业` |
| source | string | 否（推荐填） | 来源出处（典籍/著作/译本，保证可查证） | — |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |

> 字段名/类别码/必填规则与内容库规范（content-library-spec）§2–§3 **逐字段一致**；内容库规范为内容语义权威，本表为存储结构权威。

teaching_preset（授课内容预设词库，D4 子资产）：

```json
{
  "schema_version": "1.0",
  "data": {
    "items": [
      {"id": "tp-01", "text": "遵守规则与法律", "tags": ["法治", "七年级"], "created_at": "2026-08-19T00:00:00+08:00"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| id | string | 是 | `tp-<序号>` | — |
| text | string | 是 | 预设授课内容文本（词库下拉选填） | — |
| tags | string[] | 否 | 标签 | — |
| created_at | string | 是 | 创建时间戳（RFC 3339） | — |

补充说明：

- 两个词库均为**内置静态词库**（已确认决策：种子脚本生成 + 人工校订，见总览 §4 D3）；用户增删改词条留 P1（C3）。
- 素养词库规模与轮换策略见内容库规范（content-library-spec）C1/C2。

### 2.10 push_state（D8，推送状态）—— 数据文件 `data/<semester_id>/push_state.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "by_date": {"2026-09-01": "ce-gy-0001", "2026-09-02": "ce-sc-0001"},
    "pushed_ids": ["ce-gy-0001", "ce-sc-0001"],
    "round": 1,
    "updated_at": "2026-08-19T10:00:00+08:00"
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| by_date | object | 是 | **按日期键控**：日期（ISO `YYYY-MM-DD`）→ 当日推送词条 id；当天首次打开命中即幂等展示，未命中才选条落盘（对齐内容库规范 §4.2，不依赖"上次推送时间"） | — |
| pushed_ids | string[] | 是 | 已推送词条 id 列表（**全库无重复推送**的去重依据，C2；同轮内选中即永不重复） | — |
| round | integer | 是 | 当前轮次（词库推尽后重置 pushed_ids 并 +1，卡片标注「第二轮」） | ≥1 |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

补充说明：

- 每日自动更新 + 手动刷新换内容、无重复推送、耗尽后"第二轮"行为由内容库规范 §4 的 C2 算法驱动；本文件只记录推送**状态**，明日选词算法不落库。
- **按学期隔离存储**（对齐内容库规范 §4.7：推送状态不跨学期保留，每学期一轮，避免第二学期可用池骤减；历史 `by_date` 随学期目录保留可回溯）。词库本体 `culture_library.json` 仍为全局共享静态资产。

### 2.11 settings（D9，设置与元数据 + 撤销栈）—— 数据文件 `data/_global/settings.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "current_semester_id": "2026-autumn-1",
    "preferred_view": "week",
    "theme_id": "fresh",
    "undo_stack": [
      {"op": "delete", "entity": "event", "entity_id": "ev-5a6b7c8d", "semester_id": "2026-autumn-1", "snapshot_before": {"id": "ev-5a6b7c8d", "type": "activity", "title": "期中考试监考", "date": "2026-11-09", "time": "14:00", "location": "教学楼 A 栋", "participants": ["初一全体教师"], "notes": "提前 20 分钟到场", "requirements": "携带监考牌", "color": "#E8A33D", "done": false, "created_at": "2026-08-19T10:00:00+08:00", "updated_at": "2026-08-19T10:00:00+08:00"}, "snapshot_after": null, "ts": "2026-08-19T10:05:00+08:00"}
    ],
    "redo_stack": [],
    "updated_at": "2026-08-19T10:05:00+08:00"
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| current_semester_id | string | 是 | 当前学期 id，引用 semesters.json（F1 学期标准化下拉） | — |
| preferred_view | string | 是 | 视图偏好持久化（G1 三视图自由切换） | `week` / `month` / `semester` |
| theme_id | string | 是 | 当前主题 id（F14 五套主题一键切换），引用 theme.json 的键 | `fresh` / `guofeng` / `minimal` / `tech` / `warm` |
| undo_stack | array | 是 | 撤销栈（G3/R5），条目结构见下 | — |
| redo_stack | array | 是 | 恢复栈（G3/R5），条目结构同 undo_stack | — |
| updated_at | string | 是 | 最后修改时间戳（RFC 3339） | — |

**撤销栈条目（undo_stack / redo_stack 共用的操作快照）**：

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| op | string | 是 | 操作类型 | `create` / `update` / `delete` |
| entity | string | 是 | 目标实体类型 | `semester` / `class` / `fixed_course` / `temporary_change` / `teaching_content` / `event` / `birthday` / `theme` / `settings` |
| entity_id | string | 是 | 目标实体 id | — |
| semester_id | string/null | 否 | 学期内实体必填（定位回写目标学期文件）；全局实体（class/theme/settings）可为 `null` | — |
| snapshot_before | object/null | 是 | 操作前完整实体 JSON 快照；create 为 `null` | — |
| snapshot_after | object/null | 是 | 操作后完整实体 JSON 快照；delete 为 `null` | — |
| ts | string | 是 | 操作时间戳（RFC 3339） | — |

补充说明：

- undo 取 `snapshot_before` 回写、redo 取 `snapshot_after`；支持多步回溯与恢复（R5）。
- **栈按学期过滤**：栈物理全局存放于 settings.json，但撤销/恢复时仅作用于当前学期（按条目 `semester_id` 过滤，对齐规则护栏文档 UN4「栈按学期隔离，切换学期不串栈」）。
- 栈上限 **100 条环形覆盖**（超出丢弃最旧；对齐规则护栏文档 UN5/C6 建议值，最终以用户拍板为准）；快照为实体完整 JSON（含该实体全部字段）。
- **事务性（与 rule-spec R5 兼容）**：增删改操作先写栈快照、再写业务文件；任一文件写入失败则回滚已写文件（原子写入 + manifest 恢复），保证栈与数据一致。
- 全局存放覆盖所有作用域（学期内实体与全局实体均可撤销），与总览 §2.2 `meta/settings.json（含主题/撤销栈）` 对齐。

### 2.12 import_template（I1，导入导出模板定义）—— 由导入导出器内置（不落盘为业务数据）

```json
{
  "template_id": "birthdays_import",
  "name": "师生生日导入模板",
  "columns": [
    {"key": "role", "csv_header": "身份", "required": true, "type": "enum", "enum": ["teacher", "student"], "note": "教师/学生"},
    {"key": "name", "csv_header": "姓名", "required": true, "type": "string", "note": "必填"},
    {"key": "birthday", "csv_header": "生日", "required": true, "type": "month_day", "format": "--MM-DD", "note": "如 11-09"},
    {"key": "class_name", "csv_header": "班级名称", "required": false, "type": "string", "note": "学生必填、教师可空；按名称匹配班级库"}
  ]
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| template_id | string | 是 | 模板标识 | `classes_import` / `birthdays_import` / `courses_import` / `events_export` / `birthdays_export` / `backup_export` |
| name | string | 是 | 模板中文名 | — |
| columns | array | 是 | 列定义（CSV 首行即各列 csv_header） | — |
| columns[].key | string | 是 | 内部字段名（与本文档实体字段名一致） | — |
| columns[].csv_header | string | 是 | CSV 表头中文列名（用户填写界面；中文→字段映射仅存在于此处） | — |
| columns[].required | boolean | 是 | 是否必填列 | — |
| columns[].type | string | 是 | 值类型 | `string` / `enum` / `integer` / `month_day` / `color` |
| columns[].enum | string[] | 否 | type=enum 时取值列表 | — |
| columns[].format | string | 否 | 格式说明（如 `--MM-DD`） | — |
| columns[].note | string | 否 | 填写提示 | — |

各模板列定义（CSV 模板字段全集，与 I1 一致）：

| 模板 | 列（csv_header → 字段） |
|------|------------------------|
| classes_import 班级导入 | 学段→stage、班级名称→name、配色→color（可选） |
| birthdays_import 生日导入 | 身份→role、姓名→name、生日→birthday（`--MM-DD`）、班级名称→class_name（可选） |
| courses_import 课表导入 | 星期→weekday（周一..周日）、节次→period、班级名称→class_name、授课内容→content（可选） |
| events_export 事件导出 | 类型→type、标题→title、日期→date、时间→time、地点→location、参与人员→participants、注意事项→notes、工作要求→requirements、配色→color |
| birthdays_export 生日导出 | 身份→role、姓名→name、生日→birthday、班级名称→class_name |
| backup_export 备份导出 | 学期目录全量打包（zip + X4 manifest），非 CSV |

补充说明：CSV 首行表头、UTF-8 with BOM（Excel 兼容）、空行忽略、错误行记录不中断（导入报告逐行标注）；批量导入/导出由 `scripts/importers/` 实现（总览 §2.4 ①），CSV 优先、Excel 兼容（openpyxl/pandas 读）。

### 2.13 辅助静态资产 holidays（G5 支撑，不占 D 编号）—— 数据文件 `data/_global/holidays.json`

```json
{
  "schema_version": "1.0",
  "data": {
    "holidays": [
      {"name": "国庆节", "start_date": "2026-10-01", "end_date": "2026-10-07"},
      {"name": "中秋节", "start_date": "2026-09-25", "end_date": "2026-09-25"}
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 | 枚举值 |
|------|------|------|------|--------|
| holidays | array | 是 | 法定节假日列表 | — |
| holidays[].name | string | 是 | 节日名称 | — |
| holidays[].start_date | string | 是 | 起始日（ISO 日期） | — |
| holidays[].end_date | string | 是 | 结束日（ISO 日期），须 ≥ start_date | — |

补充说明：支撑 **G5 节假日全域标注**（法定节假日自动显示节日名称，无论是否放假均文字提醒）；内置静态、随应用版本更新（每年国务院放假安排发布后更新）；缺失时文字提醒不显示、底色按周末处理（§数据需求 4）。

### 2.14 派生字段清单（不落库，规则引擎实时计算）

| 派生值 | 计算依据（存储输入） | 对应规则 |
|--------|----------------------|---------|
| 学期总周数 | semester.start_date / end_date | R1 |
| 当前周（本学期第 X 周） | start_date + 今天 | R1/F4 |
| 月视图左侧周次栏（全月完整显示） | start_date + 月份区间 | R1/F8 |
| 学期进度百分比 | start_date / end_date + 今天 | R6/F1 |
| 当日课表（固定排课 + 临时调课合并） | fixed_courses + temporary_changes | R4/F2 |
| 课程顺延后时段（中间新增后续后移） | fixed_courses + 插入操作 | R3/F7 |
| 当日生日名单（周/月视图） | birthdays（`--MM-DD` 匹配今天） | R7/F8 |

以上均为规则引擎（rule-spec R1–R7）的输出，数据层不存储，避免双写不一致。

## 3. 工程护栏

1. **JSON 合法性**：写入一律 `json.dumps(allow_nan=False, ensure_ascii=False)` —— NaN/Infinity 出现即抛错终止，绝不写出非法 JSON；文件统一 UTF-8 编码。
2. **大整数断言**：任何数值 > 2^53 必须转字符串（JS Number 精度安全）。本项目数值域（年份 2026、节次、周数、栈条数）远小于该值，护栏保留以约束未来字段。
3. **原子写入（X3）**：所有数据文件（全局 + 学期）写入采用「同目录临时文件 + os.replace(rename)」，写入中途崩溃不留半截文件；写入成功后更新 X4 manifest（`data/manifest.json`，每文件 sha256 + 行数 + 更新时间）。
4. **事务性与撤销（R5 兼容）**：对任何实体执行 create/update/delete 时，先写 settings.json 的 undo_stack 快照（新条目），再写业务文件；任一文件写入失败则回滚已写文件（原子写入 + manifest 恢复），保证栈与数据一致。
5. **版本演进**：`schema_version` 为 `"major.minor"` 字符串；minor 只增字段（读取方按默认值兼容旧文件）；major 才允许删改字段，须提供迁移脚本（`scripts/migrate/`）且迁移在写入前于校验工具中验证；读取方按版本选择解析，未知 minor 拒绝写入、允许读取。
6. **枚举与格式硬校验**：全部枚举字段（§2 各表「枚举值」列）在 jsonschema（Python 写）与 zod（TS 读）双侧校验；日期/时间/hex 格式正则校验；weekday ∈ 1–7；week ≥ 1；period ≥ 1。
7. **引用完整性**：class_id / fixed_course_id / preset_id / current_semester_id / current_entry_id 的引用存在性由 `scripts/validate_schemas.py --check-data` 跨文件检查；被引用实体删除受引用保护（界面显示「已删除」占位，实体不自动删）。
8. **唯一约束**：fixed_course（class_id+weekday+period）、teaching_content（class_id+week）、birthday（class_id+name+birthday）唯一，写入前校验；冲突由导入报告或规则引擎（R3 顺延）处理。

## 4. 校验架构（X1/X2）

```text
① Python 写出校验（jsonschema，fail-fast）  —— scripts/validate_schemas.py --check-schemas / --check-data
② 传输只读不转换                            —— DSH host 路由读数据文件原样转发给 client，不做字段转换
③ TS 读入 zod 解析，失败 → 降级占位不崩溃   —— client 对每实体 zod schema 解析，失败渲染空态/「数据不可用」标注
```

- JSON Schema 文件（对应总览 §2.2）：`schemas/semesters/semester.json`、`schemas/classes/class.json`、`schemas/schedules/fixed_course.json`、`schemas/schedules/temporary_change.json`、`schemas/events/event.json`、`schemas/events/birthday.json`、`schemas/content/culture_entry.json`、`schemas/content/push_state.json`、`schemas/meta/settings.json`（含主题 themes 子结构与撤销栈条目子结构）；theme.json 数据文件复用 settings.json schema 的 themes 子结构（归属见待确认项 11）；import 模板 schema（`schemas/imports/`）实现期补充。
- fixtures（X2）：`schemas/fixtures/valid_cases/` 与 `invalid_cases/`，覆盖枚举越界、日期格式错误、引用悬空、NaN、缺必填、唯一约束冲突等合法/非法样例。
- 双端一致性：jsonschema 与 zod 由同一份字段定义表生成/核对（实现期用 `scripts/gen_zod_from_schema.py` 或人工对照 + 契约测试保证），确保两份数据文档与两端校验完全一致。

## 5. 待确认项

| # | 项 | 现状/选项 |
|---|----|----------|
| 1 | 文件顶层信封（`schema_version` + 可选 `data_quality` + `data`，无 meta 信封） | 本方案，待认可 |
| 2 | 字段命名英文 snake_case；中文仅限 CSV 表头（§2.12） | 本方案，待认可 |
| 3 | 生日格式 `--MM-DD`（ISO 8601 无年日期）vs 简化 `MM-DD` | 本方案用 `--MM-DD`，待认可 |
| 4 | 撤销/恢复栈上限 100 条环形覆盖（对齐 rule-spec C6 建议值） | 待认可 |
| 5 | temporary_change 必绑 fixed_course_id（不支持无固定课程的纯临时课） | 待认可 |
| 6 | theme.json 五套主题定义内置静态（当前选中存 settings）；用户编辑色板留 P1 | 待认可 |
| 7 | holidays.json 内置静态、随应用版本更新 | 待认可 |
| 8 | 节次 period 上限默认 1–12，可配置 | 待认可 |
| 9 | 删除学期默认移入 `data/_trash/<semester_id>_<ts>/` 回收目录（可恢复），清理策略待定 | 待认可 |
| 10 | schema_version 起步值 `1.0` | 待认可 |
| 11 | theme.json 的 JSON Schema 归属（并入 schemas/meta/settings.json 或独立 schemas/meta/theme.json） | 待认可 |
| 12 | 导入模板 schema（schemas/imports/）实现期补充 | 待认可 |

## 6. 与其他文档的关系

- `2026-08-19-teacher-calendar-data-requirements.md`：实体清单、存储/隔离/缺失降级设计来源；本文件为其**字段级权威**（两份文档字段名、类型、枚举完全一致，以本文件为准）。
- `2026-08-19-teacher-calendar-rule-spec.md`：R1 周数、R3 顺延、R4 临时调课合并、R5 撤销事务、R6 进度、R7 生日展示——派生值边界见 §2.14，撤销快照形态见 §2.11；本文件存储字段与 rule-spec 兼容（周数/进度不落库、撤销栈存操作快照）。
- `2026-08-19-teacher-calendar-content-library-spec.md`：C1 词条字段（§2.9）与 C2 推送算法（push_state 状态字段 §2.10）对接。
- `2026-08-19-teacher-calendar-overview.md`：编号 D1–D9/I1、R1–R7、C1–C3、F1–F14、G1–G6、X1–X4 原样引用；schema 文件目录见总览 §2.2。
- `2026-08-19-teacher-calendar-frontend-requirements.md`：F1–F14 界面行为 → 实体映射见数据需求文档 §1。
- 工程风格参考：`归档/2026-08-15-data-schema-spec.md`（工程护栏与校验架构同款：allow_nan=False、UTF-8、大整数断言、minor/major 演进、jsonschema fail-fast + zod 降级）。

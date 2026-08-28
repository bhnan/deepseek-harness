# 数据需求 —— 从界面反推的数据实体清单

日期：2026-08-19
状态：v1 定稿（随总览需求规划收官定稿）。实体编号 D1–D9 + I1 原样引用总览；字段级定义以 `2026-08-19-teacher-calendar-data-schema-spec.md` 为**权威**，本清单只描述实体边界、存储结构与缺失降级，两份文档字段名、类型、枚举完全一致。

已确认决策（总览 §4 与需求确认）：DSH 插件形态、仅电脑端、内置静态词库、学期视图为事件管理型、CSV/Excel 批量导入；存储为**本地 JSON 文件 + 多学期隔离目录**，**禁 localStorage 承载学期数据**。

## 1. 方法：对每条前端需求问五问

前端需求清单 F1–F14（总览轨道 F）+ 全局功能 G1–G6（轨道 G）。每条需求回答五问：

1. **指标**：界面显示什么字段？
2. **粒度**：什么层级（学期 / 周 / 日 / 时段 / 班级）？
3. **时间形态**：快照 / 日级 / 周级 / 事件 / 静态映射，五选一
4. **新鲜度**：静态 / 实时 / 手动维护（用户编辑即写盘）
5. **来源与缺失**：哪个实体/文件承载；拿不到数据时界面行为（§4 总表）

### 1.1 F1–F14 归并映射表（引用总览编号）

| 前端需求 | 数据实体 | 关键字段 / 存储 | 规则 / 横切 |
|---------|---------|----------------|------------|
| F1 顶部学期信息区（学期选择/进度条/当前周数） | D1、D9 | semesters.json（start_date/end_date）；settings.json.current_semester_id | R2 名称-日期绑定、R6 进度（派生，不落库） |
| F2 今日待办任务（固定课程/临时调课/个人事务，状态可编辑） | D3、临时调课（D3 族）、D5 | fixed_courses.json（done_dates）、temporary_changes.json（done）、events.json（done） | R4 当日课表合并（派生） |
| F3 每日文化素养推送 | D8 | culture_library.json、push_state.json | C1/C2（内容库规范） |
| F4 周视图（第 X 周/单科双模块） | D1、D2、D3、D4 | 派生周数；classes.json（配色）；fixed_courses.json；teaching_content.json | R1/R6 |
| F5 班级预设管理系统（双学段库/固定配色） | D2 | classes.json（stage/name/color） | — |
| F6 课程与事务编辑（空白时段自由增删改替换） | D3、D4、D5 | fixed_courses.json、teaching_content.json、events.json | R3 顺延（派生） |
| F7 调课机制（固定 vs 临时） | D3、临时调课（D3 族） | temporary_changes.json（week 生效周） | R3/R4 |
| F8 月视图（周次栏/当日高亮/生日轻提醒） | D1、D6 | 派生周次栏；birthdays.json（`--MM-DD`） | R1/R7 |
| F9 月视图双模式（分页/学期全景） | D1 | semesters.json（起止日期派生周区间，全景覆盖完整周期） | R1 |
| F10 学期视图（事件管理型，类型精简去重） | D5 | events.json（type 枚举，生日归入左侧事件体系） | — |
| F11 事件详情与配色（五要素+颜色可改） | D5 | events.json（time/location/participants/notes/requirements/color） | — |
| F12 事件精准筛选（单点/多选/一键恢复） | D5 | events.json.type 枚举 | — |
| F13 生日批量管理（导入/批量管理） | D6、I1 | birthdays.json；CSV 模板 | R7 |
| F14 主题体系（五套一键切换/三层级底色） | D7 | theme.json（day_bg 三层级）；settings.json.theme_id | — |

### 1.2 G 轨道补充映射

| 全局需求 | 数据实体 | 说明 |
|---------|---------|------|
| G2 全局右键快速删除 | 各实体 + D9 | 删除操作入撤销栈（快照），可回溯 |
| G3 全局撤销/恢复 | D9 | settings.json 的 undo_stack / redo_stack（操作快照，上限 100 条对齐 rule-spec C6） |
| G4 事件批量管理 | D5、D6、I1 | 单条增删改 + 批量导入/删除/编辑（CSV 模板） |
| G5 节假日全域标注 | 辅助静态资产 holidays.json | 法定节假日名称文字提醒，无论是否放假 |
| G6 学期数据隔离存储 | D1 + 各学期目录 | 多学期独立保存、互不覆盖、永久留存、历史回溯 |

## 2. 数据实体清单（D1–D9 + I1）

每实体一张表（用途 / 指标 / 粒度与形态 / 来源 / 存储路径 / 缺失行为）。

### D1 学期（含名称-日期绑定、周数派生）

| 项 | 内容 |
|----|------|
| 用途 | F1 顶部学期选择与进度条、F4/F8/F9 周数口径、G6 学期隔离与历史回溯 |
| 指标 | id / name / year / season / semester_index / start_date / end_date（派生不落库：学期总周数、当前周、进度百分比、周次栏） |
| 粒度与形态 | 学期级 / 静态映射（注册表列表，含系统默认学期） |
| 来源 | 用户手动维护（自由新建/编辑/删除任意学期含系统默认，无灰显无拦截）；R2 名称-日期绑定表提供默认起止日期（2026秋季第一学期=2026-09-01~2027-01-17；2027春季第二学期=2027-02-22~2027-07-06） |
| 存储路径 | `data/semesters.json`（注册表，全学期列表，不设每学期副本文件，避免双写不一致） |
| 缺失行为 | 注册表缺失/损坏 → 引导创建首个学期（不静默空白）；当前学期指向目录缺失 → 提示学期数据丢失，可重建空学期或回退上一学期 |

### D2 班级（双学段库）

| 项 | 内容 |
|----|------|
| 用途 | F5 班级预设管理、F4/F6/F8 课程与内容按班归属、F13 学生生日按班归类 |
| 指标 | id / stage（`primary` 小学 / `middle` 初中）/ name / color（hex 专属固定配色） |
| 粒度与形态 | 班级级 / 静态配置（小学/初中双独立预设库，跨学期全局共享） |
| 来源 | 用户手动维护（双库学段分离自由切换、自由增删改班级及配色，无数量限制 5-8+ 班） |
| 存储路径 | `data/_global/classes.json` |
| 缺失行为 | 库空 → 课程/内容/生日模块空态 + 「新建班级」引导；被引用班级删除受引用保护（§3.6） |

### D3 固定课程（+ R4 临时调课，D3 族）

| 项 | 内容 |
|----|------|
| 用途 | F2 今日待办、F4 周视图班级排课（授课班级模块）、F6 课程编辑、F7 调课 |
| 指标 | fixed_course：id / class_id / weekday / period / done_dates；temporary_change：id / fixed_course_id / class_id / week / original_date / original_period / new_date / new_period / note / done |
| 粒度与形态 | 时段级 / 静态配置（固定排课每周固定复用）+ 周级事件（临时调课仅当周生效） |
| 来源 | 用户手动维护；批量课表导入（I1 courses_import 模板） |
| 存储路径 | `data/<semester_id>/fixed_courses.json`、`data/<semester_id>/temporary_changes.json` |
| 缺失行为 | 固定排课缺失 → 周视图空课表 + 「无固定排课」标注；临时调课缺失 → 按固定排课展示（正常态）；当日课表为派生（R4 合并） |

### D4 授课内容（词库+自定义）

| 项 | 内容 |
|----|------|
| 用途 | F4 周视图授课内容模块（与班级排课双模块解耦）、F6 预设词库下拉 + 手动自定义双模式、R3 授课内容序列顺延（单班内容序列） |
| 指标 | teaching_content：id / class_id / week / weekday（可选，1–7）/ period（可选，≥1）/ content / source（`preset` 预设词库 / `custom` 手动自定义）/ preset_id；授课预设词库：id / text / tags |
| 粒度与形态 | 班级×周级 / 周级快照（每周独立更新）；**同一班级的内容按上课时刻排序构成"内容序列"**（R3 顺延的运算对象） |
| 来源 | 用户每周维护；预设词库下拉选填（内置静态词库 `data/_global/teaching_presets.json`）+ 手动自定义 |
| 存储路径 | `data/<semester_id>/teaching_content.json`；词库 `data/_global/teaching_presets.json` |
| 缺失行为 | 内容缺失 → 授课内容模块空态，不阻塞课表展示；词库缺失 → 下拉词库为空，仅剩手动自定义模式 |

### D5 事务/事件（含五要素详情与分类配色）

| 项 | 内容 |
|----|------|
| 用途 | F2 个人事务待办、F6 空白时段事务、F10 学期视图（事件管理型）、F11 详情与配色、F12 类型筛选 |
| 指标 | id / type（`course` 课程 / `activity` 活动）/ title / date / time / location / participants / notes / requirements / color / done（五要素详情 = 时间/地点/参与人员/注意事项/工作要求） |
| 粒度与形态 | 事件级 / 事件流（按 date 排序） |
| 来源 | 用户手动维护（单条增删改 + 批量导入/删除/编辑，G4）；事务两类：课程、活动 |
| 存储路径 | `data/<semester_id>/events.json` |
| 缺失行为 | 事件缺失 → 学期视图/待办显示空列表（与「未加载」文案可区分）；生日以第三类并入事件体系呈现（数据实体独立，见 D6） |

### D6 生日

| 项 | 内容 |
|----|------|
| 用途 | F8 月视图轻量化提醒、F13 批量管理、R7 周视图顶部星期日期栏姓名展示 |
| 指标 | id / role（`teacher` 教师 / `student` 学生）/ name / birthday（ISO 8601 无年日期 `--MM-DD`）/ class_id / note |
| 粒度与形态 | 人级 / 静态映射（按 `--MM-DD` 匹配当日） |
| 来源 | 用户手动维护 + CSV/Excel 批量导入（I1 birthdays_import 模板） |
| 存储路径 | `data/<semester_id>/birthdays.json` |
| 缺失行为 | 生日缺失 → 周视图顶部/月视图不展示生日（不报错）；**课时区永不展示、不遮挡**（R7） |

### D7 主题配置

| 项 | 内容 |
|----|------|
| 用途 | F14 五套主题一键切换（经典小清新/国风雅致/极简艺术/轻量科技/温柔治愈暖风）、日期底色三层级、字体规范 |
| 指标 | themes{fresh/guofeng/minimal/tech/warm} 每套：name / day_bg{workday/weekend_holiday/today} / course_area_today_bg / font / accent |
| 粒度与形态 | 全局级 / 静态配置（内置五套定义；当前选中主题存 D9） |
| 来源 | 内置静态资产（随应用版本更新）；仅变更视觉样式，不改数据功能布局逻辑（F14） |
| 存储路径 | `data/_global/theme.json` |
| 缺失行为 | 缺失 → 回退内置默认主题（fresh），功能不受阻塞 |

### D8 素养词库（含推送状态）

| 项 | 内容 |
|----|------|
| 用途 | F3 每日文化素养推送（教育古语/古典诗词/国内外教育理念/教育学理论/教育心理学知识点）、C1/C2 词库与推送算法 |
| 指标 | culture_entry：id / category（`education_proverb` 教育古语 / `classic_poetry` 古典诗词 / `education_philosophy` 国内外教育理念 / `education_theory` 教育学理论 / `education_psychology` 教育心理学知识点）/ original_text / vernacular_translation（文言类必填）/ plain_explanation / tags / difficulty / source（文言内容配白话翻译与通俗释义，字段与内容库规范 §3 逐字段一致）；push_state：by_date（日期键控）/ pushed_ids / round |
| 粒度与形态 | 词条级 / 静态词库（内置）+ 日级推送状态 |
| 来源 | 内置静态词库（种子脚本 + 人工校订）；推送状态由 C2 算法更新（每日自动更新 + 手动刷新换内容，全库无重复推送） |
| 存储路径 | 词库 `data/_global/culture_library.json`；推送状态 `data/<semester_id>/push_state.json`（**按学期隔离**，对齐内容库规范 §4.7） |
| 缺失行为 | 词库缺失 → 推送卡显示「词库不可用」，其余模块不受影响；push_state 缺失 → 视为首次使用，从词库第一条开始推送 |

### D9 设置与元数据（当前学期/视图偏好/撤销栈）

| 项 | 内容 |
|----|------|
| 用途 | F1 当前学期、G1 三视图偏好持久化、G3/R5 全局撤销恢复、F14 当前主题 |
| 指标 | current_semester_id / preferred_view（`week` / `month` / `semester`）/ theme_id（`fresh` / `guofeng` / `minimal` / `tech` / `warm`）/ undo_stack / redo_stack（撤销栈条目 = 操作类型 op（`create` / `update` / `delete`）/ 目标实体 entity / 目标 id entity_id / 前后快照 snapshot_before·snapshot_after / semester_id / ts） |
| 粒度与形态 | 全局级 / 状态快照（单文件） |
| 来源 | 用户操作自动维护（切换学期/视图/主题；任何实体增删改先入栈后写文件，事务性保证）；栈上限 100 条环形覆盖（对齐 rule-spec UN5/C6） |
| 存储路径 | `data/_global/settings.json` |
| 缺失行为 | 缺失 → 以默认值重建（当前学期=最近学期、视图=week、主题=fresh、栈空）；栈损坏 → 清空栈并标注，业务数据不受影响 |

### I1 导入导出（CSV 模板字段定义）

| 项 | 内容 |
|----|------|
| 用途 | G4 事件批量管理、F13 师生生日批量导入、课表/班级批量导入、数据导出备份 |
| 指标 | 模板：template_id / name / columns[]（key / csv_header / required / type（`string` / `enum` / `integer` / `month_day` / `color`）/ enum / format）；六套模板：classes_import / birthdays_import / courses_import / events_export / birthdays_export / backup_export |
| 粒度与形态 | 文件级 / 模板元数据（导入导出器内置，不落盘为业务数据） |
| 来源 | `scripts/importers/` 实现（总览 §2.4 ①）；CSV 优先、Excel 兼容（openpyxl/pandas 读）；备份导出打包学期目录（zip + manifest） |
| 存储路径 | 模板定义内置代码；导入产出写入对应实体文件（classes.json / birthdays.json / fixed_courses.json / events.json） |
| 缺失行为 | 模板列不匹配 → 导入报告逐行标注错误，不中断；备份失败 → 导出失败提示 |

### 辅助静态资产（不占 D 编号）

- **节假日映射 holidays.json**（`data/_global/holidays.json`）：支撑 **G5 节假日全域标注**（法定节假日自动显示节日名称，无论是否放假均文字提醒）；字段：name / start_date / end_date；内置静态、随应用版本更新（每年国务院放假安排发布后更新）；缺失 → 节日文字提醒不显示，底色按周末处理（字段定义见 schema 文档 §2.13）。

## 3. 存储与隔离约束

### 3.1 目录布局

```text
data/                                # 插件数据根（host 路由读写；禁 localStorage 承载学期数据）
├── semesters.json                   # D1 学期注册表（全学期列表）
├── manifest.json                    # X4 完整性清单（每文件 sha256 + 行数 + 更新时间）
├── _global/                         # 全局资产（跨学期共享）
│   ├── classes.json                 # D2 班级库（小学/初中双库）
│   ├── theme.json                   # D7 主题定义（五套）
│   ├── culture_library.json         # D8 素养词库（内置静态）
│   ├── teaching_presets.json        # D4 授课预设词库（内置静态）
│   ├── holidays.json                # G5 节假日映射（辅助静态）
│   └── settings.json                # D9 设置与元数据（当前学期/视图偏好/撤销栈）
└── <semester_id>/                   # 每学期隔离目录（如 2026-autumn-1/）
    ├── fixed_courses.json           # D3 固定排课
    ├── temporary_changes.json       # D3 族 临时调课（R4）
    ├── teaching_content.json        # D4 授课内容
    ├── events.json                  # D5 事务/事件
    ├── birthdays.json               # D6 师生生日
    └── push_state.json              # D8 推送状态（按学期一轮，C2）
```

### 3.2 多学期隔离规则（G6）

- 学期目录名 = 学期 id（`{year}-{spring|autumn}-{1|2}`，如 `2026-autumn-1`），创建学期时生成；学期内文件只读写本目录，**互不覆盖**。
- **跨学期引用禁止**：课程/内容/事件/生日均按学期隔离；班级库为全局共享（class_id 引用，跨学期复用同一教师班级体系）。
- **历史回溯**：切换 settings.json 的 current_semester_id 即读取对应目录；历史学期永久留存、可回溯查看（F1/G6）。
- **删除学期**（学期管理完全开放，可删任意学期含系统默认）：注册表移除 + 目录移入 `data/_trash/<semester_id>_<ts>/` 软删除可恢复（清理策略待定，见 schema 文档待确认项 9）；删除前提示自动导出备份（建议）。
- **禁 localStorage**：任何学期/业务数据不得写入 localStorage；localStorage 仅可用于非业务 UI 瞬态（如面板折叠状态），学期数据一律走 host 路由写本地 JSON。

### 3.3 原子写入（X3）

所有数据文件（全局 + 学期）写入采用「同目录临时文件 + os.replace(rename)」：写入中途崩溃不留半截文件；写入成功后更新 `data/manifest.json`（X4）。

### 3.4 撤销栈的存储形态（G3/R5，与规则引擎文档兼容）

- 撤销栈持久化于 `data/_global/settings.json` 的 `undo_stack` / `redo_stack`（**全局存放覆盖所有作用域**：学期内实体与全局实体均可撤销；栈物理全局、撤销/恢复时按条目 `semester_id` 过滤当前学期，对齐规则护栏文档 UN4）。
- 条目 = 操作快照：`{op, entity, entity_id, semester_id, snapshot_before, snapshot_after, ts}`——操作类型（create/update/delete）、目标实体类型与 id、操作前后**完整实体 JSON 快照**、时间戳；undo 取 before 回写、redo 取 after。
- **事务性保证（R5 兼容）**：增删改操作先写栈快照、再写业务文件；任一文件写入失败回滚（§3.3 原子写入 + manifest 恢复），保证栈与数据一致。
- 上限 **100 条环形覆盖**（超出丢弃最旧，对齐 rule-spec UN5/C6）；entity 枚举覆盖全部可撤销实体（semester/class/fixed_course/temporary_change/teaching_content/event/birthday/theme/settings）。
- **周数与进度为派生值，不落库**（见 §3.5）。

### 3.5 派生值不落库（R1/R3/R4/R6 兼容）

学期总周数、当前周、月视图周次栏、进度百分比、当日课表（固定排课+临时调课合并）**全部实时计算，不写入任何数据文件**；存储中仅保留计算输入（起止日期、固定课程、临时调课、授课内容 week 字段等）。

> **顺延（R3）不是派生值**：授课内容序列顺延会**真实改写**该班内容序列（D4，把内容重新分配到后续课时位），作为可撤销的数据变更落库（撤销栈记录快照，R5）。规则引擎文档（rule-spec）为计算口径权威，数据层与其字段边界兼容。

### 3.6 完整性（X4）与引用保护

- `data/manifest.json` 记录每个数据文件 sha256 + 行数 + 更新时间；`scripts/validate_schemas.py --check-data` 比对，损坏可发现（校验与契约测试体系见 X2 / schema 文档 §4）。
- 引用保护：class_id / fixed_course_id / preset_id 引用悬空时界面显示「已删除」占位，实体**不自动删**（防误删）；被引用班级/固定课程删除需先解除引用或确认。

## 4. 缺失与降级行为总表（对齐全局规范）

| 场景 | 界面行为 |
|------|---------|
| semesters.json 缺失/损坏 | 引导创建首个学期，不静默空白 |
| 当前学期指向目录缺失 | 提示学期数据丢失；可重建空学期或回退上一学期 |
| settings.json 缺失 | 以默认值重建（最近学期 / week / fresh / 空栈） |
| classes.json 为空 | 课程/内容/生日模块空态 + 「新建班级」引导 |
| 学期内 fixed_courses.json 缺失 | 周视图空课表 + 「无固定排课」标注 |
| teaching_content.json 缺失 | 授课内容模块空态，不阻塞课表 |
| events.json 缺失 | 事件列表空 + 「未加载」可区分标注 |
| birthdays.json 缺失 | 不展示生日，不报错 |
| theme.json 缺失 | 回退内置默认主题（fresh） |
| culture_library.json 缺失 | 推送卡显示「词库不可用」，其余模块不受影响 |
| push_state.json 缺失 | 视为首次使用，从词库第一条开始推送 |
| 单文件 checksum 不符（X4） | 该实体降级为只读/空态 + 「数据损坏」标注；其余学期/实体不受影响（目录隔离收益） |
| 撤销栈损坏 | 清空栈 + 标注；业务数据不受影响 |
| 引用悬空（班级/课程已删） | 显示「已删除」占位，实体保留不自动删 |
| holidays.json 缺失 | 节假日文字提醒不显示，底色按周末处理 |
| 词库轮换耗尽（C2） | 行为由内容库规范定义（重复前提示或重置推送记录） |

## 5. 数据量粗估

| 资产 | 每学期量 | 说明 |
|------|---------|------|
| 固定课程 | 10–32 条 | 5–8 班 × 每周 2–4 节 |
| 授课内容 | 100–160 条 | 班级数 × 学期总周数（约 20 周） |
| 临时调课 | 10–50 条 | 学期内调课频次 |
| 事务/事件 | 20–60 条 | 活动 + 课程事务 |
| 生日 | 100–300 条 | 教师数十 + 学生百级 |
| 素养词库 | 100–300 条（内置静态） | 五大类，种子脚本生成 |
| 授课预设词库 | 50–150 条（内置静态） | 内置 |
| 撤销栈 | ≤ 100 条 | 环形覆盖上限（对齐 rule-spec C6） |
| **单学期 JSON 总量** | **< 1 MB** | 纯文本 JSON；多年（10 学期）归档 < 10 MB，本地 JSON 完全可承载 |

## 6. 与其他文档的关系

- `2026-08-19-teacher-calendar-data-schema-spec.md`：**字段级权威**；本清单的实体边界、存储路径、缺失降级与之逐条对应，字段名/类型/枚举完全一致，以 schema 文档为准。
- `2026-08-19-teacher-calendar-rule-spec.md`：R1 周数、R3 顺延、R4 临时调课合并、R5 撤销事务、R6 进度、R7 生日展示——本清单只定义存储输入，派生计算归属规则引擎（§3.5）；撤销栈快照形态（§3.4）与 R5 兼容。
- `2026-08-19-teacher-calendar-content-library-spec.md`：C1 词条结构 → D8 素养词库；C2 推送算法 → push_state 状态字段。
- `2026-08-19-teacher-calendar-overview.md`：编号 D1–D9/I1、R1–R7、C1–C3、F1–F14、G1–G6、P1–P4、X1–X4 原样引用；文件清单见总览 §2。
- `2026-08-19-teacher-calendar-frontend-requirements.md`：F1–F14 界面行为 → 实体映射见 §1.1。
- 风格参考：`归档/2026-08-15-dsh-trading-dashboard-data-requirements.md`（五问方法、资产表结构、缺失降级表同款）。

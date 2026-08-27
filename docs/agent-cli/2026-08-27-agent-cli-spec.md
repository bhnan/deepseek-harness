# Agent CLI（tc）· 规格文档（spec.md）

> 文档编号：CLI-SPEC-2026-08-27
> 流程：ai-native-sdlc 阶段 2（Design）产物；上游 = intent.md v1.0
> 状态：v1.0 定稿

## 1. 架构与数据流

```
DSH 会话 Agent ──► ① 原生工具 trading-tools 式插件 @bhn/teacher-tools
                    │   （仅转发：execFile node cli/tc.mjs …，stdout JSON 原样回传）
                    ▼
               ② 统一 CLI tc.mjs（零依赖 Node ≥18）
                    │   lib/api.js      HTTP 信封客户端
                    │   lib/resolve.js  名称→ID 解析器（每调用内缓存）
                    │   lib/commands.js 命令注册表 + handler + discover 元数据
                    │   lib/csv.js      CSV 长/宽格式解析 → 成绩行
                    ▼
     ③ HTTP :8787 /api/calendar/*      ④ HTTP :8797 /api/portfolio/*
        （业务规则/撤销栈/原子写留在服务端，CLI 不绕过、不直读存储）
```

改动系统清单见 intent §8。**不新增任何存储位置**。

## 2. 输出契约（R3）

- stdout 恒为单个 JSON 对象，UTF-8 无 BOM：
  - 成功 `{"ok":true, ...命令自有字段}`；
  - 失败 `{"ok":false,"error":{"code":"<分类码>","message":"<中文一句话>","detail":<可选结构化>}}`
- stderr 仅人类诊断（进度提示），Agent 可忽略。
- 退出码：`0` 成功｜`2` 用法错误｜`3` 服务端拒绝/上游失败（HTTP 层活着）｜
  `4` 网络不通/SERVICE_DOWN｜`5` 解析多义需消歧。

### 错误码枚举

| code | 场景 |
|---|---|
| USAGE | 参数缺失/非法（含 --help 未匹配命令） |
| RESOLVE_NOT_FOUND / RESOLVE_AMBIGUOUS | 名称解析失败 / 多义 |
| VALIDATION | 本地预检失败（未知学生、数值非法等），detail.errors 全量列出（exit 3） |
| SERVICE_DOWN | ECONNREFUSED / 超时 |
| UPSTREAM_ERROR | HTTP 4xx/5xx 或 ok:false（透传服务端 message） |
| PARSE_ERROR | CSV/docx/--rows JSON 本地解析失败 |

## 3. 名称解析规则（R4）

| 实体 | 输入形态 | 解析算法 |
|---|---|---|
| 学期 `-s` | id / 名称子串 / `current` | bootstrap.semesters；子串唯一命中即用；空串取 settings.current_semester_id |
| 日历班级 `-c`（calendar 域） | class_id / 名称精确→包含 | GET /classes 后同上 |
| 档案班级 `-c`（portfolio 域） | cls-id / 名称精确→包含 | GET /api/portfolio/classes |
| 学生 | 姓名 / student_no / stu-id | 取该班学生列表（page_size=500）匹配；同名>1 → AMBIGUOUS 附候选[id,name,no] |
| 考试 `-e` | exam_id / 类名+日期组合 | 先按 id 直查，否则在 `-c` 班的考试列表里名称精确→包含 |

解析结果随响应回显 `_resolved:{...}` 字段，方便 Agent 复用 ID。

## 4. 命令规格表（16 个）

约定：`-s`=学期，`-c`=班级，方括号可选；所有写命令带 `--dry-run`。

| # | 命令 | 关键参数 | 映射端点（方法） | 备注 |
|---|---|---|---|---|
| 1 | `tc discover` | — | 无（本地注册表自省） | 附每个命令 usage/example/dispatch |
| 2 | `tc health` | — | GET bootstrap + GET health | 两服务版本化连通摘要 |
| 3 | `tc semester list` | — | GET /semesters | 含 current 标记 |
| 4 | `tc semester create` | `--name --start-date --end-date` | POST /semesters | 名称格式校验留给服务端（R2 兼容寒暑假名） |
| 5 | `tc schedule show` | `-s [--week N\|--date D\|--current]` | GET /:sid/week-view?week=N | date→week 由 CLI 用学期起止换算后仍传 week；默认当前周（bootstrap 无当前周概念时=第 1 周） |
| 6 | `tc course add` | `-s -c --weekday 1-7 --period N [--week odd\|even\|N[,N]]` | POST /:sid/fixed-courses | 占位冲突由服务端 409 判定 |
| 7 | `tc content batch` | `-s (--rows JSON\|--file F)` | POST /:sid/teaching-content/batch | rows 支持 class_name；回显 success/failed/errors 明细 |
| 8 | `tc content prefill` | `-s -c --contents "a;b;c"\|--file` | POST /:sid/content-seq/prefill | 分号分隔或 JSON 数组；回显 assigned/overflow/full |
| 9 | `tc docx import` | `--file F [--semester-name N --semester-start D --semester-end D] [--dry-run]` | 子进程复用 scripts/import-docx-schedule.mjs | 学期参数化透传（见 plan §0 列示项）；缺省沿用脚本内置映射（2025春） |
| 10 | `tc class list` | `[--role homeroom\|subject] [--stage primary\|middle]` | GET /api/portfolio/classes | 回显 student_count |
| 11 | `tc student list` | `-c C [--keyword K]` | GET /classes/:cid/students | 默认 page_size=500 一页拉全 |
| 12 | `tc exam list` | `-c C [--type T]` | GET /classes/:cid/exams | T ∈ placement/weekly/monthly/midterm/final/mock/subject/other |
| 13 | `tc exam create` | `-c C --name N --type T --date D [--note]` | POST /classes/:cid/exams | 同名同日 409 透传 |
| 14 | `tc grades import` | `-c C (--exam-id E \| --exam-name N [--date D --type T --create]) (--rows\|--csv) [--dry-run]` | 组合：students+exams+POST /exams/:eid/scores/batch | 见 §5 |
| 15 | `tc analysis student` | `-c C --student 张三` | GET /students/:sid/analysis | 先解析学生再查 |
| 16 | `tc analysis class` | `-c C [--exam-id E]` | GET /classes/:cid/analysis | 缺省最近一次考试（服务端语义） |

## 5. grades import 详细规格（一致性核心）

1. 解析班级 → 拉学生名单建立 [姓名/学号→id] 索引；
2. 解析成绩来源：
   - **长表 CSV**：列 `姓名,科目,分数[,班级排名][,年级排名]`；
   - **宽表 CSV**：首列 `姓名`，其余非保留列名均视为科目（自动识别，识别不出任何科目列 → PARSE_ERROR）；
   - `--rows` JSON 与服务端 batch 同构（student_name 或 student_id 二选一）；
3. 本地预检：未知姓名/分数非法 → 不发请求，回 `error.code=VALIDATION` 且
   `detail.errors[]` 全量列出（row,name,reason）；分数范围校验复刻服务端规则
   （单科 0–100，`总分`≥0 不设上限，排名为正整数，题型分键 ∈ 选择/简答/材料分析/论述）；
4. `--dry-run`：输出将提交的规范行数、样例前 5 行、目标考试与班级 **零写入**；
5. 实际提交走服务端整批原子接口；`exam-name + --create` 时先建考试（409 视为已存在并沿用），
   幂等可重跑；未加 `--create` 且考试不存在 → USAGE 错误列出该班现有考试供选择；
6. 提交后自动附带 `grades_show` 摘要（upserted/conflict 分布），一次交互闭环。

## 6. DSH 插件 @bhn/teacher-tools 设计（R7）

- 目录 `~/.dsh/plugins/teacher-tools/`：`package.json` + 自带 node_modules +
  `lib/index.js`；镜像 trading-tools 结构。
- 首批注册 8 个高频工具（其余走 bash 调 tc）：`tc_health / tc_semester_list /
  tc_schedule_show / tc_content_batch / tc_grades_import / tc_grades_show* /
  tc_analysis_class / tc_analysis_student`（* grades_show 并入 import 返回摘要，独立工具视盲测反馈增删）。
- 每个 defineTool 的 handler：`execFileSync('node',[cliPath,...argv])` → JSON.parse
  stdout → 原样返回；stderr 附加到错误的 description。参数 schema 用 schemastery
  按 spec §4 表格逐字段落；不做超出 CLI 的逻辑。
- 注册：profile `package.json` 增加 `"@bhn/teacher-tools": "link:…"`；
  `cordis.patch.yml` 增加 insert 块（inject: tools）；**生效需 dsh 重启 = 人工门禁**。

## 7. 测试设计（对应 A1–A4）

| 层 | 内容 |
|---|---|
| 离线单测（A4） | `tests/cli.test.mjs`（vitest）：argparse、错误信封、CSV 长/宽转换、resolver 多义分支（mock fetch） |
| 冒烟（A1） | `docs/agent-cli/evidence/smoke-*.json` 存档每条命令真实输出；写命令 dry-run→真写→undo 回滚→复查还原 |
| 盲测（A2） | 新子代理 prompt 只给 discover JSON 与任务集；评价完成度与零文档依赖 |
| 一致性（A3） | 坏行批次整批拒绝 + 数据库前后快照比对（经只读 API 验证零落库） |

## 8. 边界与异常实现

E1–E5 对应 intent §7；补充两条工程边界：

- CLI 对服务端响应做 `ok` 字段断言，缺字段一律按 UPSTREAM_ERROR 处理（防半截响应被误判成功）；
- execFile 超时（插件层 60s，docx 导入 120s）超时归类 UPSTREAM_ERROR，不留僵尸进程。

## 9. 「直调 vs 走 HTTP」权衡备忘（v1.1 应审阅意见补充）

提出者关注点：多一层协议的延时损耗与实现复杂度。2026-08-27 实测结论：

- 回环 HTTP 单次 1.1–1.3ms（重端点峰值 24ms）；Node 进程冷启动固定 ≈42ms，
  为任何 CLI 形态共有的下限成本 → 直调最多节省总耗时 <7%，无感知差异；
- 直接 import 两端 index.mjs 不可行：逻辑为路由内联闭包且 `app.listen` 在模块加载时绑定；
- 绕过 API 的三个一致性 hazards 已记录：路由闭包不可复用、GET /week-view 含幂等写副作用、
  settings.json 撤销栈存在跨进程 last-writer-wins 竞态。

**定案：维持 HTTP 架构。** 若未来确需让第三方 Node 程序原生嵌入能力，
正确路径是 Maintain 阶段回流新 intent——先把两端重构出 `lib/service/*` 服务层供
Express 与外部共用，届时本 CLI 切换到服务层直调即可，输出契约不变。

> 变更记录：v1.1 增补本节与实测数据；其余章节未动。
>
> **v1.2（2026-08-27 独立审查 request-changes 处置）**
> - 修复兑现：§3 `_resolved` 已在各命令输出回显；§5.1 学号通道已建（rows 支持
>   student_no，与姓名/ID 三选一）；§5.5 建考 409 已按幂等沿用；§2 help 带未知命令
>   参数时返回 USAGE(exit2)；§8 超时码统一（插件 killed→UPSTREAM_ERROR，docx 超时同）
> - 审查中项修复：长表 CSV 空分数不再静默记 0 分；报错行号改由解析层原始行号透传
>   （_src_row）；未知 --flag 拒绝（防 --dryrun 拼错静默真实写入）；--week 空段拒绝；
>   contentPrefill --file 坏 JSON 归 PARSE_ERROR；schedule show 非法 --date 归 USAGE；
>   docx 导入器 argOf 取不到值报错退出（不静默回退默认学期）
> - **接受偏差（记录在案）**：§4 #3 semester list 走 /bootstrap 超集端点（功能等价）；
>   §4 #1 discover 元数据为 name/summary/usage/writes/payload_schema（example 以 usage
>   内联代替）；插件首批清单以 tc_discover 顶替 grades_show（spec §6 已授权视盲测增删，
>   grades 摘要并入 import 返回）；§5.6 摘要仅含 count/avg（服务端无 conflict 字段）
> - 遗留建议（Maintain 回流候选）：undo 端点包装为 tc 命令；parse_docx_schedule.py
>   slotPeriod 未命中时段的静默跳过改为记入报告（既有行为，非本次改动引入）


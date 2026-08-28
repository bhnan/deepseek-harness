# Teacher Dashboard — 教师看板开发整体

道德与法治教师（梁老师）的双应用工作台 + DSH 集成层。本分支在 harness patched 基线
（`bhn/0.1.1-rc.2-patched`）之上，仅新增本子树，与主干 diff 干净。

## 组成

| 目录 | 说明 | 运行形态 |
|---|---|---|
| `teacher-calendar/` | 教学日历应用（:8787）+ 学生成长档案应用（:8797），同仓双应用 | systemd 常驻（`dsh-web` 之外的独立单元），数据本地隔离存储 |
| `teacher-calendar/cli/` | `tc` 统一 Agent CLI（16 命令）：课表/成绩/学情，走应用 HTTP API，`tc discover` 自描述 | Agent bash 直调 |
| `dsh-plugins/teacher-tools/` | DSH 原生工具插件：把 8 个高频 `tc_*` 命令注册进会话（仅转发 CLI） | profile 注册 + dsh 重启生效 |
| `dsh-plugins/apps-proxy/` | 反向代理：`/calendar` 与 `/portfolio` 挂进 DSH Web GUI | profile 注册 |

## 文档入口

- 需求/规格六阶段产物：`teacher-calendar/docs/`（日历 9 篇）与
  `teacher-calendar/docs/student-portfolio/`（档案 8 篇）、`teacher-calendar/docs/agent-cli/`（CLI 3 篇）
- 应用快速开始：`teacher-calendar/README.md`；CLI 用法：`teacher-calendar/cli/README.md`

## 关键约定

- 唯一跨应用联动：档案「沟通安排」→ 日历事件（单向）；知识库两库独立
- CLI/工具只经应用 HTTP API 写数据：业务规则、撤销栈、原子性全部留在服务端
- 写命令一律先 `--dry-run`；名称可模糊解析，多义返回候选清单（exit 5）
- 学生数据（data/、SQLite、备份）不入库，`.gitignore` 双层确认

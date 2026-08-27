# Agent CLI（tc）· 实现计划（plan.md）

> 文档编号：CLI-PLAN-2026-08-27
> 流程：ai-native-sdlc 阶段 3（Build）门禁产物；上游 = spec.md v1.0
> 状态：v1.0 定稿（2026-08-27 提出者批准开工；spec 修订至 v1.1 增补 §9 架构权衡备忘）

## 0. N2 例外通道列示（已获授权的少量非服务端修补）

| 文件 | 改动 | 性质 |
|---|---|---|
| `scripts/import-docx-schedule.mjs` | 学期三常量（名称/起止日期）参数化：新增可选 `--semester-name/--semester-start/--semester-end`，**默认值逐字不变**；`TOTAL_WEEKS` 从硬编码 22 改为复用 `src/engine/week.js` 的 `semesterTotalWeeks()`（默认日期下结果恒等） | 仓库工具脚本参数化，非运行中服务端；不改动任何 Express 路由与存储逻辑 |

除此之外：**零服务端改动**承诺不变。
> 服务端改动声明：**本计划零服务端改动**（intent N2 例外通道本次不启用）

## 1. 交付物与落点

| 工作区暂存（开发期） | 最终安装位置 |
|---|---|
| `stage/cli/tc.mjs` + `stage/cli/lib/{api,resolve,commands,csv}.mjs` | `/root/apps/teacher-calendar/cli/` |
| `stage/cli/README.md`、`stage/tests/cli.test.mjs` | 同名仓库位置 |
| `stage/docs/agent-cli/*` | `/root/apps/teacher-calendar/docs/agent-cli/` |
| `stage/dsh-plugin/teacher-tools/*` | `~/.dsh/plugins/teacher-tools/` |
| —（安装脚本生成） | profile 两文件各加一段注册（见 §5） |

## 2. 构建顺序（每步带验证）

1. **骨架**：tc.mjs 参数解析 + 信封输出 + exit codes（离线可测）
   ✅ 验证：node 直接跑 usage/--help/discover 骨架
2. **lib/api.mjs**：fetch 封装、超时、ok 断言、错误分类（E1/E4/半截响应）
3. **lib/csv.mjs**：BOM/引号/长宽表识别 → 成绩规范行（纯函数）
4. **lib/resolve.mjs**：五类实体解析器（注入 fetch 便于单测 mock 多义分支）
5. **lib/commands.mjs**：16 命令逐个实现（顺序 = spec §4 表序），每完成一个即对真服务冒烟一次
6. **docx import**：子进程包装既有脚本，校验 `--dry-run` 零写入
7. **tests/cli.test.mjs**：离线用例全绿（vitest 不装依赖？仓库已有 devDependency，
   安装后直接跑 `npm test -- tests/cli.test.mjs`）
8. **README.md**（面向 Agent 的三段式：一句介绍 / discover 用法 / 十条速查示例）

## 3. 测试计划执行

- A4 离线单测 → 存证据 `evidence/unit.log`
- A1 冒烟 16 命令 → 每条 stdout 存 `evidence/smoke/<cmd>.json`；
  写命令三步走：dry-run 快照差异 → 真写 → POST undo 回滚 → GET 复核还原
- A3 一致性 → 坏行批次整批拒绝实验（真服务上构造含未知学生的 rows）+ 快照比对存证
- A2 盲测 → subagent（全新上下文）：只给 discover JSON + 任务集（查第 1 周课表 →
  给指定班导入 2 名学生小测成绩 → 回读其一进退步分析），评分维度：
  是否零文档依赖 / 任务是否全部完成 / 输出 JSON 是否被正确解读

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 写操作污染真实数据（8787/8797 是老师生产实例！） | 冒烟一律先 dry-run；真写仅限**新建的远期合成学期「2029年寒假」+ 其中新建临时班级**承载测试数据（学期名合法且已核实不与现役三个学期冲突；班级为全局库但每次创建即入撤销栈，回滚后用基线快照复核还原，快照存 `evidence/baseline/*.json`），成绩侧用临时班级新学生 |
| week-view 会触发节假日顺延副作用（syncHolidayDefers 幂等） | 只读端点不规避（幂等安全），但在 README 注明该行为 |
| 名称多义导致 Agent 死循环消歧 | RESOLVE_AMBIGUOUS 一次性给全候选 + 给出消歧参数示例 |
| vitest 版本/工作区缺 node_modules | 单测设计为纯函数无第三方依赖；在工作区以 `node --test` 兼容跑（导出被测函数），装进仓库后由 vitest 再跑一遍双保险 |

## 5. Deploy（升级权限一次性安装 + 留痕）

1. `cp -r` stage 各目录到最终位置（唯一一次工作区外写操作审批）
2. `cd ~/.dsh/plugins/teacher-tools && npm i --omit=dev` 装插件依赖
3. profile `package.json` + `cordis.patch.yml` 注册追加
4. git 提交（仓库内新增文件分两个 commit：docs 产物 / cli 功能）
5. 审查记录写入 `docs/agent-cli/evidence/review-record.md`
   （按 skill REVIEW 顺序：逻辑 → 安全 → 对照 spec/plan 偏差核查）
6. **人工门禁**：dsh 重启使原生工具生效 —— 由用户亲自决定时机

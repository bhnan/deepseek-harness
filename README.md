# A 股交易研究与盘后复盘系统（trading）

A 股（中国市场）量化研究 + 每日盘后数据管道 + 复盘系统的混合仓库，配 DeepSeek Harness
Web **交易看板插件**与 **Agent 取数 CLI（tools）**。全文以中文为准。

> 本仓库以 `feat/trading-research` 分支托管于 [bhnan/deepseek-harness](https://github.com/bhnan/deepseek-harness)。
> 看板插件源码的独立分支见 [feat/trading-dashboard](https://github.com/bhnan/deepseek-harness/tree/feat/trading-dashboard)（`plugins/trading-dashboard/`）。

## 1. 三层架构

```text
┌─ ① 盘后数据管道（production）──────────────────────────────┐
│ 每交易日 16:45 cron 触发 run_daily_pipeline.py：            │
│ 日历检查 → 市场快照 → 申万行业 → 事件 → 信号 → 复盘 → B1   │
│ 产出：schema 校验过的 JSON 资产（data/）+ sha256 manifest   │
└──────────────┬─────────────────────────────┬───────────────┘
               ▼                             ▼
┌─ ② 策略生命周期（lab/）────────────────────────────────────┐
│ Idea → Signal → Strategy → Experiment → Run → Evaluation   │
│ → Conclusion，全部 JSON 持久化，定义对象版本化、执行对象不可变│
└──────────────┬─────────────────────────────┘
               ▼
┌─ ③ 量化研究与消费端 ────────────────────────────────────────┐
│ scripts/validate_*.py · backtest_*.py · analyze_*.py       │
│ tools/ —— Agent 取数 CLI（只读，本仓库对外数据接口）        │
│ 插件 trading-dashboard —— Web 看板（8 页签，只读展示）      │
└─────────────────────────────────────────────────────────────┘
```

## 2. 目录导览

| 目录 | 内容 |
|---|---|
| `pipeline/` | 盘后管道 Python 包：`io.py`（资产写出唯一入口：schema 校验 + 防 NaN + 原子写 + manifest）、市场/行业/事件/信号/复盘采集、B1 股票池日线库 |
| `schemas/` | JSON Schema 契约：`assets/`（数据资产）、`lifecycle/`（11 件套）、`contracts/`、`viz/` |
| `lifecycle/` | 生命周期存储读写（版本化 / 不可变 / fail-fast 校验） |
| `lab/` | 研究仓库（gitignore，独立管理）：ideas / signals / strategies / experiments / conclusions / backtests |
| `backtest/` | 回测框架：`MarketData`（as_of 视图）、DSL（含 `sector_rank` 等指标）、`BacktestEngine`（t 收盘信号 → t+1 开盘执行，涨跌停/停牌/T+1/费用，护栏强制） |
| `tools/` | **Agent 取数 CLI**（只读）：`python -m tools <command>`，命令面见 [`tools/README.md`](tools/README.md) |
| `scripts/` | 入口脚本：`run_daily_pipeline.py`（管道主入口）、`review_agent.sh`（复盘 LLM Agent）、`export_*.py`（看板数据导出）、60+ 研究脚本（validate / backtest / analyze） |
| `tests/` | 契约与单测（pipeline / lifecycle / dsl / tools / backtest 已知答案） |
| `docs/` | 设计文档：[intent](docs/intent.md)（做什么）/ [spec](docs/spec.md)（怎么设计）/ [plan](docs/plan.md)/ [data-interfaces](docs/data-interfaces.md)（字段字典） |
| `plugins/` | `trading-dashboard` 软链 → 看板插件源码仓库 |
| `data/` | 生成数据（大部分 gitignore，仅 `watchlist.json`、`cron/tasks.json` 等用户配置入库）+ `.manifest.json` 资产完整性清单 |

## 3. 快速开始

```bash
# 环境（仓库根 .venv，勿重建）
./.venv/bin/python -V

# 跑盘后管道（缺省=最近交易日；周末/节假日自动 skip）
./.venv/bin/python scripts/run_daily_pipeline.py [--date YYYY-MM-DD]

# Agent 取数（只读，输出 JSON 到 stdout；退出码 0/1/2）
./.venv/bin/python -m tools latest
./.venv/bin/python -m tools market  --date 2026-08-25
./.venv/bin/python -m tools sectors --date 2026-08-25 --top 5
./.venv/bin/python -m tools stock   --date 2026-08-25 --code 600519
./.venv/bin/python -m tools review-digest --dates 5     # 近 5 日复盘汇总

# 跑全部测试
bash scripts/run_all_tests.sh
```

## 4. 数据资产与契约

- **落盘只有一条路**：`pipeline/io.py::write_asset()`——schema 校验 fail-fast、
  `allow_nan=False`、临时文件原子写、登记 `data/.manifest.json`（size + sha256）。
- 资产路径约定：`data/<domain>/<交易日>/<asset>.json`（如
  `data/sector/2026-08-25/members_spot.json`）；源字段原样透传，系统计算字段进 `derived.*`。
- 完整字段字典见 [`docs/data-interfaces.md`](docs/data-interfaces.md)。

## 5. 策略生命周期

`Idea → Signal → Strategy → Experiment → Backtest Run → Evaluation → Conclusion`

- **Idea**（`lab/ideas/`）可变收件箱；**Signal/Strategy/Config**（定义对象）版本化，
  旧版本永不覆盖；**Experiment/Run/Evaluation/Conclusion**（执行对象）不可变，重写即报错。
- 全部写入先过 `schemas/lifecycle/*.json` 校验（fail-fast），引用完整性由
  `lifecycle/store.py::check_integrity()` 把关。
- 研究验证的护栏标准：as_of 视图物理隔离 / t+1 两阶段执行 / 泄漏自检 / 样本内外切分 / 全矩阵全报。

## 6. 看板插件

`plugins/trading-dashboard`（软链）是嵌入 DeepSeek Harness Web 的 A 股盘后看板：
大盘概览 / 板块 / 个股 / 组合 / 信号 / 新闻 / 实验室 / 定时 8 页签，只读消费
`/api/trading/*` 与 `lab/`。安装、结构与数据约定见其仓库内
`README.md`，或 GitHub 分支
[`feat/trading-dashboard`](https://github.com/bhnan/deepseek-harness/tree/feat/trading-dashboard/plugins/trading-dashboard)。

## 7. 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/intent.md`](docs/intent.md) | 数据访问接口的意图与验收（做什么、怎么算做成） |
| [`docs/spec.md`](docs/spec.md) | 接口设计（命令面、口径、错误约定） |
| [`docs/plan.md`](docs/plan.md) | 实施计划（M1~M5 里程碑） |
| [`docs/data-interfaces.md`](docs/data-interfaces.md) | 全量字段字典（各资产 JSON 的接口契约） |
| [`tools/README.md`](tools/README.md) | tools CLI 命令一览与典型工作流 |
| [`AGENTS.md`](AGENTS.md) | 交易看板插件功能说明 |

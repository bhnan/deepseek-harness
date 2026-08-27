# Spec — A 股数据访问接口（CLI 实现）

> **Design 阶段产物 v0.1（评审稿）**。输入：`docs/intent.md`（Plan 产物，已确认）。
> 本文件是施工图：设计决策、架构与数据流、CLI 命令面、必守规则、边界与验证。
> **接口字段细节见附录 `docs/data-interfaces.md`**（层 1/2/3 全部接口与字段 schema 的唯一出处）。

## 1. 设计决策（定稿 intent §10 待定项）

1. **接口形态 = CLI（新增独立 Python 模块 `tools/`）**。
   - 理由：新逻辑（dates 窗口 / period 统计 / universe 集合统计 / review_digest / 个股专题）在现有代码中均不存在，需新写，且自然落在 Python 侧——数据读取 `pipeline/io.py`、计算 pandas、日线/聚合复用 `scripts/export_*.py`（本身即 CLI 形态）。Agent 在 workspace 内直接调 `.venv` Python，零中转；避免"Node 壳 + Python 实现"双重维护。
   - **升级路径**：将来若要与看板共用，在 `host.js` 加薄路由 `execFileSync` 调同一 `tools/` 模块即可（与现有 export 端点同模式），CLI 不锁死 HTTP。
2. **变更面 = 新增独立模块，只增不改现有代码**。
   - **不动**：`pipeline/`（采集逻辑）、`host.js/route.js`（看板 API）、现有 `scripts/`、看板 client。
   - **复用**：`pipeline/io.py`（`read_asset` / `verify_manifest`）、`pipeline/collect_market.latest_trading_date`、`scripts/export_daily_json.py` / `export_index_daily.py` / `export_sector_daily.py` / `export_aggregate_daily.py`、`lifecycle/store.py`（lab 读取）、`data/` 全部资产与 parquet / PIT csv。
3. **聚合口径**：加权实现，`weights` 未指定默认等权（intent 已定）。
4. **周期默认窗口**：`dates` 缺省 = 最近 5 个交易日（intent 已定）。

## 2. 架构与数据流

```
Agent (bash)
  → ./.venv/bin/python -m tools <command> [options]
  → tools/ 命令模块
      ├── normalize.py        # symbol 规范化（裸代码/带前缀/名称 → sh/sz/bj+6位、801xxx）
      ├── dates.py            # 日期窗口（I-01/I-02）
      ├── snapshot.py         # 快照读取（market/sectors/universe/stock/review/events/signals）
      ├── stock_extra.py      # 个股专题（stock_news/financials/valuation）
      ├── aggregate.py        # 聚合口径唯一实现（加权/等权，I-08 集合统计 + 层3 归一化）
      └── series.py           # 层3：series 两段式（归一化→统一统计）+ review_digest + stock_profile
  → 复用 pipeline/io.py、collect_market、lifecycle/store.py、scripts/export_*.py
  → data/（JSON 资产 / sw_daily.parquet / PIT csv）+ lab/
  → stdout: 统一 JSON 信封；stderr: 错误；非零退出码
```

**数据流分类**：

| 类别 | 数据流 |
|---|---|
| 快照类（market/sectors/review/events/signals） | `io.read_asset` 读 `data/{subdir}/{date}/{asset}.json`（含 schema 信封与 data_quality） |
| 日线类（指数/板块/个股/聚合 K 线） | 复用 `scripts/export_*.py`（内部已处理 symbol 规范化、限长、缓存），`series(mode:"bars")` 与 `stock_profile.bars` 走此路 |
| 财报 / 估值 | 读 `data/pit_financial/raw_profit_sheets/{SHxxxxxx}.csv`、`data/pit_valuation/{metric}/{code}.csv`（或 lab 面板 CSV） |
| universe 集合 | 成分股行情（`quotes_subset` / `a_spot`）+ `tools/aggregate.py` 集合统计 |
| 日期窗口 | `dates()` 用 `data/calendar/trade_dates.json` + 该日 `index_spot` 落盘判定 |

## 3. CLI 命令面（argparse）

全局约定：`python -m tools <command> ...`；**成功输出 JSON 到 stdout，错误走 stderr + 非零退出码**。

```
# 层 1
tools dates [-n N | --start D --end D]          # 最近 N 个有数据交易日，或区间
tools latest                                    # 最近有数据交易日

# 层 2 快照
tools market --date D                           # 大盘（指数+宽度+量能）
tools sectors --date D [--top N] [--bottom N]   # 板块快照/排名
tools universe --date D --symbols s1,s2 [--weights w1,w2] [--label L]   # 股票集合单日快照
tools stock --date D --code C                   # 单只个股快照
tools review --date D                           # 每日复盘
tools events --date D                           # 公告/快讯
tools signals --date D                          # 策略信号

# 层 2 个股专题
tools stock-news --code C [--dates n | --start D --end D]   # 相关新闻/公告
tools financials --code C [--reports N]         # PIT 财报（默认最近 4 期）
tools valuation --code C [--dates n | --start D --end D]     # PE/PB/市值序列+period

# 层 3
tools series --view '<json view>' [--dates n | --start D --end D] [--mode stats|bars] [--granularity day|week|month]
tools review-digest [--dates n | --start D --end D]
tools stock-profile --code C [--dates n] [--blocks price,bars,news,financials,valuation,snapshot]
```

**退出码**：`0` 成功；`1` 数据缺失/业务错误（JSON 含 `error`）；`2` 参数错误（argparse）。

## 4. 接口契约（汇总）

完整字段与出参结构见附录 `docs/data-interfaces.md`。本 spec 只列接口清单与调用映射：

| 层 | ID | CLI 命令 | 对应 data-interfaces |
|---|---|---|---|
| 1 | I-01 | `dates` | 层 1 |
| 1 | I-02 | `latest` | 层 1 |
| 2 | I-03 | `market` | §5.2 |
| 2 | I-04 | `sectors` | §5.3 |
| 2 | I-08 | `universe` | §5.1 |
| 2 | I-09 | `stock` | §5.4 |
| 2 | I-10 | `stock-news` | §5.7 |
| 2 | I-11 | `financials` | §5.7 |
| 2 | I-12 | `valuation` | §5.7 |
| 2 | I-05 | `review` | §5.5 |
| 2 | I-06 | `events` | §5.6 |
| 2 | I-07 | `signals` | §5.6 |
| 3 | — | `series` | §6.1/§6.5/§6.6/§6.7 |
| 3 | — | `review-digest` | §6.3 |
| 3 | — | `stock-profile`（可选便利） | §6.8 |

## 5. 必守规则（红线）

- **只读**：任何命令不得调用 `write_asset`、不得写 `data/` 或 `lab/` 任何文件；只读是硬约束。
- **完整性**：读取前 `verify_manifest` 校验，损坏返回 `corrupted` 不输出半截数据；读入按 schema 信封解析。
- **规范化唯一入口**：所有代码进 `tools/normalize.py`（复用 `toSymbol` 等价逻辑），禁止各命令自造。
- **聚合口径唯一实现**：加权/等权只在 `tools/aggregate.py` 一处实现，period 口径只在 `tools/series.py` 一处实现（§6.6 口径表为唯一出处）。
- **源名透传 + `derived.*`**：透传数据不改名，派生字段进 `derived`。
- **只读失败不降级为写**：数据缺失返回空态/标注，不伪造、不补默认值。

> **未来扩展（不在当前范围）**：后续可能新增**专门写 lab 文件的工具**（如落 Idea/Signal/Conclusion 等生命周期对象）。届时写路径必须复用 `lifecycle/store.py`（版本化 + 不可变 + fail-fast 校验），并单独审批；当前 `tools/` 保持只读，写工具与读工具分开、不混用。

## 6. 边界与异常（CLI 行为）

- 缺失日期：`dates(n)` 自动跳过无数据日；单日读取缺数据 → 退出码 1 + `{error:"not_found", date}`。
- 缺失字段：返回 `null`，不伪造（如旧日期无 `amount_change_pct`）。
- 集合部分缺失：无行情标的进 `na` 计数，不参与平均，输出 `na` 名单。
- 越界/非法参数：symbol 不合规 → 退出码 2 + `{error:"bad_symbol"}`；`--dates` 区间非法 → 退出码 2。
- 损坏：`verify_manifest` 不一致 → 退出码 1 + `{error:"corrupted"}`。
- 超时：复用 export 脚本既有超时策略；`series(mode:"bars")` 不阻塞式重算（沿用缓存）。

## 7. 验证方式（对齐 intent §9）

1. **契约测试**：每个命令有 `scripts/test_tools_*.py`，按 `schemas/` 校验输出结构；非法输入（裸代码/越界/非法 symbol/非法参数）断言对应退出码与错误 JSON。
2. **golden 用例**：构造固定交易日窗口，`period` 指标与手工计算 / 现有 `aggregate` 脚本比对一致。
3. **全量回归**：新增测试并入 `bash scripts/run_all_tests.sh`，全绿。
4. **真实数据抽查**：用最近一个完整交易周的真实 `data/` 跑两个需求的调用序列，人工核对合理性（产出即 intent §5 的验收证据）。

## 8. 交付物清单

| 产物 | 说明 |
|---|---|
| `tools/` 模块 | normalize / dates / snapshot / stock_extra / aggregate / series / cli 入口 |
| `scripts/test_tools_*.py` | 契约测试 + golden 用例 |
| 本文档 + 附录 | spec.md（施工图）+ data-interfaces.md（字段字典） |
| 使用说明 | tools/README 或并入 AGENTS.md（可选） |

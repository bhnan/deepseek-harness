# Plan — A 股数据访问接口（tools/ CLI 实现计划）

> **Build 阶段产物（v0.1，待批准）**。输入：`docs/intent.md`（需求）+ `docs/spec.md`（设计）。
> **计划批准前不写任何实现代码**。批准后按 M1→M5 里程碑实施。

## 1. 范围与"不动"清单

**新建**：
```
tools/
├── __init__.py
├── cli.py            # argparse 命令面：14 个命令分发 + 退出码
├── _util.py          # 统一 JSON 信封输出 / 错误处理 / 退出码 / read_asset 封装
├── normalize.py      # symbol/行业代码规范化 + 名称匹配（唯一入口）
├── dates.py          # dates(n|区间)、latest（I-01/I-02）
├── snapshot.py       # market / sectors / universe / stock / review / events / signals（层2 快照）
├── stock_extra.py    # stock-news / financials / valuation（I-10/11/12）
├── aggregate.py      # 加权/等权聚合（唯一实现）
└── series.py         # series 两段式 + review-digest + stock-profile（层3）
tests/
└── test_tools_*.py   # 契约测试 + golden 口径比对（unittest，被 run_all_tests.sh 自动发现）
```

**不动**：`pipeline/`（采集与 io）、`scripts/` 现有文件、`host.js/route.js`（看板）、看板 client、`schemas/`。
**复用**：`pipeline/io.py`（`read_asset`/`verify_manifest`）、`collect_market.latest_trading_date`、`scripts/export_*.py`（个股/指数/行业/聚合日线）、`data/` 全部资产与 parquet/PIT csv。

> 注：`run_all_tests.sh` 已声明 `python -m unittest discover -s tests`，但 `tests/` 目前不存在；本计划新建 `tests/` 放入 tools 测试，**无需改 run_all_tests.sh**，既修好脚本预期又纳入全量回归。

## 2. 已核实的数据假设（实现依赖）

| 数据 | 位置 | 结构要点 |
|---|---|---|
| 日历 | `data/calendar/trade_dates.json` | 交易日数组；"有数据"判定 = `market/{d}/index_spot.json` 存在 |
| 大盘 | `market/{d}/index_spot.json`（indices）、`breadth.json`（market_breadth，旧日期回退 `a_spot` 的 `derived.market_breadth`） | 5 指数：代码/名称/最新价/涨跌幅/成交额 |
| 板块 | `sector/{d}/sw_l1_spot.json`（industries，中文源列名 + `derived.change_pct`） | 排序后 top/bottom 截断 |
| 成分行情 | `market/{d}/quotes_subset.json`（data.quotes，code→行情）；回退 `a_spot.json` | universe 取成分股行情 |
| 复盘/事件/信号 | `review/{d}/review.json`、`events/{d}/announcements.json`（announcements: 代码/简称/公告标题/公告时间/公告链接 + flashes）、`signals/{d}/signals.json`（status/scanned_count/strategies[]） | 直接透传 |
| 指数日线 | `data/market/index_daily.parquet`：`code,date,open,high,low,close,volume`（**英文列**） | bars |
| 行业日线 | `data/sector/sw_daily.parquet`：`code,日期,开盘,最高,最低,收盘,成交量,成交额`（**中文列**） | bars，需统一列名 |
| 财报 | `data/pit_financial/raw_profit_sheets/{SHxxxxxx}.csv`（REPORT_DATE/NOTICE_DATE/UPDATE_DATE/营收/净利/扣非/同比/EPS…） | PIT 时点 |
| 估值 | `data/pit_valuation/{market_cap_yi,pb,pe_ttm}/{code}.csv`（date,value） | 逐日序列 |
| 组合/自选 | `data/watchlist.json`（groups+symbols，入库）；`portfolio/` **当前为空**（模拟盘未跑） | universe 依赖显式 `--symbols`，不依赖 portfolio |
| 运行环境 | `.venv`（Python 3.12 + pandas）；**系统 python3 无 pandas** | 所有命令/测试必须用 `./.venv/bin/python` |

## 3. 实现顺序（里程碑）

| 里程碑 | 内容 | 验证 |
|---|---|---|
| **M1** 骨架 | `_util.py`（信封/退出码/read_asset 封装）+ `normalize.py` + `dates.py` + `cli.py` 框架 + `tests/test_tools_dates.py` | dates/latest 契约测试；normalize 用例 |
| **M2** 快照 | `snapshot.py`：market/sectors/stock/review/events/signals + universe（依赖 aggregate.stats）+ `tests/test_tools_snapshot.py` | 各命令输出按 schema 校验；universe 集合统计 |
| **M3** 个股专题 | `stock_extra.py`：stock-news/financials/valuation + `tests/test_tools_stock_extra.py` | 新闻匹配、PIT 过滤、估值序列 |
| **M4** 层 3 | `aggregate.py` 完整实现 + `series.py`（stats/bars/review-digest/stock-profile）+ `tests/test_tools_series.py`（含 **golden 口径比对**） | period 与手工计算一致；bars 列名统一 |
| **M5** 收尾 | `tools/README.md`（可选）+ 全量回归 + **真实数据抽查**（最近完整交易周跑两个需求的调用序列） | `run_all_tests.sh` 全绿；抽查结果合理 |

## 4. 关键实现决策

- **normalize.py（唯一入口）**：裸代码→前缀（6→sh、4/8→bj、其余→sz，复用 `toSymbol` 等价逻辑）；名称→代码（查 `quotes_subset`/`a_spot` 的名称字段）；行业 `801xxx` 校验；非法输入退出码 2。
- **dates.py**：读日历 + `index_spot` 存在性判定；`--dates n` 缺省 5；`--start/--end` 区间支持；跳过无数据日。
- **snapshot.py**：
  - market = `read_asset(index_spot)` + `breadth.json`（缺失回退 `a_spot.derived.market_breadth`，与 host.js 一致）；
  - sectors = `read_asset(sw_l1_spot)` 按 `derived.change_pct` 降序，`--top/--bottom` 截断；
  - universe = 成分行情（quotes_subset 优先/回退 a_spot）+ `aggregate.stats`（涨跌家数/平均/加权/top/bottom）；
  - stock = 单元素查找；review/events/signals 直接透传信封内 `data`。
- **stock_extra.py**：
  - stock-news：公告按 `代码` 精确匹配 + 快讯按标题/内容提及代码或简称匹配，区间合并排序；
  - financials：读 PIT CSV，按 `NOTICE_DATE` 时点过滤，输出最近 `--reports N`（默认 4）期，保留 notice_date/update_date；无报告返回空数组；
  - valuation：读三个 metric 的 `date,value`，对齐成逐日序列，`period` 复用 series 统一口径。
- **aggregate.py（唯一实现）**：`r_t = Σ w_i·r_it / Σ w_i`（缺省 w=1 即等权）；NAV 递推 `NAV_t = NAV_{t-1}(1+r_t)`，NAV_0=1.0；无行情标的进 `na` 不参与平均。
- **series.py**：
  - 归一化：index→`index_daily.parquet`（官方点位）；sector→`sw_daily.parquet`；stock→parquet 或 `export_daily_json.py`；universe→aggregate；
  - stats：§6.6 口径表唯一实现（首尾/高低/波动/涨跌天数/持续性 + universe 专属 set_top/persistence 等）；
  - bars：读 parquet 并**统一列名**（sw 中文列→英文：日期/开盘/最高/最低/收盘/成交量/成交额→date/open/high/low/close/volume/amount），`--granularity` 重采样（day/week/month）；
  - review-digest：逐日 `read_asset(review)` + regime/trend/risk 演变；
  - stock-profile：按 `--blocks` 组装（默认全 5 块 + snapshot）。

## 5. 验证方案

1. **契约测试**（`tests/test_tools_*.py`，unittest）：每个命令输出结构校验（对齐 `schemas/` 信封）、非法输入断言退出码 2 / 缺失断言退出码 1。
2. **golden 口径比对**：构造固定交易日窗口，`period` 指标与**手工计算**逐项比对（含等权/加权两套）。
3. **全量回归**：`bash scripts/run_all_tests.sh` 全绿（tools 测试被 `discover -s tests` 自动纳入）。
4. **真实数据抽查**：用最近一个完整交易周的真实 `data/` 跑两个需求调用序列（周报：dates+market+series(sector)+review-digest；个股：stock-profile 国轩高科 sz002074），人工核对合理性，结果作为验收证据附在交付说明。

## 6. 风险点与对策

| 风险 | 对策 |
|---|---|
| parquet 列名不一致（index 英文 / sw 中文） | series 内统一列名映射，测试覆盖两种 |
| 旧日期缺字段（如 `amount_change_pct`） | 返回 `null` 不伪造（§11 约定），测试覆盖 |
| breadth 独立文件仅新日期存在 | 回退 `a_spot.derived.market_breadth`（与 host.js 同逻辑） |
| portfolio 当前为空 | universe 只用显式 `--symbols`，不读 portfolio |
| 系统 python3 无 pandas | 全部用 `./.venv/bin/python`；cli.py 首行检查/文档注明 |
| `tests/` 目录原不存在 | 新建，避免触碰 run_all_tests.sh |

## 7. 本阶段明确不做

- 不写任何数据（只读红线）；不做写 lab 工具（未来扩展，见 spec §5 注记）
- 不改看板 / host.js / pipeline / 现有 scripts / schemas
- 不做 HTTP 形态（CLI 先行，升级路径已留）
- 不做实时/盘中数据

## 8. 待批准

本计划经批准后开始 M1。批准项：文件清单、里程碑顺序、关键实现决策、验证方案、风险对策。

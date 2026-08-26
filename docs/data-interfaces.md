# 数据访问接口字段字典（附录）

> 本文件是 **Design 阶段产物 `docs/spec.md` 的附录**——层 1/2/3 全部接口与字段 schema 的唯一出处。
> 设计决策、架构、CLI 命令面、必守规则、边界与验证见 [`docs/spec.md`](spec.md)；需求见 [`docs/intent.md`](intent.md)。
> 状态：评审稿 v0.1，随 spec 定稿同步。

## 1. 需求（用户故事）

> 需求清单已独立为 **Plan 阶段产物 [`docs/intent.md`](intent.md)**（含用户/约束/成功标准/非目标/验证方式）。本节保留用户故事摘要供对照；以 intent.md 为准。

本套接口由以下两个需求驱动抽象而来，可作为**其他分析需求的通用底座**（改参数即新需求）。

### 1.1 需求一：周度趋势分析（周报）

**用户故事**：用户让 Agent 总结最近一周的市场情况。Agent 需要汇总一周的大盘走势、板块强弱变化、以及过去每天 Agent 自己的盘后复盘，从而给出"这周市场怎么样"的判断。

**素材**（Agent 需要的数据）：
- 过去 5~7 天的大盘信息（指数、市场宽度、成交额）
- 过去 5 天的板块变化（每天前 5 / 后 5 板块是谁、整周谁最强/最弱、主线是否连续）
- 过去每天的 Agent 盘后复盘（每天 Agent 的判断，以及判断的演变）

**产出**：对本周的综合判断——大盘演变（首尾、高低点、量能）、板块强弱与持续性、市场风格/风险演变。

**调用序列**（见 §9）：
```
dates(5) + series(index) + series(sector, top5/bottom5) + review_digest(dates)
```

### 1.2 需求二：个股综合分析

**用户故事**：用户让 Agent 查看某只股票最近一段时间的表现（如"帮我看看国轩高科 `sz002074` 近期表现"）。Agent 需要该股的行情、K 线、区间高低点、相关新闻、财报、估值，综合判断它的表现与状态。

**素材**（Agent 需要的数据）：
- 股价 / K 线 / 区间最高最低（价格 stats + bars）
- 相关新闻 / 公告（区间内该股被提及或公告）
- 财报（最近几期利润表，PIT 时点）
- 估值（PE_TTM / PB / 总市值）
- 最新单日快照

**产出**：综合判断——价格趋势、K 线形态、消息面、基本面、估值水位。

**调用序列**（见 §9）：
```
一站式：dates(5) + stock_profile("sz002074", days)
分步：  series(stock, stats|bars) + stock_news + financials + valuation + stock(latest)
```

## 2. 核心设计原则

1. **"日期列表"是第一等公民**：周期分析本质 = "对最近 N 个交易日，逐日取 X，再汇总"。所有周期接口以 `dates` 为输入。
2. **View（视图）统一模型**：指数、板块、个股、组合、信号候选统一为"一个标的视图"，组合和信号候选 = **股票集合**（从个股演化），复用同一套读取与统计。
3. **两段式周期统计**：先**归一化**（把 View 变成一条值序列）→ 再**统一统计**（对任意值序列做同样的周期指标）。层 3 由此收敛为**一个通用接口**。
4. **板块成分不进 universe**：板块整体用官方点位（AKShare 直给），不拆成分；成分股级明细浏览是另一场景，不混入本套接口。
5. **复盘（review）不纳入 View 体系**：review 是 Agent 的文字判断，是独立的一类数据。

## 3. 分层总览

```
层 1  时间原语       dates(n|区间)、latest          —— 取哪几天
层 2  单日资产读取   market / sectors / universe / review / events / signals
                   + stock / stock_news / financials / valuation
                                                      —— 某一天/某标的数据是什么（原子读取）
层 3  周期派生       series(view, dates)           —— 逐日(层2) → 值序列 → 统一周期统计
                   + stock_profile(code, dates)    —— 个股综合分析包（可选便利，层2组装）
横切  契约           schema 校验、规范化约定、只读
```

---

## 4. 层 1：时间原语

| ID | 接口 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| I-01 | `dates` | `n`（最近 n 个）或 `[start, end]`（区间） | `["2026-08-19", ...]` | 最近 **n 个有数据的交易日**（或区间内）。"有数据" = 该日 `index_spot` 已落盘，自动跳过周末/节假日/管道未跑的天。所有周期接口的键。 |
| I-02 | `latest` | — | `"2026-08-25"` | 最近有数据交易日（含回退逻辑），即 I-01(n=1) 的特例，独立暴露。 |

## 5. 层 2：单日资产读取（原子单位）

所有接口以 `date` 为入参，返回**该日**数据。字段遵循源名透传 + `derived.*` 约定（见 §8）。

| ID | 接口 | 对应 View | 出参（关键字段） | 备注 |
|---|---|---|---|---|
| I-03 | `market(date)` | index | `{indices:[5大指数 代码/名称/最新价/涨跌幅/成交额], breadth:{advancers,decliners,limit_up,limit_down,total_amount}}` | 指数 + 宽度 + 量能，官方点位 |
| I-04 | `sectors(date, {top?, bottom?})` | sector | 申万一级 31 行业按 `derived.change_pct` 排序，`top=N`/`bottom=N` 截断，每项 `{code, name, change_pct, amount, pe, member_count}` | 官方点位，不拆成分 |
| I-08 | `universe(date, view)` | universe | 见 §5.1 | 覆盖**组合 / 信号候选**，不含板块成分 |
| I-09 | `stock(date, code)` | stock | 单只个股快照（行情字段） | = universe 单元素特例，可作 I-08 便捷别名 |
| I-05 | `review(date)` | — | `{summary, regime, trend, risk_level, market, sector, news[], watch_points[]}` | 每日复盘（Agent 产出） |
| I-06 | `events(date)` | — | 公告/快讯时间线 | 消息面 |
| I-07 | `signals(date)` | — | 策略信号扫描结果（当日） | 派生产物，供信号回顾 |

### 5.1 I-08 `universe(date, view)` 输出结构

```jsonc
{
  "date": "2026-08-25",
  "view": { "label": "我的持仓", "symbols": ["sh600519", ...], "weights": {"sh600519": 0.3, ...} },
  "stocks": [                     // 成分股当日行情（来自个股行情，按需拉取）
    { "code": "sh600519", "name": "贵州茅台", "last_price": 1450.0, "change_pct": 1.2, "weight": 0.3 },
    ...
  ],
  "stats": {                      // 集合内当日统计
    "advancers": 3, "decliners": 1, "flat": 0, "na": 0, "count": 4,
    "avg_change_pct": 0.85,       // 等权平均涨跌幅
    "weighted_change_pct": 0.92,  // 加权涨跌幅（view 带 weights 时）
    "top":  [ { "code": "...", "change_pct": 3.1 }, ... ],  // 集合内领涨
    "bottom": [ ... ]             // 集合内领跌
  }
}
```

**适用类型**：组合（portfolio / watchlist 自选）、信号候选（策略选出的 Top N，`view.scores` 可选带上）。
**当日 vs 周期**：层 2 只给"当日"（行情、集合内涨跌家数、平均/加权涨跌幅、集合内涨跌榜）；净值曲线（等权/加权，需基准日=1.0）属层 3。

**聚合口径（已定）**：统一按**加权**实现——`weights` 未指定时所有权重 = 1，即**等权**（等权 = 权重的特例）。未特殊指定一律按等权算。

### 5.2 I-03 `market(date)` 出参

```jsonc
{
  "date": "2026-08-25",
  "indices": [   // 5 大指数（sh000001 上证 / sz399001 深成 / sz399006 创业板 / sh000300 沪深300 / sh000905 中证500）
    { "code": "sh000001", "name": "上证指数", "last_price": 3250.0, "change_pct": 0.6, "amount": 4.2e11, "volume": 3.1e8 },
    ...
  ],
  "breadth": { "advancers": 3800, "decliners": 1200, "limit_up": 45, "limit_down": 3, "total_amount": 1.15e12 }
}
```

### 5.3 I-04 `sectors(date, {top?, bottom?})` 出参

```jsonc
{
  "date": "2026-08-25",
  "count": 31,
  "top":  [ { "code": "801080", "name": "电子", "change_pct": 3.2, "amount": 6.5e10, "pe": 42.1, "member_count": 100 }, ... ],  // top=N
  "bottom": [ { "code": "801030", "name": "基础化工", "change_pct": -2.1, ... }, ... ]  // bottom=N
}
```

- 未指定 `top`/`bottom` 时返回**全量 31 个**按 `change_pct` 降序的 `all` 数组（`top`/`bottom` 视为便捷截断视图）。
- `amount` 单位统一折算为元；`pe` 为 TTM 市盈率，缺省 `null` 不伪造。

### 5.4 I-09 `stock(date, code)` 出参

```jsonc
{
  "date": "2026-08-25",
  "stock": { "code": "sh600519", "name": "贵州茅台", "last_price": 1450.0, "change_pct": 1.2,
             "prev_close": 1432.8, "open": 1435.0, "high": 1460.0, "low": 1430.0, "amount": 5.2e10, "volume": 3.6e6 }
}
```

（= `universe(date, {symbols:[code]})` 的单元素特例，作为便捷别名提供。）

### 5.5 I-05 `review(date)` 出参（关键字段）

```jsonc
{
  "date": "2026-08-25",
  "review": {
    "summary": "大盘总结（2-4 句）",
    "regime": "risk_on" | "neutral" | "defensive",
    "trend": "up" | "range_bound" | "down",
    "risk_level": "low" | "medium" | "medium_high" | "high",
    "market": { "amount": 1.15e12, "amount_change_pct": 2.3, "volume_tone": "expand", "volume_note": "…", "breadth_note": "…" },
    "sector": { "leading_sectors": [{"name","reason"}], "lagging_sectors": [...], "main_lines": [...],
                "continuation": "…", "diffusion": "…", "divergence": "…", "retreat_signals": [...], "market_style": "…" },
    "news": [ { "title": "…", "impact": "…" } ],
    "watch_points": ["…"]
  }
}
```

> 字段以 `schemas/assets/review.json` 为准；缺失字段（如旧日期无 `amount_change_pct`）返回 `null`，不得伪造。

### 5.6 I-06 `events(date)` / I-07 `signals(date)` 出参（简述）

- `events(date)` → `{ announcements: [ {code, name, 公告时间, 标题, 摘要, 链接} ], flashes: [ {发布时间, 内容, 链接} ], coverage_note }`（自选范围公告 + 全局快讯）。
- `signals(date)` → `{ status: "scanned"|"not_scanned"|"disabled", scanned_count, strategies: [ {strategy_id, strategy_name, derived: {change_pct, signal_note, dsl_status, dsl_rules, constituents}} ] }`（当日策略信号扫描结果，直接透传 `data/signals` 资产）。

### 5.7 个股专题接口（综合分析的补齐）

服务于"某个股票最近一段时间的综合分析"需求。行情类已由 `stock`/`series` 覆盖；本组补齐**新闻、财报、估值**三类个股专属数据。

| ID | 接口 | 出参 | 数据来源 |
|---|---|---|---|
| I-10 | `stock_news(code, dates)` | 该股区间**相关公告 + 快讯**合并时间线（逐日过滤、按时间排序） | `events` 资产：公告按证券代码精确匹配；快讯按标题/内容提及代码或简称匹配 |
| I-11 | `financials(code, {reports?})` | 该股最近 `reports` 期（默认 4 期）**PIT 利润表**：报告期/类型/公告日、营收(+同比)、归母净利(+同比)、扣非(+同比)、TTM、EPS | `data/pit_financial/raw_profit_sheets` + 规范化面板（`lab/backtests/pit_financial_panel/normalized_financial_reports.csv`） |
| I-12 | `valuation(code, dates)` | 该股估值序列：`market_cap_yi`（总市值亿）、`pe_ttm`、`pb`（逐日，区间内） | `data/pit_valuation/{metric}/{code}.csv` |

**I-11 `financials(code)` 出参示例**：

```jsonc
{
  "code": "sh600000",
  "name": "浦发银行",
  "reports": [
    { "report_date": "2026-03-31", "report_type": "一季报", "notice_date": "2026-04-30",
      "total_operate_income": 465.7e8, "total_operate_income_yoy": 1.42,
      "parent_netprofit": 178.6e8, "parent_netprofit_yoy": 1.49,
      "deduct_parent_netprofit": 179.0e8, "deduct_parent_netprofit_yoy": 1.83,
      "parent_netprofit_ttm": null, "basic_eps": 0.52, "source": "akshare.stock_profit_sheet_by_report_em" },
    ...
  ]
}
```

> **PIT 时点性原则**：`financials` 返回的是"截至 `notice_date` 才可见"的报告（与面板构建口径一致），并保留 `notice_date`/`update_date` 供审计；`dates` 窗口早于 `notice_date` 的报告不参与该窗口的分析。

**I-12 `valuation(code, dates)` 出参示例**：

```jsonc
{
  "code": "sh600000",
  "series": [ { "date": "2026-08-19", "market_cap_yi": 2515.5, "pe_ttm": 6.1, "pb": 0.55 }, ... ],
  "period": { "pe_ttm": { "start": 6.1, "end": 6.0, "change_pct": -1.6 }, "pb": {...} }   // 复用 §6.6 统一口径
}
```

## 6. 层 3：周期派生接口

**定位**：把"N 个单日"变成"一个周期视图"。做两件事：

1. **一致的周期接口**：不管 5 天 / 20 天 / 任意区间，不管周期是周/月，都返回同一套结构 `{dates, daily[], period{}}`。
2. **预计算周期指标**：跨日指标用**固定口径**算好，Agent 直接取现成结果，避免各算各的口径不一致。

### 6.1 唯一接口

```
series(view, dates=5, {mode}) → {
  dates: [...],
  daily: [ ...每日本视图的值... ],
  period: { ...统一周期统计... }
}
```

- `dates` 缺省 = **最近 5 个交易日**（周度默认口径）。
- `mode` 两种输出形态（同一套 View 模型，见 §6.5）：
  - `mode: "stats"`（默认）→ 上述 `{dates, daily[], period{}}`
  - `mode: "bars"` → OHLCV K 线序列（图片辅助推理用），复用现有 daily/aggregate 端点

**两段式实现**（对任意 View 类型共用）：

```
① 归一化（Aggregate）: View → 一条"值序列"
     指数   → 官方点位序列
     板块   → 官方涨跌幅序列
     个股   → 该股日线序列
     universe → 成分股聚合（等权净值 / 加权净值 / 平均涨跌幅）—— 复用现有 aggregate 逻辑

② 统一统计（Stats）: 对任意值序列计算
     首尾涨跌、区间高低点、成交额趋势、持续性……
     universe 额外：集合内 top/bottom、涨跌家数、权重收益
```

### 6.2 与 View 类型的对应

| 需求 | 调用 |
|---|---|
| 周度大盘 | `series({type:"index"})` |
| 周度板块 | `series({type:"sector"})`（官方涨跌幅序列） |
| 周度个股 | `series({type:"stock", symbols:[code]})` |
| 组合周报 | `series({type:"universe", symbols:持仓, weights})` |
| 信号周报 | `series({type:"universe", symbols:信号候选, scores})` |
| 复盘汇总 | `review_digest(dates)`（见 §6.3，非 View 体系） |

### 6.3 复盘汇总（独立，不纳入 View 体系）

```
review_digest(dates) → {
  daily: [ { date, summary, regime, trend, risk_level }, ... ],
  evolution: { regime: [...], regime_shift: "risk_on→defensive",
               trend_consistent: true, risk_escalation: true }
}
```

### 6.4 输出示例（II-01 `market_series(dates)` 等价形态）

```jsonc
{
  "dates": ["2026-08-19", ..., "2026-08-25"],
  "daily": [ { "date": "2026-08-19", "indices": {...}, "breadth": {...} }, ... ],
  "period": {
    "index_change": { "sh000001": { "start": 3210.5, "end": 3250.0, "change_pct": 1.23, "high": 3262, "low": 3188 }, ... },
    "amount": { "avg": 1.15e12, "trend": "expand", "start": 1.02e12, "end": 1.28e12 },
    "breadth_evolution": [ { "date": "...", "advancers": 3800, "decliners": 1200 }, ... ]
  }
}
```

> `daily` 与 `period` **默认都输出**；Agent 只需 `period` 时 `daily` 可裁剪，需要细节时单独调层 2。

### 6.5 K 线（bars）——复用同一套 View 模型，不另立一族

现有接口**已经在返回 K 线**：`/api/trading/stock/{code}/daily.json`、`sector/{code}/daily.json`、`index/{code}/daily.json`、`aggregate.json`（等权净值 K 线）。因此 K 线直接作为 `series` 的一种输出形态，而非新开一族：

```
series(view, dates, {mode: "bars", granularity: "day"|"week"|"month"})
  → { view, dates, bars: [ { date, open, high, low, close, volume, amount }, ... ] }
```

- 指数 / 板块 / 个股 → 读 parquet 日线（或现有 daily 端点）
- universe（组合/信号候选）→ 走现有 `aggregate` 逻辑（等权/加权净值 K 线）
- `granularity` 重采样复用客户端已有 `resampleBars` 口径
- 用途：Agent 需要**图片辅助推理**（K 线可视化）时，与 stats 模式共用同一个 view 参数

### 6.6 `period` 统一统计指标口径（固定，不得各算各的）

对任意"值序列" `x[0..n-1]`（日期升序），统一计算：

| 指标 | 口径定义 |
|---|---|
| `start` / `end` | 区间首个 / 末个交易日的值 |
| `change_pct` | 首尾涨跌幅：`(end - start) / start × 100` |
| `high` / `low` | 区间内最大值 / 最小值（及对应日期 `high_date`/`low_date`） |
| `daily_returns` | 逐日涨跌幅序列（用于进一步计算，可选输出） |
| `volatility` | 区间逐日收益率的波动率（样本标准差，可选） |
| `positive_days` / `negative_days` | 区间内上涨 / 下跌天数 |
| `consistency` | 逐日同向占比：`max(涨天数, 跌天数)/n`（趋势一致性） |

**universe（股票集合）额外指标**：

| 指标 | 口径定义 |
|---|---|
| `set_top` / `set_bottom` | 集合内**整段区间累计涨跌幅**排序的前/后 N（不是单日） |
| `advancers` / `decliners` / `flat` / `na` | 集合内整段区间上涨 / 下跌 / 持平 / 无数据 只数 |
| `weighted_change_pct` | 区间首尾**加权**涨跌幅（默认等权 = 权重 1） |
| `persistence` | 连续 ≥K 个交易日进入集合内前 N 的标的（K、N 可配，默认 K=3、N=5） |
| `regime_tally` | 区间内各日 regime/trend/risk 的分布（供判断演变） |

> 所有口径**一次实现、处处复用**：层 3 是"口径的唯一出处"，Agent 与任何调用方拿到的 `period` 数字一致。

### 6.7 聚合公式（加权 / 等权）

给定集合 `{i}`、权重 `w_i`（未指定时 `w_i = 1`，即等权）：

```
单日平均涨跌幅   r_t = Σ w_i·r_it / Σ w_i          （r_it = 第 i 只股票 t 日涨跌幅）
加权净值        NAV_t = NAV_{t-1} · (1 + r_t)       （NAV_0 = 1.0）
区间加权涨跌幅   R = (NAV_end / NAV_start - 1) × 100
```

- 等权 = 权重全 1 的特例，同一套实现。
- 无行情 / 停牌 / 数据缺失的标的按 `na` 计数，不参与当日平均（`r_t` 只对有效样本求加权均值）；输出中标注 `na`。
- universe 净值 K 线（`mode:"bars"`）即上述 `NAV_t` 序列，复用现有 `aggregate` 端点。

### 6.8 个股综合分析包 `stock_profile(code, dates)`（层 3 复合）

> **可选便利接口（非底层契约）**：纯组装层 2 接口，无新口径；Agent 不用它时自行分步调用层 2 接口等价（见 §9）。保留它是为"要一个完整个股画像"这类诉求提供一次性入口。

"看某个股票最近一段时间的综合分析"需求的一次性打包接口——**组装层 2 的行情 + 新闻 + 财报 + 估值**，Agent 一次调用即可获得全部素材：

```
stock_profile(code, dates=5) → {
  "view": { "type": "stock", "symbols": [code], "label": "贵州茅台" },
  "price": { ...series({type:"stock"}, dates, {mode:"stats"})... },   // 价格 stats：首尾/区间高低/成交额/波动
  "bars":  { ...series({type:"stock"}, dates, {mode:"bars", granularity:"day"})... },  // K 线（图片辅助）
  "news":  [ ...stock_news(code, dates)... ],        // 相关新闻/公告
  "financials": [ ...financials(code, {reports:4})... ],  // 财报（PIT）
  "valuation": { ...valuation(code, dates)... },     // PE/PB/市值
  "snapshot": { ...stock(latest, code)... }          // 最新单日快照（便捷）
}
```

- 组装即"逐块调用层 2 接口"，无新口径；块可裁剪（如只要 `price+news`）。
- 供 Agent 做**个股综合分析**：价格趋势 + K 线形态 + 消息面 + 基本面（财报）+ 估值水位。
- `dates` 缺省同样 = 最近 5 个交易日。

## 7. View 模型（统一）

```jsonc
{ "type": "index" | "sector" | "stock" | "universe",
  "symbols": ["sh600519", ...],     // 个股/组合/信号候选 = 股票代码；指数/板块 = 单个代码
  "weights": { "sh600519": 0.3 },   // 组合可选
  "scores":  { "sh600519": 92 },    // 信号候选可选（策略分数）
  "label": "我的持仓" }
```

- 指数 / 板块 / 个股 = 特殊 View（官方点位直接用；个股 = 单元素集合）
- 组合 / 信号候选 = Universe View（带权重/分数），从个股演化

## 8. 横切契约

- **III-01 输出信封**：统一 `{schema_version, data, data_quality?}`；读取时 schema 校验 + manifest 完整性校验（防读损坏/半截文件）。
- **III-02 规范化（约定说明，非新工作）**：接口层承诺遵守已有约定——
  - 存储代码已统一 `sh/sz/bj+6位`（schema 强制）、行业 `801xxx`（已实测：`bj920000`、`801010`）；
  - 字段透传源名，派生字段进 `derived.*`（如板块 `derived.change_pct`）；
  - 入口接受裸代码 / 带前缀代码 / 名称，统一规范后查询（复用客户端 `toSymbol` 等已有逻辑）；
  - 输出遵循 adapters 统一模型（`ticker/market/change_percent` 等）。
- **III-03 只读 + 审计**：接口只读，不写入任何数据；访问可记录日志。

## 9. 需求 → 接口映射示例

```
周度趋势分析 = dates(5~7)
            + series({type:"index"})          // 大盘周度
            + series({type:"sector"}, top5/bottom5)  // 板块周度 + 每天前/后5
            + review_digest(dates)            // 每天复盘串起来
            → Agent 综合判断"这周情况"
```

改参数即新需求：`dates(20)` = 月度；`dates(1)` = 单日回顾；`series(universe, 持仓)` = 组合周报；`series(universe, 信号候选)` = 信号周报。

**周报的典型调用序列**（Agent 数据装配流程）：

```
1. days = dates(5)                              # 取最近 5 个交易日
2. mk   = series({type:"index"}, days)          # 大盘：指数首尾/高低点/成交额/宽度演变
3. se   = series({type:"sector"}, days, {top:5, bottom:5})   # 板块：每天前/后5 + 整周榜 + 持续性
4. rv   = review_digest(days)                   # 复盘：每天 Agent 判断 + regime/trend/risk 演变
5. （可选）combine = series({type:"universe", symbols:持仓}, days)   # 组合周度
6. → 把 2/3/4（+5）交给 Agent 综合成周度判断
```

**个股综合分析的调用**（第二个需求）：

```
stock_profile("sh600519", days)   # 一次拿到：价格stats + K线 + 新闻 + 财报 + 估值 + 最新快照
→ Agent 综合分析：趋势、形态、消息面、基本面、估值水位
# 或按需分块：
#   series({type:"stock", symbols:["sh600519"]}, days)   —— 股价/K线/最高最低
#   stock_news("sh600519", days)                          —— 相关新闻
#   financials("sh600519")                                —— 财报
#   valuation("sh600519", days)                           —— 估值
```

**接口清单（全部）**：

| 层 | ID | 接口 | 用途 |
|---|---|---|---|
| 1 | I-01 | `dates(n\|区间)` | 最近 n 个有数据交易日 |
| 1 | I-02 | `latest` | 最近有数据交易日 |
| 2 | I-03 | `market(date)` | 大盘（指数+宽度+量能） |
| 2 | I-04 | `sectors(date, {top,bottom})` | 板块快照/排名 |
| 2 | I-08 | `universe(date, view)` | 股票集合单日快照（组合/信号候选） |
| 2 | I-09 | `stock(date, code)` | 单只个股快照 |
| 2 | I-10 | `stock_news(code, dates)` | 个股相关新闻/公告（区间） |
| 2 | I-11 | `financials(code, {reports})` | 个股 PIT 财报 |
| 2 | I-12 | `valuation(code, dates)` | 个股估值（PE/PB/市值） |
| 2 | I-05 | `review(date)` | 每日复盘 |
| 2 | I-06 | `events(date)` | 公告/快讯 |
| 2 | I-07 | `signals(date)` | 策略信号 |
| 3 | — | `series(view, dates, {mode})` | 周期统计 / K 线（stats\|bars） |
| 3 | — | `review_digest(dates)` | 复盘周期汇总 |
| 3 | — | `stock_profile(code, dates)` | 个股综合分析包（**可选便利**，纯组装） |

## 10. 已确认事项

1. **I-01 "有数据"判定**：✅ 采用"该日 `index_spot` 已落盘"（与现有 `latestDate()` 逻辑一致）。
2. **聚合口径**：✅ 统一按**加权**实现，`weights` 未指定时默认等权（权重=1）；未特殊指定一律等权。
3. **层 3 输出**：✅ `daily` 与 `period` 默认都输出（`daily` 可裁剪）；`dates` 缺省 = 最近 5 个交易日。
4. **K 线 bar 接口**：✅ 复用同一套 View 模型，作为 `series` 的 `mode:"bars"` 输出形态（见 §6.5），不另立一族；用于图片辅助推理。
5. **接口形态**：⏳ 待定（CLI / HTTP / DSH 工具），定契约后再定实现方式。
6. **`stock_profile`**：✅ 保留，标注为**可选便利接口**（非底层契约，纯组装层 2，无新口径）；Agent 可自行分步调用等价。
7. **个股专题接口（I-10/11/12）不做周期汇总、不通用化**：✅ 新闻的周期化=区间过滤、财报的周期化=最近 N 期、估值已内置 period；目前仅个股一个使用方，停留在个股级。

## 11. 错误处理与数据质量约定

- **缺失日期**：该日数据未落盘 → 返回 `{error: "not_found", date}`；`dates(n)` 自动跳过缺失日（以 `index_spot` 为判定），因此正常路径不会拿到缺日。
- **缺失字段**：旧日期 / 数据质量标注（`data_quality.missing`）导致的字段缺失 → 对应字段返回 `null`（如旧日期无 `amount_change_pct`），**不得伪造、不得补默认值**。
- **部分缺失（集合）**：universe 中无行情的标的进 `na` 计数，不参与平均；输出 `na` 名单。
- **路径越界 / 非法参数**：拒绝访问（对应 403/400），仅 JSON，schema 校验 fail-fast。
- **数据损坏**：读文件前做 manifest 完整性校验，不一致时返回 `{error: "corrupted"}` 而非半截数据。
- **降级原则**：任何缺失都走"空态/标注"，不让 Agent 拿到带病数据。

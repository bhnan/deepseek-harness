---
name: trading-data-access
description: >-
  指导 Agent 用仓库内的 tools CLI 只读访问 A 股盘后数据（大盘/板块/个股/组合/复盘/新闻/财报/估值），
  提供命令面、调用约定与典型工作流（周报、个股综合分析）。适用于任何需要"取数"做分析的任务——
  优先走 tools，不裸读 data/ 文件。设计依据 docs/intent.md、docs/spec.md、docs/data-interfaces.md。
whenToUse: >-
  用户要求分析大盘/板块/个股/组合/信号、生成周报或月度趋势、查看某只股票的近期表现（价格/K线/新闻/财报/估值）、
  复盘汇总，或任何需要读取 A 股盘后数据的分析任务时。也适用于让 Agent 判断"这周市场怎么样"、
  "某只股票最近如何"这类数据驱动的问题。
metadata:
  version: 1.0.0
---

# A 股数据访问（tools CLI）Skill

本 skill 教 Agent 用仓库内的 **`tools/` CLI** 只读访问 A 股盘后数据，替代直接翻 `data/` 文件。

## 为什么走 tools

- **只读 + 安全**：CLI 不写任何数据，symbol/名称自动规范化，schema 信封统一；
- **口径一致**：周期统计、聚合（加权/等权）、复盘演变都在 CLI 内一处实现，不会各算各的；
- **省事**：日期窗口、最新交易日回退、数据缺失处理都已封装。

## 调用方式（约定）

```bash
# 从仓库根目录运行（工作目录通常是 /root/bhn/trading）
./.venv/bin/python -m tools <command> [options]
```

- 输出：JSON 到 stdout；错误：`{error: ...}` 到 stderr + 非零退出码（0 成功 / 1 数据错误 / 2 参数错误）
- `--asof YYYY-MM-DD`：按指定日期取最近数据（复现/测试用；缺省=今天）
- 代码形态：裸代码 `600519`、带前缀 `sh600519`、后缀 `601318.SH`、名称 `贵州茅台` 均可，自动规范化

## 命令面

### 层 1 时间
```bash
tools dates [-n N | --start D --end D] [--asof D]   # 最近 N 个有数据交易日（缺省 5）
tools latest [--asof D]                             # 最近有数据交易日
```

### 层 2 快照
```bash
tools market --date D                 # 大盘：5指数 + 市场宽度（涨跌家数/涨跌停/成交额）
tools sectors --date D [--top N] [--bottom N]   # 申万一级行业，按涨跌幅排序/截断
tools universe --date D --symbols a,b [--weights w1,w2] [--label L]  # 股票集合（组合/信号候选）
tools stock --date D --code C         # 单只个股快照（最新价/涨跌幅/开高低/量额）
tools review --date D                 # 每日复盘（summary/regime/trend/risk/板块/要点）
tools events --date D                 # 公告/快讯
tools signals --date D                # 策略信号扫描结果
```

### 层 2 个股专题
```bash
tools stock-news --code C [--dates N|--start D --end D]   # 该股相关公告+快讯（区间）
tools financials --code C [--reports N]                   # PIT 财报（缺省最近4期）
tools valuation --code C [--dates N|--start D --end D]    # PE_TTM/PB/市值 + period + coverage
```

### 层 3 周期（把 N 天变成一个周期视图）
```bash
tools series --view '<json>' [--dates N|--start D --end D] [--mode stats|bars] [--granularity day|week|month]
tools review-digest [--dates N|--start D --end D]
tools stock-profile --code C [--dates N] [--blocks price,bars,news,financials,valuation,snapshot]
```

`--view` 示例：
- 指数：`{"type":"index","symbols":["sh000001"]}`
- 板块：`{"type":"sector","symbols":["801010"]}`
- 个股：`{"type":"stock","symbols":["sz002074"]}`
- 组合/信号候选：`{"type":"universe","symbols":["sh600519","sz002074"],"weights":[0.7,0.3],"label":"测试"}`

## 典型工作流

### 周报 / 周度趋势分析
```bash
tools dates -n 5                                # 取最近 5 个交易日
tools series --view '{"type":"index","symbols":["sh000001"]}' -n 5       # 大盘周度
tools sectors --date D --top 5 --bottom 5       # 每天前5/后5板块（对每个交易日调用）
tools series --view '{"type":"sector","symbols":["801010"]}' -n 5        # 板块整周走势
tools review-digest -n 5                        # 复盘演变（regime/trend/risk）
```

### 个股综合分析（如国轩高科 sz002074）
```bash
tools stock-profile --code sz002074 -n 5        # 一次拿全：价格+K线+新闻+财报+估值+快照
# 或分步：
tools series --view '{"type":"stock","symbols":["sz002074"]}' -n 5 --mode bars   # K线（图片辅助）
tools stock-news --code sz002074 -n 5
tools financials --code sz002074
tools valuation --code sz002074 -n 5
```

### 组合/信号候选
```bash
tools universe --date D --symbols 持仓代码 --weights 权重     # 组合单日快照
tools series --view '{"type":"universe","symbols":[...],"weights":[...]}' -n 5   # 组合净值/集合内统计
```

## 数据注意事项

- **缺失**：返回 `null`/空态，不伪造；集合内无行情标进 `na`；估值带 `coverage`（数据陈旧度）。
- **日线滞后**：`sw_daily`/个股日线 parquet 可能滞后于快照（如只到 08-18 而快照到 08-26）——bars 窗口无数据时返回空，属正常数据状态，选窗口时留意。
- **只读红线**：本 CLI 只读，不写 `data/` 或 `lab/`；写 lab 文件是另一套未来工具，勿混用。

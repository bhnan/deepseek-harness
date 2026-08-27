# tools — A 股数据访问 CLI（只读）

给 Agent 的一致、只读数据访问接口（设计：`docs/spec.md` / `docs/intent.md`；字段字典：`docs/data-interfaces.md`）。

## 用法

```bash
./.venv/bin/python -m tools <command> [options]   # 输出 JSON 到 stdout
```

退出码：`0` 成功 / `1` 数据缺失或业务错误 / `2` 参数错误（错误 JSON 走 stderr）。

## 命令一览

```bash
# 层 1 时间
tools dates [-n N | --start D --end D] [--asof D]   # 最近 N 个有数据交易日（缺省 5）
tools latest [--asof D]

# 层 2 快照
tools market --date D                # 大盘（指数+宽度+量能）
tools sectors --date D [--top N] [--bottom N]
tools universe --date D --symbols a,b [--weights w1,w2] [--label L]
tools stock --date D --code C
tools review --date D                # 每日复盘
tools events --date D                # 公告/快讯
tools signals --date D               # 策略信号

# 层 2 个股专题
tools stock-news --code C [--dates N|--start D --end D]
tools financials --code C [--reports N]      # PIT 财报（缺省最近 4 期）
tools valuation --code C [--dates N|--start D --end D]   # PE/PB/市值（含 coverage 标注）

# 层 3 周期
tools series --view '<json>' [--dates N|--start D --end D] [--mode stats|bars] [--granularity day|week|month]
tools review-digest [--dates N|--start D --end D]
tools stock-profile --code C [--dates N] [--blocks price,bars,news,financials,valuation,snapshot]
```

`--view` 示例：
- 指数：`{"type":"index","symbols":["sh000001"]}`
- 板块：`{"type":"sector","symbols":["801010"]}`
- 个股：`{"type":"stock","symbols":["sz002074"]}`
- 组合/信号候选：`{"type":"universe","symbols":["sh600519","sz002074"],"weights":[0.7,0.3],"label":"测试"}`

## 约定

- **只读**：不写 `data/` 或 `lab/` 任何文件。
- 代码形态：裸代码 / 带前缀（sh/sz/bj）/ 后缀（600519.SH）/ 名称 均可，统一规范化。
- 数据缺失：返回 `null`/空态，不伪造；集合内无行情标进 `na`。
- `--asof`：测试/复现用锚点，取该日及以前最近有数据的交易日。

## 测试

```bash
./.venv/bin/python -m unittest discover -s tests
```

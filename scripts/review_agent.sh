#!/bin/bash
# 盘后复盘 Agent 任务：headless agent 生成复盘文字（LLM），写回 review.json。
#
# 触发：cron（data/cron/tasks.json 的 review-agent 任务，每交易日数据管道之后）
# 原理：dsh --profile headless 一次性 agent —— 读取当日数字骨架与数据文件，
#       生成复盘文字（summary/量能/涨跌结构/板块解读/watch_points），
#       只替换"待 Agent 生成"占位，数字与结构不变；已人工回填的复盘跳过。
#
# 用法：bash scripts/review_agent.sh [YYYY-MM-DD]   （缺省 = 最新数据日）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${1:-}" ]; then
  DATE="$1"
else
  # 先登录获取 session cookie（auth-basic 插件需要认证）
  COOKIE_JAR=$(mktemp /tmp/review-agent-cookies.XXXXXX)
  trap 'rm -f "$COOKIE_JAR"' EXIT
  curl -s -X POST http://127.0.0.1:3080/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"deepseek-harness-2024"}' \
    -c "$COOKIE_JAR" > /dev/null
  DATE=$(curl -s -b "$COOKIE_JAR" http://127.0.0.1:3080/api/trading/latest.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('date',''))")
fi
if [ -z "$DATE" ]; then
  echo "review-agent: 无法确定数据日" >&2
  exit 1
fi
REVIEW="data/review/$DATE/review.json"
if [ ! -f "$REVIEW" ]; then
  echo "review-agent: $REVIEW 不存在（先跑数据管道）" >&2
  exit 1
fi
# 已人工回填（无占位）→ 跳过，绝不覆盖
if ! grep -q "待 Agent 生成" "$REVIEW"; then
  echo "review-agent: $DATE 复盘已回填，跳过"
  exit 0
fi

PROMPT="你是 A 股盘后复盘分析师。今天是 ${DATE}。

任务：为 data/review/$DATE/review.json 生成复盘文字（该文件的数字骨架已由数据管道注入，必须原样保留，一个数字都不得修改）。请先阅读：
- data/review/$DATE/review.json（数字骨架：指数无关，含涨跌家数/涨跌停/成交额/环比/板块领涨领跌）
- data/market/$DATE/index_spot.json（指数涨跌幅）
- data/sector/$DATE/sw_l1_spot.json（申万一级行业当日表现）
- data/events/$DATE/announcements.json（公告/快讯，作为消息面要点）

需要生成/替换的内容（只替换含『待 Agent 生成』的字段与空字符串 reason，其余字段原样保留）：
1. summary：大盘总结（指数表现 + 涨跌结构 + 风格 + 量能 + 消息面，2-4 句，客观基于数字）
2. market.breadth_note：涨跌结构解读（普涨/普跌/分化、涨停跌停含义）
3. market.volume_note：量能解读（成交额水平、环比含义、放量/缩量信号）
4. sector.leading_sectors[].reason 与 lagging_sectors[].reason（各 3 条，给出涨跌幅与归因）
5. sector.continuation / diffusion / divergence：主线持续性、扩散度、分歧（基于数字）
6. sector.retreat_signals：若领跌板块大跌或跌停潮出现则给提示，否则保持空数组
7. sector.market_style：市场风格（防御/成长/周期/消费/主题轮动）
8. sector.main_lines：当日主线（领涨方向归类）
9. watch_points：2-3 条后续观察要点（数字驱动，不编造预测）
10. regime / trend / risk_level：根据数字重新判断并更新（regime 取值 risk_on/neutral/defensive，trend 取值 up/range_bound/down，risk_level 取值 low/medium/medium_high/high；依据：涨跌比、涨停跌停、指数涨跌、成交额变化）

完成后用 python3 把修改写回 data/review/$DATE/review.json（保持 JSON 结构，缩进 1）。全部完成输出：复盘完成 $DATE"

OUTPUT=$(dsh --profile headless "$PROMPT" 2>&1)
echo "review-agent: $DATE done"
echo "$OUTPUT" | tail -5
exit 0

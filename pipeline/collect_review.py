"""A14 盘后复盘：数字注入 + 文字骨架。

原则（schema 规范）：amount/amount_change_pct/breadth 由脚本注入当天数据（A4），
LLM 只写 *_note/summary/news/sector 解读——本脚本产出"数字已注入、文字待 Agent"的骨架，
由 DSH 会话中的 Agent 复核并回填（禁止 LLM 编造数字）。
"""
import json
from pathlib import Path

from .io import DATA_ROOT, read_asset, write_asset


def prev_trading_date(trading_date: str) -> str | None:
    cal = DATA_ROOT / "calendar" / "trade_dates.json"
    dates = json.loads(cal.read_text(encoding="utf-8"))
    before = [d for d in dates if d < trading_date]
    return before[-1] if before else None


def build_review_data(a_spot: dict, index_spot: dict, sw_spot: dict,
                      prev_amount: float | None, news_items: list[dict]) -> dict:
    """纯函数（可单测）：注入数字 + 骨架文字。

    prev_amount 为 None 时（昨日 A4 缺失，快照不可补历史）→ 环比/量能定调字段整体缺席。
    """
    breadth = a_spot["data"]["derived"]["market_breadth"]
    amount = breadth["total_amount"]
    market: dict = {
        "amount": amount,
        "breadth": {
            "advancers": breadth["advancers"],
            "decliners": breadth["decliners"],
            "limit_up": breadth["limit_up"],
            "limit_down": breadth["limit_down"],
        },
        "breadth_note": "（涨跌结构解读待 Agent 生成）",
    }
    if prev_amount:
        change_pct = round((amount / prev_amount - 1) * 100, 2)
        market["amount_change_pct"] = change_pct
        market["volume_tone"] = "shrink" if change_pct < -5 else ("expand" if change_pct > 5 else "flat")
        market["volume_note"] = "（量能解读待 Agent 生成）"

    inds = sorted(sw_spot["data"]["industries"], key=lambda r: r["derived"]["change_pct"], reverse=True)
    leading = [{"name": r["指数名称"], "reason": ""} for r in inds[:3]]
    lagging = [{"name": r["指数名称"], "reason": ""} for r in inds[-3:][::-1]]

    return {
        "summary": "（复盘文字待 Agent 生成）",
        "regime": "neutral",
        "trend": "range_bound",
        "risk_level": "medium",
        "watch_points": [],
        "market": market,
        "news": [{"title": n["title"], "impact": ""} for n in news_items[:5]],
        "sector": {
            "leading_sectors": leading,
            "lagging_sectors": lagging,
            "main_lines": [],
            "continuation": "（待 Agent 生成）",
            "diffusion": "（待 Agent 生成）",
            "divergence": "（待 Agent 生成）",
            "retreat_signals": [],
            "market_style": "rotational",
        },
    }


def collect_review(trading_date: str) -> Path:
    """A14：骨架落盘（数字注入）。已回填的复盘绝不覆盖（防止 cron 补跑冲掉 Agent 文字）。"""
    existing = DATA_ROOT / "review" / trading_date / "review.json"
    if existing.exists():
        old_data = json.loads(existing.read_text(encoding="utf-8"))["data"]
        if "待 Agent 生成" not in old_data.get("summary", ""):
            return existing   # 已回填 → 保留
    a = read_asset("a_spot", trading_date)
    sw = read_asset("sw_l1_spot", trading_date)
    index_spot = read_asset("index_spot", trading_date)

    prev_amount = None
    prev_date = prev_trading_date(trading_date)
    prev_path = DATA_ROOT / "market" / prev_date / "a_spot.json" if prev_date else None
    if prev_path and prev_path.exists():
        # 快照不可补历史（新浪 spot 只返回最近收盘）：昨日文件缺失则环比缺席，不得伪造
        prev_amount = json.loads(prev_path.read_text(encoding="utf-8"))["data"]["derived"]["market_breadth"]["total_amount"]

    news_items = []
    ann_path = DATA_ROOT / "events" / trading_date / "announcements.json"
    if ann_path.exists():
        ann = json.loads(ann_path.read_text(encoding="utf-8"))["data"]
        ranked = sorted(ann.get("announcements", []),
                        key=lambda r: {"high": 2, "medium": 1, "low": 0}.get(
                            r.get("derived", {}).get("severity"), 0), reverse=True)
        news_items = [{"title": r["公告标题"]} for r in ranked]

    data = build_review_data(a, index_spot, sw, prev_amount, news_items)
    return write_asset(
        "review", trading_date, data,
        data_quality={"missing": ["summary", "volume_note", "breadth_note",
                                  "sector.continuation", "sector.diffusion", "sector.divergence"],
                      "note": "数字由脚本注入；文字待 Agent 复核回填"})

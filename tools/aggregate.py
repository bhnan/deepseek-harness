"""加权/等权聚合（tools 唯一实现，spec §5 红线 / §6.7 公式）。

给定集合 {i}、权重 w_i（缺省 1 = 等权）：
  r_t = Σ w_i·r_it / Σ w_i
无行情标的进 na，不参与平均。
"""
from __future__ import annotations


def stats(stocks: list[dict], top_n: int = 5) -> dict:
    """集合内当日统计。stocks: [{code, change_pct, weight?}]。"""
    valid = [s for s in stocks if s.get("change_pct") is not None]
    na = [s for s in stocks if s.get("change_pct") is None]

    def _w(s, default):
        w = s.get("weight")
        return w if w is not None else default

    wsum = sum(_w(s, 1) for s in valid) or 1.0
    weighted = sum(s["change_pct"] * _w(s, 1) for s in valid) / wsum
    avg = sum(s["change_pct"] for s in valid) / len(valid) if valid else None

    advancers = sum(1 for s in valid if s["change_pct"] > 0)
    decliners = sum(1 for s in valid if s["change_pct"] < 0)
    flat = sum(1 for s in valid if s["change_pct"] == 0)

    ranked = sorted(valid, key=lambda s: s["change_pct"], reverse=True)
    return {
        "advancers": advancers,
        "decliners": decliners,
        "flat": flat,
        "na": len(na),
        "count": len(stocks),
        "avg_change_pct": round(avg, 4) if avg is not None else None,
        "weighted_change_pct": round(weighted, 4),
        "top": [{"code": s["code"], "change_pct": s["change_pct"]} for s in ranked[:top_n]],
        "bottom": [{"code": s["code"], "change_pct": s["change_pct"]}
                   for s in ranked[-top_n:][::-1]],
    }


def daily_returns(stocks_by_date: dict[str, list[dict]]) -> dict[str, float | None]:
    """逐日集合加权平均涨跌幅（series 归一化用）。日期 → r_t（无有效样本为 None）。"""
    out = {}
    for date, stocks in stocks_by_date.items():
        valid = [s for s in stocks if s.get("change_pct") is not None]
        if not valid:
            out[date] = None
            continue
        wsum = sum((s.get("weight") if s.get("weight") is not None else 1) for s in valid) or 1.0
        out[date] = sum(
            s["change_pct"] * (s.get("weight") if s.get("weight") is not None else 1)
            for s in valid) / wsum
    return out


def nav(returns: dict[str, float | None]) -> list[dict]:
    """NAV 递推（NAV_0=1.0）。返回 [{date, nav}]；None 样本保持上一日净值。"""
    nav_list, cur = [], 1.0
    for date in sorted(returns):
        r = returns[date]
        if r is not None:
            cur = cur * (1 + r / 100)
        nav_list.append({"date": date, "nav": round(cur, 6)})
    return nav_list

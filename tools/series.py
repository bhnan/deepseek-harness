"""层 3：series 两段式（归一化→统一统计）+ review-digest + stock-profile。

period_stats 为 §6.6 统一统计口径的**唯一实现**（spec §5 红线）。
"""
from __future__ import annotations

import statistics


def period_stats(values: list[dict]) -> dict:
    """统一周期统计（§6.6）：输入 [{date, value}]（升序），输出 period 指标。

    空输入/全 None → {}。start/end 首尾值；change_pct 首尾涨跌 %；high/low 区间高低；
    positive/negative_days 相对前一日上涨/下跌天数；volatility 逐日收益样本标准差；
    consistency = max(涨,跌)/有效日。
    """
    vals = [v.get("value") for v in values if v.get("value") is not None]
    if not vals:
        return {}
    returns = []
    for i in range(1, len(vals)):
        prev = vals[i - 1]
        if prev:
            returns.append((vals[i] - prev) / prev * 100)
    pos = sum(1 for r in returns if r > 0)
    neg = sum(1 for r in returns if r < 0)
    n = len(returns) or 1
    return {
        "start": vals[0],
        "end": vals[-1],
        "change_pct": round((vals[-1] - vals[0]) / vals[0] * 100, 4) if vals[0] else None,
        "high": max(vals),
        "low": min(vals),
        "positive_days": pos,
        "negative_days": neg,
        "volatility": round(statistics.pstdev(returns), 4) if len(returns) >= 2 else None,
        "consistency": round(max(pos, neg) / n, 4),
    }

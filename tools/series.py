"""层 3：series 两段式（归一化→统一统计）+ review-digest + stock-profile。

period_stats 为 §6.6 统一统计口径的**唯一实现**（spec §5 红线）。
归一化：index/sector/stock 读日线 parquet；universe 用逐日集合加权涨跌幅 → NAV。
"""
from __future__ import annotations

import json
import statistics

import pandas as pd

from ._util import DATA_ROOT, DataError, ParamError, read_asset
from .aggregate import daily_returns, nav

RISK_RANK = {"low": 0, "medium": 1, "medium_high": 2, "high": 3}


# ---------------- §6.6 统一统计口径（唯一实现） ----------------

def period_stats(values: list[dict]) -> dict:
    """统一周期统计：输入 [{date, value}]（升序），输出 period 指标。

    start/end 首尾值；change_pct 首尾涨跌 %；high/low 区间高低；
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


# ---------------- 归一化：单标的日线 ----------------

def _match_code(code: str, available: list[str]) -> str | None:
    """按精确/后缀匹配 code（处理 000001 这类与个股代码空间重叠的指数）。"""
    if code in available:
        return code
    hits = [c for c in available if c.endswith(code) and len(code) == 6]
    return hits[0] if len(hits) == 1 else None


def _read_bars(vtype: str, code: str, dates: list[str]) -> list[dict]:
    """读某类型单标的日线 bar（date/open/high/low/close/volume/amount），过滤到窗口 dates。"""
    if vtype == "index":
        df = pd.read_parquet(DATA_ROOT / "market" / "index_daily.parquet")
        c = _match_code(code, list(df["code"].unique()))
        if not c:
            raise DataError(f"bad_index_code: {code}")
        df = df[df["code"] == c]
        bars = [{"date": str(r["date"])[:10], "open": r["open"], "high": r["high"],
                 "low": r["low"], "close": r["close"], "volume": r["volume"], "amount": None}
                for _, r in df.iterrows()]
    elif vtype == "sector":
        df = pd.read_parquet(DATA_ROOT / "sector" / "sw_daily.parquet")
        c = _match_code(code, list(df["code"].unique()))
        if not c:
            raise DataError(f"bad_sector_code: {code}")
        df = df[df["code"] == c]
        bars = [{"date": str(r["日期"])[:10], "open": r["开盘"], "high": r["最高"],
                 "low": r["最低"], "close": r["收盘"], "volume": r["成交量"],
                 "amount": r["成交额"]}
                for _, r in df.iterrows()]
    elif vtype == "stock":
        from .normalize import normalize
        from pipeline.collect_stock import daily_path, fetch_daily

        sym = normalize(code)
        p = daily_path(sym, "hfq")
        if not p.exists():
            fetch_daily(sym, adjust="hfq")  # on-demand 拉取（池外股票首次 ~2s）
            p = daily_path(sym, "hfq")
        df = pd.read_parquet(p)
        bars = [{"date": str(r["date"])[:10], "open": r["open"], "high": r["high"],
                 "low": r["low"], "close": r["close"], "volume": r.get("volume"),
                 "amount": r.get("amount")}
                for _, r in df.iterrows()]
    else:
        raise ParamError(f"bad_view_type: {vtype}")
    win = set(dates)
    return [b for b in bars if b["date"] in win]


def _resample(bars: list[dict], granularity: str) -> list[dict]:
    """重采样（day 原样；week 按 ISO 周；month 按年月）。"""
    if granularity == "day":
        return bars
    import itertools

    def key(b):
        d = b["date"]
        if granularity == "week":
            import datetime

            dt = datetime.date.fromisoformat(d)
            iso = dt.isocalendar()
            return f"{iso[0]}-W{iso[1]:02d}"
        return d[:7]

    out = []
    for _, grp in itertools.groupby(bars, key=key):
        g = list(grp)
        out.append({"date": g[-1]["date"], "open": g[0]["open"],
                    "high": max(x["high"] for x in g if x["high"] is not None),
                    "low": min(x["low"] for x in g if x["low"] is not None),
                    "close": g[-1]["close"],
                    "volume": sum(x["volume"] for x in g if x["volume"] is not None) or None,
                    "amount": sum(x["amount"] for x in g if x["amount"] is not None) or None})
    return out


# ---------------- universe 归一化 ----------------

def _universe(view: dict, dates: list[str], top_n: int) -> dict:
    from .normalize import normalize
    from .snapshot import _quotes_light

    sym_list = [normalize(s) for s in (view.get("symbols") or [])]
    if not sym_list:
        raise ParamError("empty_symbols")
    weights = view.get("weights")
    if weights and len(weights) != len(sym_list):
        raise ParamError("weights 数量与 symbols 不一致")

    by_date: dict[str, list[dict]] = {}
    stock_daily = {s: [] for s in sym_list}
    for d in dates:
        quotes = _quotes_light(d, sym_list)
        rows = []
        for i, s in enumerate(sym_list):
            w = weights[i] if weights else 1
            q = quotes.get(s)
            rows.append({"code": s, "change_pct": q.get("涨跌幅") if q else None, "weight": w})
            stock_daily[s].append({"date": d, "change_pct": rows[-1]["change_pct"]})
        by_date[d] = rows

    rets = daily_returns(by_date)
    navs = nav(rets)
    daily = [{"date": x["date"], "nav": x["nav"], "change_pct": rets.get(x["date"])}
             for x in navs]
    period = period_stats([{"date": x["date"], "value": x["nav"]} for x in navs])

    # 集合内整段累计（复利）
    per_stock = []
    for s in sym_list:
        comp, n = 1.0, 0
        for row in stock_daily[s]:
            cp = row["change_pct"]
            if cp is not None:
                comp *= (1 + cp / 100)
                n += 1
        per_stock.append({"code": s, "period_return_pct": round((comp - 1) * 100, 4) if n else None,
                          "days_with_data": n})
    ranked = sorted([p for p in per_stock if p["period_return_pct"] is not None],
                    key=lambda p: p["period_return_pct"], reverse=True)
    period["set_top"] = ranked[:top_n]
    period["set_bottom"] = ranked[-top_n:][::-1]

    # 持续性：进入当日 top N 的天数
    from collections import Counter

    top_counter = Counter()
    for d in dates:
        rows = sorted([r for r in by_date[d] if r["change_pct"] is not None],
                      key=lambda r: r["change_pct"], reverse=True)[:top_n]
        for r in rows:
            top_counter[r["code"]] += 1
    period["persistence"] = [{"code": c, "days_in_top": k} for c, k in
                             top_counter.most_common(3) if k >= 2]

    return {"view": view, "dates": dates, "daily": daily, "period": period}


# ---------------- series 主入口 ----------------

def series(view_json: str | dict, dates: list[str], mode: str = "stats",
           granularity: str = "day", top_n: int = 5) -> dict:
    view = json.loads(view_json) if isinstance(view_json, str) else view_json
    vtype = view.get("type")
    if vtype not in ("index", "sector", "stock", "universe"):
        raise ParamError(f"bad_view_type: {vtype}")

    if vtype == "universe":
        if mode == "bars":
            u = _universe(view, dates, top_n)
            return {"view": view, "dates": dates,
                    "bars": [{"date": x["date"], "open": x["nav"], "high": x["nav"],
                              "low": x["nav"], "close": x["nav"], "volume": None, "amount": None}
                             for x in u["daily"]]}
        return _universe(view, dates, top_n)

    symbols = view.get("symbols") or []
    if len(symbols) != 1:
        raise ParamError("index/sector/stock 需单个 symbol")
    bars = _read_bars(vtype, str(symbols[0]), dates)
    if mode == "bars":
        return {"view": view, "dates": dates, "bars": _resample(bars, granularity)}

    # stats：value = close
    daily = []
    for i, b in enumerate(bars):
        prev_close = bars[i - 1]["close"] if i and bars[i - 1]["close"] else None
        chg = round((b["close"] - prev_close) / prev_close * 100, 4) if prev_close else None
        daily.append({"date": b["date"], "close": b["close"], "change_pct": chg,
                      "volume": b["volume"], "amount": b["amount"]})
    period = period_stats([{"date": b["date"], "value": b["close"]} for b in bars])
    period["high"] = max((b["high"] for b in bars if b["high"] is not None), default=None)
    period["low"] = min((b["low"] for b in bars if b["low"] is not None), default=None)
    return {"view": view, "dates": dates, "daily": daily, "period": period}


# ---------------- review-digest ----------------

def review_digest(dates: list[str]) -> dict:
    daily = []
    for d in dates:
        try:
            r = read_asset("review", d)["data"]
        except DataError:
            continue
        daily.append({"date": d, "summary": r.get("summary"), "regime": r.get("regime"),
                      "trend": r.get("trend"), "risk_level": r.get("risk_level")})
    regimes = [x["regime"] for x in daily if x.get("regime")]
    shifts = [f"{regimes[i - 1]}→{regimes[i]}" for i in range(1, len(regimes))
              if regimes[i] != regimes[i - 1]]
    trends = {x["trend"] for x in daily if x.get("trend")}
    risk_escalation = any(
        RISK_RANK.get((daily[i - 1].get("risk_level") or ""), 0)
        < RISK_RANK.get((daily[i].get("risk_level") or ""), 0)
        for i in range(1, len(daily)))
    return {
        "dates": dates,
        "daily": daily,
        "evolution": {
            "regime": regimes,
            "regime_shift": " → ".join(shifts) if shifts else None,
            "trend_consistent": len(trends) == 1 and bool(trends),
            "risk_escalation": risk_escalation,
        },
    }


# ---------------- stock-profile（可选便利，组装层 2） ----------------

def stock_profile(code: str, dates: list[str], blocks: str | None = None) -> dict:
    from .normalize import normalize
    from .snapshot import stock as stock_snapshot
    from .stock_extra import financials as fin, stock_news, valuation as val

    sym = normalize(code)
    allowed = ("price", "bars", "news", "financials", "valuation", "snapshot")
    bl = set((blocks or ",".join(allowed)).split(","))
    bad = bl - set(allowed)
    if bad:
        raise ParamError(f"bad_blocks: {','.join(sorted(bad))}")

    out = {"view": {"type": "stock", "symbols": [sym], "label": sym}, "dates": dates}
    sv = json.dumps({"type": "stock", "symbols": [sym]})
    if "price" in bl:
        out["price"] = series(sv, dates, mode="stats")
    if "bars" in bl:
        out["bars"] = series(sv, dates, mode="bars")
    if "news" in bl:
        out["news"] = stock_news(sym, dates)
    if "financials" in bl:
        out["financials"] = fin(sym)
    if "valuation" in bl:
        out["valuation"] = val(sym, dates)
    if "snapshot" in bl:
        d = dates[-1]
        try:
            out["snapshot"] = stock_snapshot(d, sym)
        except DataError:
            out["snapshot"] = None
    return out

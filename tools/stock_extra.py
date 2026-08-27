"""层 2 个股专题：stock-news / financials / valuation（I-10/11/12）。

- stock-news：公告按证券代码匹配；快讯按标题/内容提及代码或简称匹配（与看板 Entity 页同逻辑）。
- financials：PIT 利润表，最近 N 期（按 NOTICE_DATE），保留 notice_date/update_date 供审计。
- valuation：PE_TTM/PB/市值 逐日序列（asof 取数）+ period 统计（口径在 series.period_stats）。
"""
from __future__ import annotations

import csv
from pathlib import Path

from ._util import DATA_ROOT, DataError, read_asset
from .normalize import normalize

METRICS = ["market_cap_yi", "pe_ttm", "pb"]
METRIC_NAMES = {"market_cap_yi": "总市值", "pe_ttm": "市盈率(TTM)", "pb": "市净率"}


def _stock_name(sym: str) -> str | None:
    """简称：从最近行情表取（供快讯匹配）。"""
    from .dates import latest
    from .snapshot import _quotes_light

    d = latest()
    if not d:
        return None
    q = _quotes_light(d, [sym])
    info = q.get(sym)
    return info.get("名称") if info else None


def stock_news(code: str, dates: list[str]) -> dict:
    sym = normalize(code)
    ticker = sym[2:]
    name = _stock_name(sym)
    items = []
    for d in dates:
        try:
            env = read_asset("announcements", d)
        except DataError:
            continue
        data = env["data"]
        for a in data.get("announcements", []):
            a_code = str(a.get("代码") or "")
            if a_code == ticker or a_code.endswith(ticker):
                items.append({"date": d, "kind": "announcement", "code": a_code,
                              "name": a.get("简称"), "title": a.get("公告标题"),
                              "time": a.get("公告时间"), "url": a.get("公告链接")})
        for f in data.get("flashes", []):
            text = f"{f.get('标题') or ''} {f.get('内容') or ''}"
            if ticker in text or (name and name in text):
                items.append({"date": d, "kind": "flash", "title": f.get("标题"),
                              "time": f"{f.get('发布日期') or ''} {f.get('发布时间') or ''}".strip(),
                              "url": f.get("链接"), "content": f.get("内容")})
    items.sort(key=lambda x: (x.get("time") or x["date"]), reverse=True)
    return {"code": sym, "dates": dates, "items": items, "count": len(items)}


def _f(v) -> float | None:
    """空值 → None。"""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def financials(code: str, reports: int = 4) -> dict:
    sym = normalize(code)
    path = DATA_ROOT / "pit_financial" / "raw_profit_sheets" / f"{sym.upper()}.csv"
    if not path.exists():
        raise DataError(f"financials_unavailable: {sym}")
    import pandas as pd

    df = pd.read_csv(path)
    cols = ["SECURITY_CODE", "REPORT_DATE", "REPORT_TYPE", "REPORT_DATE_NAME", "NOTICE_DATE",
            "UPDATE_DATE", "OPERATE_INCOME", "OPERATE_INCOME_YOY", "PARENT_NETPROFIT",
            "PARENT_NETPROFIT_YOY", "DEDUCT_PARENT_NETPROFIT", "DEDUCT_PARENT_NETPROFIT_YOY",
            "BASIC_EPS"]
    df = df[[c for c in cols if c in df.columns]].copy()
    df = df.sort_values("NOTICE_DATE", ascending=False, na_position="last").head(reports)
    out = []
    for _, r in df.iterrows():
        out.append({
            "report_date": str(r.get("REPORT_DATE") or "")[:10] or None,
            "report_type": r.get("REPORT_TYPE"),
            "report_date_name": r.get("REPORT_DATE_NAME"),
            "notice_date": str(r.get("NOTICE_DATE") or "")[:10] or None,
            "update_date": str(r.get("UPDATE_DATE") or "")[:10] or None,
            "total_operate_income": _f(r.get("OPERATE_INCOME")),
            "total_operate_income_yoy": _f(r.get("OPERATE_INCOME_YOY")),
            "parent_netprofit": _f(r.get("PARENT_NETPROFIT")),
            "parent_netprofit_yoy": _f(r.get("PARENT_NETPROFIT_YOY")),
            "deduct_parent_netprofit": _f(r.get("DEDUCT_PARENT_NETPROFIT")),
            "deduct_parent_netprofit_yoy": _f(r.get("DEDUCT_PARENT_NETPROFIT_YOY")),
            "basic_eps": _f(r.get("BASIC_EPS")),
            "source": "akshare.stock_profit_sheet_by_report_em",
        })
    return {"code": sym, "reports": out}


def _load_valuation(sym: str, metric: str) -> dict[str, float | None]:
    """date → value（全量加载，单股单指标 CSV 很小）。"""
    path = DATA_ROOT / "pit_valuation" / metric / f"{sym[2:]}.csv"
    out: dict[str, float | None] = {}
    if not path.exists():
        return out
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            v = _f(row.get("value"))
            if v is not None:
                out[row["date"]] = v
    return out


def _asof(series: dict[str, float], d: str) -> float | None:
    """≤ d 的最近值。"""
    best = None
    for k in series:
        if k <= d and (best is None or k > best):
            best = k
    return series.get(best) if best else None


def valuation(code: str, dates: list[str]) -> dict:
    from .series import period_stats

    sym = normalize(code)
    loaded = {m: _load_valuation(sym, m) for m in METRICS}
    # 数据覆盖标注：各指标最新数据日期（asof 到窗口时可能滞后，供 Agent 判断陈旧度）
    coverage = {m: (max(loaded[m]) if loaded[m] else None) for m in METRICS}
    rows = []
    for d in dates:
        row = {"date": d}
        for m in METRICS:
            row[m] = _asof(loaded[m], d)
        rows.append(row)
    period = {}
    for m in METRICS:
        vals = [{"date": r["date"], "value": r[m]} for r in rows if r[m] is not None]
        period[m] = period_stats(vals)
    return {"code": sym, "dates": dates, "series": rows, "coverage": coverage,
            "metrics": METRIC_NAMES, "period": period}

"""层 2 单日资产读取（快照）：market / sectors / universe / stock / review / events / signals。

输出遵循契约模型（data-interfaces.md §5），源中文列名 → 统一英文键：
  code / name / last_price / change_pct / amount ...
"""
from __future__ import annotations

from ._util import DATA_ROOT, DataError, ParamError, load_json, read_asset


# ---------------- 适配（源字段 → 契约模型） ----------------

def adapt_index(row: dict) -> dict:
    return {
        "code": row.get("代码"), "name": row.get("名称"),
        "last_price": row.get("最新价"), "change_pct": row.get("涨跌幅"),
        "amount": row.get("成交额"), "volume": row.get("成交量"),
    }


def adapt_industry(row: dict) -> dict:
    d = row.get("derived") or {}
    return {
        "code": row.get("指数代码"), "name": row.get("指数名称"),
        "last_price": row.get("最新价"), "change_pct": d.get("change_pct"),
        "amount": row.get("成交额"), "volume": row.get("成交量"),
        "pe": row.get("TTM(滚动)市盈率"), "pb": row.get("市净率"),
        "member_count": row.get("成份个数"), "dividend_yield": row.get("静态股息率"),
    }


def adapt_stock(row: dict) -> dict:
    return {
        "code": row.get("代码"), "name": row.get("名称"),
        "last_price": row.get("最新价"), "change_pct": row.get("涨跌幅"),
        "prev_close": row.get("昨收"), "open": row.get("今开"),
        "high": row.get("最高"), "low": row.get("最低"),
        "amount": row.get("成交额"), "volume": row.get("成交量"),
    }


# ---------------- 行情表 ----------------

def _quotes_light(date: str, symbols: list[str] | None = None) -> dict[str, dict]:
    """精简行情 code → {名称, 最新价, 涨跌幅}。

    quotes_subset 优先；**指定 symbols 中缺失的**再回退全市场 a_spot（避免为单个代码
    拉 1.9MB 全量）。symbols 缺省 = 只读 quotes_subset。
    """
    q: dict[str, dict] = {}
    try:
        q = dict(read_asset("quotes_subset", date, subdir="market")["data"].get("quotes") or {})
    except DataError:
        pass
    missing = [s for s in (symbols or []) if s not in q]
    if missing:
        try:
            a = read_asset("a_spot", date)
            for r in a["data"].get("stocks", []):
                if r.get("代码") in missing:
                    q[r["代码"]] = {"名称": r.get("名称"), "最新价": r.get("最新价"),
                                    "涨跌幅": r.get("涨跌幅")}
        except DataError:
            pass
    return q


# ---------------- 命令实现 ----------------

def market(date: str) -> dict:
    idx = read_asset("index_spot", date)
    indices = [adapt_index(r) for r in idx["data"].get("indices", [])]
    return {"date": date, "indices": indices, "breadth": _breadth(date)}


def _breadth(date: str) -> dict:
    bf = DATA_ROOT / "market" / date / "breadth.json"
    if bf.exists():
        return load_json(bf)["data"].get("market_breadth") or {}
    a = read_asset("a_spot", date)
    mb = a["data"].get("derived", {}).get("market_breadth")
    if mb:
        return mb
    raise DataError(f"breadth_unavailable: {date}")


def sectors(date: str, top: int | None = None, bottom: int | None = None) -> dict:
    sw = read_asset("sw_l1_spot", date)
    industries = [adapt_industry(r) for r in sw["data"].get("industries", [])]
    industries.sort(key=lambda x: (x["change_pct"] is None, x["change_pct"] or -1e9), reverse=True)
    out = {"date": date, "count": len(industries)}
    if top is None and bottom is None:
        out["all"] = industries
    else:
        if top:
            out["top"] = industries[:top]
        if bottom:
            out["bottom"] = industries[-bottom:][::-1]
    return out


def stock(date: str, code: str) -> dict:
    from .normalize import normalize

    sym = normalize(code, date)
    a = read_asset("a_spot", date)
    for r in a["data"].get("stocks", []):
        if r.get("代码") == sym:
            return {"date": date, "stock": adapt_stock(r)}
    raise DataError(f"not_found: {sym} @ {date}")


def universe(date: str, symbols: str, weights: str | None = None, label: str = "组合") -> dict:
    from .aggregate import stats
    from .normalize import normalize

    sym_list = [normalize(s, date) for s in symbols.split(",") if s.strip()]
    if not sym_list:
        raise ParamError("empty_symbols")
    wlist = None
    if weights:
        wlist = [float(x) for x in weights.split(",")]
        if len(wlist) != len(sym_list):
            raise ParamError("weights 数量与 symbols 不一致")
    quotes = _quotes_light(date, sym_list)
    stocks = []
    for i, sym in enumerate(sym_list):
        w = wlist[i] if wlist else 1
        q = quotes.get(sym)
        if q:
            stocks.append({"code": sym, "name": q.get("名称"),
                           "last_price": q.get("最新价"), "change_pct": q.get("涨跌幅"), "weight": w})
        else:
            stocks.append({"code": sym, "name": None, "last_price": None,
                           "change_pct": None, "weight": w})
    return {"date": date, "view": {"label": label, "symbols": sym_list, "weights": wlist},
            "stocks": stocks, "stats": stats(stocks)}


def review(date: str) -> dict:
    env = read_asset("review", date)
    return {"date": date, "review": env["data"]}


def events(date: str) -> dict:
    env = read_asset("announcements", date)
    return {"date": date, **env["data"]}


def signals(date: str) -> dict:
    env = read_asset("signals", date)
    return {"date": date, **env["data"]}

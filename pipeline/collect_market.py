"""A1/A2/A4 采集：交易日历、指数收盘快照、全市场收盘快照（含 derived 市场宽度）。

原则（数据需求文档）：
- 源字段原样透传：指数/个股快照字段 = AKShare 新浪接口原列名，不翻译不改名
- derived 层放本系统计算字段：市场宽度（源接口没有）
- A4 全市场快照每日仅调 1 次（新浪封 IP 告警）
"""
from pathlib import Path

import pandas as pd

from .io import DATA_ROOT, write_asset

# 前端需求 4.1.1 的五个指数（新浪代码形态）
INDEX_CODES = ["sh000001", "sz399001", "sz399006", "sh000300", "sh000905"]

CALENDAR_FILE = DATA_ROOT / "calendar" / "trade_dates.json"


def collect_calendar() -> Path:
    """A1：交易日历（新浪）。落盘为 JSON 数组，按日期升序。"""
    import akshare as ak

    df = ak.tool_trade_date_hist_sina()
    dates = sorted(str(d) for d in df["trade_date"].tolist())
    CALENDAR_FILE.parent.mkdir(parents=True, exist_ok=True)
    CALENDAR_FILE.write_text(
        __import__("json").dumps(dates, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return CALENDAR_FILE


def latest_trading_date(asof: str | None = None) -> str:
    """最近一个 ≤ asof（默认今天）的交易日。"""
    import json

    if asof is None:
        asof = pd.Timestamp.now().strftime("%Y-%m-%d")
    dates = json.loads(CALENDAR_FILE.read_text(encoding="utf-8"))
    return max(d for d in dates if d <= asof)


def collect_index_spot(trading_date: str) -> Path:
    """A2：指数收盘快照。stock_zh_index_spot_sina 单次返回全部指数，裁剪所需 5 个，字段原样。"""
    import akshare as ak

    df = ak.stock_zh_index_spot_sina()
    sel = df[df["代码"].isin(INDEX_CODES)].copy()
    if sel.empty:
        raise RuntimeError(f"指数快照未取到目标指数: {INDEX_CODES}")
    indices = sel.to_dict(orient="records")
    return write_asset("index_spot", trading_date, {"indices": indices})


def compute_breadth(df: pd.DataFrame) -> dict:
    """A4 derived 市场宽度（纯函数，可单测）。

    涨跌停判定（护栏 T1 口径）：涨停价 = round(昨收 × 1.1, 2)（主板近似；创业板/北交所
    20%/30% 的判定留待板块信息接入后细化，schema 已注明口径）。
    """
    prev = df["昨收"].astype(float)
    px = df["最新价"].astype(float)
    valid = prev > 0
    advancers = int((valid & (px > prev)).sum())
    decliners = int((valid & (px < prev)).sum())
    unchanged = int((valid & (px == prev)).sum())
    limit_price = (prev * 1.1).round(2)
    limit_down_price = (prev * 0.9).round(2)
    limit_up = int((valid & (px >= limit_price)).sum())
    limit_down = int((valid & (px <= limit_down_price)).sum())
    total_amount = float(df["成交额"].astype(float).sum())
    return {
        "advancers": advancers,
        "decliners": decliners,
        "unchanged": unchanged,
        "limit_up": limit_up,
        "limit_down": limit_down,
        "total_amount": total_amount,
    }


def collect_a_spot(trading_date: str) -> Path:
    """A4：全市场个股收盘快照 + derived 市场宽度。每日仅调用 1 次（封 IP 防护）。

    市场宽度同时落独立小文件 market/<date>/breadth.json（KB 级，前端市场宽度卡片
    直接加载，无需下载 1.9MB 全市场快照现算）。
    """
    import akshare as ak

    df = ak.stock_zh_a_spot()
    stocks = df.to_dict(orient="records")
    breadth = compute_breadth(df)
    a_spot_path = write_asset("a_spot", trading_date, {"stocks": stocks, "derived": {"market_breadth": breadth}})
    # 独立市场宽度文件：信封结构与 a_spot 一致（schema_version + data）
    breadth_path = a_spot_path.parent / "breadth.json"
    payload = {"schema_version": "1.0", "data": {"market_breadth": breadth}}
    tmp = breadth_path.with_suffix(".tmp")
    tmp.write_text(__import__("json").dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(breadth_path)  # 原子替换
    return a_spot_path


def collect_quotes_subset(trading_date: str) -> Path:
    """按需子集行情快照：market/<date>/quotes_subset.json。

    收集三类股票的行情（来自 a_spot 匹配，仅保留少数股票，KB 级）：
      1. watchlist.json 各组合 symbols
      2. signals/<date>/signals.json 各策略 derived.constituents
    前端 Watchlist/Signals 页直接加载本文件，不再下载 1.9MB 全市场快照现算。
    结构：{"schema_version":"1.0","data":{"quotes":{"sh601398":{"名称","最新价","涨跌幅"}, ...}}}
    key = 完整代码（带交易所前缀）。源文件缺失时该集合为空，不报错。
    """
    import json as _json

    a_spot_path = DATA_ROOT / "market" / trading_date / "a_spot.json"
    if not a_spot_path.exists():
        raise RuntimeError(f"a_spot 缺失，无法预计算子集行情: {a_spot_path}")
    a_spot = _json.loads(a_spot_path.read_text(encoding="utf-8"))
    px = {str(s["代码"]): s for s in a_spot["data"]["stocks"]}

    symbols: set[str] = set()
    # 1) watchlist.json（用户维护）
    wl_path = DATA_ROOT / "watchlist.json"
    if wl_path.exists():
        try:
            wl = _json.loads(wl_path.read_text(encoding="utf-8"))
            for g in wl.get("groups") or []:
                for sym in g.get("symbols") or []:
                    symbols.add(str(sym))
            for sym in wl.get("symbols") or []:  # 兼容旧结构
                symbols.add(str(sym))
        except Exception:
            pass  # 解析失败则不包含自选
    # 2) signals 策略成分股
    sg_path = DATA_ROOT / "signals" / trading_date / "signals.json"
    if sg_path.exists():
        try:
            sg = _json.loads(sg_path.read_text(encoding="utf-8"))
            for st in sg.get("data", {}).get("strategies") or []:
                for c in (st.get("derived") or {}).get("constituents") or []:
                    if c.get("symbol"):
                        symbols.add(str(c["symbol"]))
        except Exception:
            pass

    quotes = {}
    for sym in sorted(symbols):
        q = px.get(sym)
        if q is None:
            continue  # 无行情（停牌等）→ 跳过
        quotes[sym] = {"名称": q["名称"], "最新价": q["最新价"], "涨跌幅": q["涨跌幅"]}
    out_dir = DATA_ROOT / "market" / trading_date
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "quotes_subset.json"
    payload = {"schema_version": "1.0", "data": {"quotes": quotes}}
    tmp = out.with_suffix(".tmp")
    tmp.write_text(_json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(out)  # 原子替换
    return out


def run_market(trading_date: str) -> dict:
    """盘后市场类资产一键采集：A2 + A4。返回 {资产: 路径}。"""
    result = {}
    result["index_spot"] = str(collect_index_spot(trading_date))
    result["a_spot"] = str(collect_a_spot(trading_date))
    return result

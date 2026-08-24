"""多标的等权聚合日线 JSON 导出（host 路由 /api/trading/aggregate.json 的后端）。

策略/组合 → 合成净值序列（起点 100）→ OHLC bars（open=前日净值，high/low=max/min(open,close)）。
支持两类标的：股票（sh/sz/bj 前缀，个股日线缓存）与板块（801xxx，sw_daily.parquet）。
单标的失败容错跳过；日期取并集，缺失日按前值填充（停牌/新股）。
用法：python scripts/export_aggregate_daily.py sh600519,sz000001,801780 持仓股
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from pipeline.collect_stock import daily_path, fetch_daily

SYMBOL_RE = r"^(sh|sz|bj)\d{6}$"
SECTOR_RE = r"^801\d{3}$"
MAX_SYMBOLS = 50
DATA_ROOT = Path(__file__).resolve().parent.parent / "data"
SECTOR_DAILY = DATA_ROOT / "sector" / "sw_daily.parquet"


def _sector_close(code: str) -> pd.Series:
    """板块收盘序列（sw_daily.parquet，code=801xxx）。"""
    try:
        df = pd.read_parquet(SECTOR_DAILY)
        df["日期"] = pd.to_datetime(df["日期"])
        s = df[df["code"] == code].set_index("日期")["收盘"].astype(float)
        return s.sort_index()
    except Exception:
        return pd.Series(dtype=float)


def load_close(symbol: str) -> pd.Series:
    """单标的收盘序列（股票走个股日线缓存，板块走 sw_daily.parquet），失败返回空。"""
    if re.match(SYMBOL_RE, symbol):
        try:
            p = daily_path(symbol, "hfq")
            if not p.exists():
                fetch_daily(symbol, adjust="hfq")
                p = daily_path(symbol, "hfq")
            if not p.exists():
                return pd.Series(dtype=float)
            df = pd.read_parquet(p)
            if df.empty or "date" not in df.columns or "close" not in df.columns:
                return pd.Series(dtype=float)
            s = df.set_index("date")["close"].astype(float)
            s.index = pd.to_datetime(s.index)
            return s.sort_index()
        except Exception:
            return pd.Series(dtype=float)
    if re.match(SECTOR_RE, symbol):
        return _sector_close(symbol)
    return pd.Series(dtype=float)


def aggregate(symbols: list[str], name: str, min_days: int = 3) -> dict:
    closes = {}
    failed = []
    for sym in symbols:
        s = load_close(sym)
        if len(s) >= min_days:
            closes[sym] = s
        else:
            failed.append(sym)
    if not closes:
        return {"name": name, "symbols": [], "bars": [], "failed": failed,
                "error": "无可用日线数据（成分股均无法获取）"}

    # 并集日期，逐股对齐（缺失前值填充），等权日收益率 → 净值（起点 100）
    idx = sorted(set().union(*[set(s.index) for s in closes.values()]))
    frame = pd.DataFrame({sym: s.reindex(idx).ffill() for sym, s in closes.items()})
    rets = frame.pct_change().fillna(0.0).mean(axis=1)
    nav = (1.0 + rets).cumprod() * 100.0
    prev = nav.shift(1)
    bars = []
    for d, v in nav.items():
        p = prev.get(d)
        o = float(p) if p is not None and pd.notna(p) else float(v)
        c = float(v)
        bars.append({"date": str(d)[:10], "open": round(o, 3),
                     "high": round(max(o, c), 3), "low": round(min(o, c), 3),
                     "close": round(c, 3)})
    return {"name": name, "symbols": list(closes.keys()), "bars": bars, "failed": failed}


if __name__ == "__main__":
    try:
        syms = [s.strip() for s in (sys.argv[1] or "").split(",") if s.strip()][:MAX_SYMBOLS]
        nm = sys.argv[2] if len(sys.argv) > 2 else "组合"
        print(json.dumps(aggregate(syms, nm), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"聚合失败: {e}"}, ensure_ascii=False))
        sys.exit(1)

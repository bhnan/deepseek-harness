"""个股日线 JSON 导出（host 路由 /api/trading/stock/{symbol}/daily.json 的后端）。

parquet → 最近 N 根 bar 的 JSON（浏览器读不了 parquet，由本脚本转换）。
用法：python scripts/export_daily_json.py sh600519 [N=120]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from pipeline.collect_stock import daily_path, normalize_symbol

SYMBOL_RE = r"^(sh|sz|bj)\d{6}$"


def export(symbol: str, n: int = 120) -> dict:
    import re
    if not re.match(SYMBOL_RE, symbol):
        raise ValueError(f"非法 symbol: {symbol}")
    p = daily_path(symbol, "hfq")
    if not p.exists():
        # A7 设计：on-demand 拉取 + 缓存（池外股票首次查询 ~2s，之后走缓存）
        from pipeline.collect_stock import fetch_daily
        fetch_daily(symbol, adjust="hfq")
        p = daily_path(symbol, "hfq")
    df = pd.read_parquet(p).tail(n)
    if df.empty or "date" not in df.columns:
        raise ValueError(f"{symbol} 无可用日线数据（代码不存在或数据源无数据）")
    bars = [{"date": str(r["date"])[:10], "open": r["open"], "high": r["high"],
             "low": r["low"], "close": r["close"], "volume": r.get("volume")}
            for _, r in df.iterrows()]
    return {"symbol": symbol, "bars": bars}


if __name__ == "__main__":
    try:
        print(json.dumps(export(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 120),
                         ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{sys.argv[1]} 查询失败: {e}"}, ensure_ascii=False))
        sys.exit(1)

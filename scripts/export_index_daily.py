"""指数日线导出（host 路由 /api/trading/index/{code}/daily.json 的后端）。
index_daily.parquet → 最近 N 根 bar。周/月粒度由前端聚合。
用法：python scripts/export_index_daily.py sh000001 [N=800]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

INDEX_DAILY = Path(__file__).resolve().parent.parent / "data" / "market" / "index_daily.parquet"
CODE_RE = r"^(sh|sz|bj)\d{6}$"


def export(code: str, n: int = 800) -> dict:
    import re
    if not re.match(CODE_RE, code):
        raise ValueError(f"非法指数代码: {code}")
    if not INDEX_DAILY.exists():
        raise FileNotFoundError("指数日线未采集（先跑 collect_index_daily）")
    df = pd.read_parquet(INDEX_DAILY)
    df = df[df["code"] == code].sort_values("date").tail(n)
    if df.empty:
        raise ValueError(f"{code} 无指数日线数据")
    bars = [{"date": str(r["date"])[:10], "open": r["open"], "high": r["high"],
             "low": r["low"], "close": r["close"], "volume": r.get("volume")}
            for _, r in df.iterrows()]
    return {"code": code, "bars": bars}


if __name__ == "__main__":
    try:
        print(json.dumps(export(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 800),
                         ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{sys.argv[1] if len(sys.argv) > 1 else '?'} 查询失败: {e}"},
                         ensure_ascii=False))
        sys.exit(1)

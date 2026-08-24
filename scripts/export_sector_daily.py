"""申万行业指数日线导出（host 路由 /api/trading/sector/{code}/daily.json 的后端）。
sw_daily.parquet → 最近 N 根 bar 的 JSON。周/月粒度由前端从日线聚合。
用法：python scripts/export_sector_daily.py 801080 [N=500]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

SW_DAILY = Path(__file__).resolve().parent.parent / "data" / "sector" / "sw_daily.parquet"
CODE_RE = r"^801\d{3}$"


def export(code: str, n: int = 500) -> dict:
    import re
    if not re.match(CODE_RE, code):
        raise ValueError(f"非法行业代码: {code}")
    if not SW_DAILY.exists():
        raise FileNotFoundError("行业日线未采集（先跑 collect_sw_daily）")
    df = pd.read_parquet(SW_DAILY)
    df = df[df["code"] == code].sort_values("日期").tail(n)
    if df.empty:
        raise ValueError(f"{code} 无行业日线数据")
    bars = [{"date": str(r["日期"])[:10], "open": r["开盘"], "high": r["最高"],
             "low": r["最低"], "close": r["收盘"], "volume": r.get("成交量")}
            for _, r in df.iterrows()]
    return {"code": code, "bars": bars}


if __name__ == "__main__":
    try:
        print(json.dumps(export(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 500),
                         ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": f"{sys.argv[1] if len(sys.argv) > 1 else '?'} 查询失败: {e}"},
                         ensure_ascii=False))
        sys.exit(1)

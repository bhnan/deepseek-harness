"""前向跟踪：种子（观察日收盘后扫候选）+ 评分（数据到期后产快照）。

用法：
  python scripts/seed_tracking.py [--date YYYY-MM-DD]   # 用 signal_001 DSL 扫 B1 池候选
  python scripts/grade_tracking.py                      # 对到期 pending 产出 t5/t20 快照
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from backtest.data import MarketData
from backtest.dsl import scan
from pipeline.collect_stock import daily_path, normalize_symbol
from pipeline.tracking import TRACKING_DIR, seed

EXPERIMENT_ID = "exp_001"


def load_b1_closes(asof: str) -> dict[str, pd.Series]:
    state = json.loads((Path(__file__).resolve().parent.parent / "data/stock/b1_state.json")
                       .read_text(encoding="utf-8"))
    out = {}
    for s in state["done"]:
        d = pd.read_parquet(daily_path(s, "hfq"))[["date", "close"]]
        d["date"] = pd.to_datetime(d["date"])
        series = d.set_index("date")["close"]
        series = series[series.index <= pd.Timestamp(asof)]
        out[s] = series
    return out


def main(asof: str) -> None:
    closes_by_symbol = load_b1_closes(asof)
    syms = list(closes_by_symbol.keys())[:50]
    frame = {}
    for s in syms:
        frame[s] = closes_by_symbol[s]
    closes = pd.DataFrame(frame)
    view = MarketData(closes).as_of(pd.Timestamp(asof))
    expr = {"metric": "rank", "args": {"window": 20}, "op": ">=", "value": 0.8}
    hits = scan(expr, view, syms)
    candidates = [{"symbol": s} for s in hits[:5]]
    path = seed(EXPERIMENT_ID, asof, candidates)
    print(f"种子落盘: {path} | 候选 {len(candidates)} 只: {[c['symbol'] for c in candidates]}")


if __name__ == "__main__":
    date = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--date" else pd.Timestamp.now().strftime("%Y-%m-%d")
    main(date)

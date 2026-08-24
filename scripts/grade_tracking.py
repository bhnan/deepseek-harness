"""前向跟踪评分：对到期 pending 种子产出 t5/t20 快照（contracts/tracking.json 校验）。
用法：python scripts/grade_tracking.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from pipeline.collect_stock import daily_path
from pipeline.tracking import TRACKING_DIR, grade


def main() -> int:
    state = json.loads((Path(__file__).resolve().parent.parent / "data/stock/b1_state.json")
                       .read_text(encoding="utf-8"))
    closes_by_symbol = {}
    for s in state["done"]:
        d = pd.read_parquet(daily_path(s, "hfq"))[["date", "close"]]
        d["date"] = pd.to_datetime(d["date"])
        closes_by_symbol[s] = d.set_index("date")["close"]
    bench = pd.read_parquet(Path(__file__).resolve().parent.parent / "data/market/index_daily.parquet")
    bench = bench[bench["code"] == "sh000905"].set_index("date")["close"]
    bench.index = pd.to_datetime(bench.index)

    produced = 0
    for exp_dir in TRACKING_DIR.iterdir() if TRACKING_DIR.exists() else []:
        for pending in exp_dir.glob("pending_*.json"):
            obs = pending.stem.replace("pending_", "")
            try:
                outs = grade(exp_dir.name, obs, closes_by_symbol, bench)
                produced += len(outs)
                for o in outs:
                    print("产出:", o)
            except Exception as e:
                print(f"[skip] {pending.name}: {e}")
    print(f"本次产出 {produced} 份 tracking 快照（未到期保持 pending）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

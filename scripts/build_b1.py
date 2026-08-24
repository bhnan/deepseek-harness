"""B1 建库入口：中证500 成分（+自选）全量 hfq 日线 + 复权因子。

用法：python scripts/build_b1.py [--limit N] [--rate 0.6]
断点续传：state 记录已完成标的，中断重跑不重复（pipeline/b1.py::build resume=True）。
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.b1 import build, load_state, update
from pipeline.collect_events import load_watchlist
from pipeline.collect_stock import normalize_symbol


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="只建前 N 只（测试用）")
    parser.add_argument("--rate", type=float, default=0.6, help="请求间隔秒数（新浪限速）")
    parser.add_argument("--update", action="store_true", help="增量模式：为已入库标的补当日行")
    args = parser.parse_args()

    if args.update:
        r = update("", rate=args.rate)
        print(f"B1 增量完成：更新 {r['updated']}，失败 {len(r['failed'])}", flush=True)
        return
    import akshare as ak
    df = ak.index_stock_cons_csindex(symbol="000905")
    codes = [normalize_symbol(str(c)) for c in df["成分券代码"].tolist()]
    watch = [normalize_symbol(s) for s in load_watchlist().get("symbols", [])]
    pool = sorted(set(codes + watch))
    if args.limit:
        pool = pool[: args.limit]
    print(f"B1 建库池：{len(pool)} 只（中证500 + 自选），限速 {args.rate}s/只", flush=True)
    r = build(pool, rate=args.rate)
    state = load_state()
    print(f"完成：本次新增 {len(r['built'])}，跳过 {len(r['skipped'])}，"
          f"累计 {len(state['done'])} 只", flush=True)


if __name__ == "__main__":
    main()

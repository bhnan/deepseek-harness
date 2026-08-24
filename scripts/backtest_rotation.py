"""板块轮动配对策略回测（Signal-Driven Rotation Pair Discovery，v002 DSL）。

- 数据：data/rotation_benchmark/sector_daily_bars.csv（2016-01-04 ~ 2026-07-10，31 板块）
- 信号：每日 as_of → 疲劳/修复 DSL → 配对 top3（打分 + 5 日冷却）→ 持仓 = 配对新端板块（等权）
- 执行：t 收盘信号 → t+1 开盘执行（板块无涨跌停/无 T+1 约束，费用 0——研究信号不产生真实交易）
- 基准：全部板块等权（buy & hold）
- 护栏：as_of 视图物理隔离 / t+1 两阶段 / 泄漏自检，三项盖章
用法：python scripts/backtest_rotation.py [--out DIR]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from backtest.data import MarketData
from backtest.dsl import evaluate, validate
from backtest.engine import BacktestEngine
from pipeline.collect_signals import DEFAULT_PAIRING, list_strategies

BARS = Path(__file__).resolve().parent.parent / "data" / "rotation_benchmark" / "sector_daily_bars.csv"


class RotationPairStrategy:
    """板块轮动配对策略函数（供引擎调用，冷却状态内部维护）。"""

    def __init__(self, defn: dict):
        self.defn = defn
        self.pairing = {**DEFAULT_PAIRING, **(defn.get("pairing") or {})}
        self.expression = defn.get("expression")
        self.repair_expression = defn.get("repair_expression")
        self.cooldown: dict[str, str] = {}   # pair_key -> emit_date
        self.universe: list[str] = []

    def __call__(self, view, day):
        universe = self.universe or [str(c) for c in view.sector_prices().columns]
        universe = [str(c) for c in universe]
        self.universe = universe
        validate(self.expression)
        validate(self.repair_expression)
        fatigue_hits = {s: evaluate(self.expression, view, s, universe) for s in universe}
        repair_hits = {s: evaluate(self.repair_expression, view, s, universe) for s in universe}

        from backtest.dsl import _sector_leaf_value
        def rank_of(code):
            return _sector_leaf_value({"metric": "sector_rank", "args": {"window": 20}},
                                      view, code)

        fatigue = [{"code": c, "score": float(rank_of(c))} for c, hit in fatigue_hits.items()
                   if hit and rank_of(c) == rank_of(c)]
        repair = [{"code": c, "score": 1.0 - float(rank_of(c))} for c, hit in repair_hits.items()
                  if hit and rank_of(c) == rank_of(c)]
        fatigue.sort(key=lambda x: x["score"], reverse=True)
        repair.sort(key=lambda x: x["score"], reverse=True)

        k = int(self.pairing["emit_top_k"])
        cd = int(self.pairing["cooldown_days"])
        f_min = float(self.pairing["fatigue_score_min"])
        r_min = float(self.pairing["repair_score_min"])
        day_s = str(day)[:10]
        pairs = []
        for f in fatigue:
            if f["score"] < f_min:
                continue
            for r in repair:
                if r["code"] == f["code"] or r["score"] < r_min:
                    continue
                key = f"{f['code']}|{r['code']}"
                emit = self.cooldown.get(key)
                if emit:
                    d1 = pd.Timestamp(day_s)
                    d2 = pd.Timestamp(str(emit)[:10])
                    if (d1 - d2).days < cd:
                        continue
                pairs.append({"old": f, "new": r, "key": key,
                              "pair_score": f["score"] * r["score"]})
        pairs.sort(key=lambda p: p["pair_score"], reverse=True)
        top = pairs[:k]
        for p in top:
            self.cooldown[p["key"]] = day_s
        # 清理过期冷却（保持字典精简）
        stale = [key for key, emit in self.cooldown.items()
                 if (pd.Timestamp(day_s) - pd.Timestamp(str(emit)[:10])).days >= cd]
        for key in stale:
            self.cooldown.pop(key, None)
        return [p["new"]["code"] for p in top]


def load_bars() -> pd.DataFrame:
    df = pd.read_csv(BARS)
    df["date"] = pd.to_datetime(df["date"])
    closes = df.pivot_table(index="date", columns="sector_id", values="close",
                            aggfunc="last").sort_index().ffill()
    opens = df.pivot_table(index="date", columns="sector_id", values="open",
                           aggfunc="last").sort_index().ffill()
    amounts = df.pivot_table(index="date", columns="sector_id", values="amount",
                             aggfunc="last").sort_index().ffill()
    # 统一代码为 str（与 DSL universe 一致，避免 int/str 列名不匹配导致指标 NaN）
    for frame in (closes, opens, amounts):
        frame.columns = frame.columns.astype(str)
    return closes, opens, amounts


def run() -> dict:
    defn = None
    for s in list_strategies():
        if s["has_dsl"]:
            defn = s["definition"]
            break
    if defn is None:
        raise SystemExit("无 DSL 策略定义（v002），无法回测")

    closes, opens, amounts = load_bars()
    data = MarketData(closes, opens, sector_closes=closes, sector_amounts=amounts)
    start, end = closes.index[0], closes.index[-1]
    exec_cfg = {"commission_open": 0.0, "commission_close": 0.0, "stamp_tax": 0.0,
                "min_commission": 0.0, "limit_up_down": False, "min_lot": 1,
                "t_plus_1": True, "suspend_skip": True}
    strategy = RotationPairStrategy(defn)
    result = BacktestEngine(data, exec_cfg).run(strategy, start, end)

    # 基准：全部板块等权（buy & hold）
    bench = (closes / closes.iloc[0]).mean(axis=1)
    bench = bench.reindex(result.equity.index).ffill()

    perf = {
        "strategy_final_nav": round(float(result.equity.iloc[-1]), 4),
        "benchmark_final_nav": round(float(bench.iloc[-1]), 4),
        "strategy_cagr": round(float((result.equity.iloc[-1] ** (252 / max(len(result.equity) - 1, 1)) - 1) * 100), 2),
        "benchmark_cagr": round(float((bench.iloc[-1] ** (252 / max(len(bench) - 1, 1)) - 1) * 100), 2),
        "max_drawdown_pct": round(float((result.equity / result.equity.cummax() - 1).min() * 100), 2),
        "trades": len(result.trades),
        "guardrails": result.guardrails,
        "start": str(start)[:10],
        "end": str(end)[:10],
    }
    # 持久化：lab/backtests/{strategy_id}/
    out_dir = (Path(__file__).resolve().parent.parent / "lab" / "backtests"
               / defn["strategy_id"])
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "overall_summary.json").write_text(
        json.dumps(perf, ensure_ascii=False, indent=1), encoding="utf-8")
    equity = pd.DataFrame({"strategy": result.equity, "benchmark": bench})
    equity.index.name = "date"
    equity.to_csv(out_dir / "equity_curve.csv")
    with open(out_dir / "trades.csv", "w", encoding="utf-8") as fh:
        fh.write("date,symbol,side,price,reason\n")
        for t in result.trades:
            fh.write(f"{t.date.date()},{t.symbol},{t.side},{t.price},{t.reason}\n")
    # 回填策略定义 validation/backtest_result
    if "validation_result" in defn:
        defn["validation_result"] = {"status": "passed",
                                     "reason": "DSL 回测完成，见 lab/backtests overall_summary.json"}
    if "backtest_result" in defn:
        defn["backtest_result"] = {"status": "completed", **perf}
    vdir = (Path(__file__).resolve().parent.parent / "lab" / "strategies"
            / defn["strategy_id"] / "versions" / "v002")
    (vdir / "strategy.json").write_text(
        json.dumps(defn, ensure_ascii=False, indent=1), encoding="utf-8")
    return perf


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", help="结果目录（默认 lab/backtests/{strategy_id}）")
    args = parser.parse_args()
    perf = run()
    print(json.dumps(perf, ensure_ascii=False, indent=2))

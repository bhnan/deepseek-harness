"""exp_001 扩池回测：20 日动量 top5 在 B1 全池（~499 只）相对中证500。

背景：concl_001 原实验为 50 只中小盘池（年化超额 -43.53%，样本小不作结论）。
本次扩池到 B1 全池 + 样本外分段，判断"强势普涨日后动量延续"是否成立。

口径（与原实验一致）：
- 策略：每交易日收盘，取 20 日收益率排名前 5 的股票等权持有（t+1 开盘执行）
- 执行：BacktestEngine（涨停/跌停/停牌/T+1 护栏、佣金 5bp/15bp、印花税 5bp）
- 基准：中证500（sh000905，index_daily.parquet）
- 区间：2025-08-18 ~ 2026-08-14（exp_001 period）
  样本内 2025-08-18~2026-06-30 / 样本外 2026-07-01~2026-08-14
- 超额 = CAGR(策略) - CAGR(基准)

用法：python scripts/backtest_exp001_momentum.py
输出：控制台报告 + lab/backtests/exp001-momentum/overall_summary.json + equity_curve.csv
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from backtest.data import MarketData
from backtest.engine import BacktestEngine

ROOT = Path(__file__).resolve().parent.parent
STOCK_DIR = ROOT / "data" / "stock" / "daily"
B1_STATE = ROOT / "data" / "stock" / "b1_state.json"
INDEX_DAILY = ROOT / "data" / "market" / "index_daily.parquet"
PERIOD = (pd.Timestamp("2025-08-18"), pd.Timestamp("2026-08-14"))
IN_SAMPLE_END = pd.Timestamp("2026-06-30")


def load_pool() -> list[str]:
    state = json.loads(B1_STATE.read_text(encoding="utf-8"))
    return [s for s in state.get("done", []) if s not in state.get("failed", [])]


def load_closes(symbols: list[str]) -> pd.DataFrame:
    frames = {}
    for sym in symbols:
        p = STOCK_DIR / sym / "hfq.parquet"
        if not p.exists():
            continue
        df = pd.read_parquet(p)
        if df.empty or "close" not in df.columns:
            continue
        s = df.set_index("date")["close"].astype(float)
        s.index = pd.to_datetime(s.index)
        frames[sym] = s
    closes = pd.DataFrame(frames).sort_index()
    return closes[closes.index >= PERIOD[0] - pd.Timedelta(days=45)]   # 预热动量窗口


def momentum_top5(view, day) -> list[str]:
    """20 日动量 top5（as_of 视图物理隔离；历史不足返回空）。"""
    closes = view.prices()
    if len(closes) < 21:
        return []
    ret20 = closes.iloc[-1] / closes.iloc[-21] - 1.0
    ret20 = ret20.dropna()
    if len(ret20) < 5:
        return []
    return [str(s) for s in ret20.nlargest(5).index]


def load_benchmark() -> pd.Series:
    df = pd.read_parquet(INDEX_DAILY)
    z = df[df["code"] == "sh000905"].set_index("date")["close"].astype(float)
    z.index = pd.to_datetime(z.index)
    return z.sort_index()


def cagr(equity: pd.Series) -> float:
    n = max(len(equity) - 1, 1)
    return (float(equity.iloc[-1]) ** (252 / n) - 1.0) * 100


def segment_report(equity: pd.Series, bench: pd.Series, start, end) -> dict:
    eq = equity[(equity.index >= start) & (equity.index <= end)]
    bm = bench[(bench.index >= start) & (bench.index <= end)]
    if len(eq) < 2 or len(bm) < 2:
        return {"days": 0, "strategy_cagr": None, "benchmark_cagr": None, "excess_cagr": None}
    # 对齐起点归一化
    eq_n = eq / eq.iloc[0]
    bm_n = bm / bm.iloc[0]
    return {
        "days": len(eq),
        "strategy_cagr": round(cagr(eq_n), 2),
        "benchmark_cagr": round(cagr(bm_n), 2),
        "excess_cagr": round(cagr(eq_n) - cagr(bm_n), 2),
    }


def run() -> dict:
    pool = load_pool()
    closes = load_closes(pool)
    print(f"B1 池 {len(pool)} 只，可用日线 {closes.shape[1]} 只，{closes.index[0].date()} ~ {closes.index[-1].date()}")

    data = MarketData(closes)
    engine = BacktestEngine(data)
    result = engine.run(momentum_top5, PERIOD[0], PERIOD[1])
    bench = load_benchmark()

    total = segment_report(result.equity, bench, PERIOD[0], PERIOD[1])
    ins = segment_report(result.equity, bench, PERIOD[0], IN_SAMPLE_END)
    oos = segment_report(result.equity, bench, IN_SAMPLE_END + pd.Timedelta(days=1), PERIOD[1])

    report = {
        "pool": f"B1 全池 {closes.shape[1]} 只（原实验 50 只中小盘）",
        "period": [str(PERIOD[0])[:10], str(PERIOD[1])[:10]],
        "trades": len(result.trades),
        "guardrails": result.guardrails,
        "total": total,
        "in_sample": ins,
        "out_of_sample": oos,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))

    out_dir = ROOT / "lab" / "backtests" / "exp001-momentum"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "overall_summary.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    eq = pd.DataFrame({"strategy": result.equity, "benchmark": bench.reindex(result.equity.index).ffill()})
    eq.index.name = "date"
    eq.to_csv(out_dir / "equity_curve.csv")
    with open(out_dir / "trades.csv", "w", encoding="utf-8") as fh:
        fh.write("date,symbol,side,price,reason\n")
        for t in result.trades:
            fh.write(f"{t.date.date()},{t.symbol},{t.side},{t.price},{t.reason}\n")
    return report


if __name__ == "__main__":
    run()

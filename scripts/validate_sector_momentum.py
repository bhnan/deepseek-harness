"""idea_003 板块动量轮动信号验证（Sector Momentum Signal Validation）。

命题：月末按过去 M 交易日收益对申万一级行业排名，次月持动量前 N（等权）。
若动量最强板块未来一个月跑赢"时点可得板块等权篮子"，则板块动量延续成立。

- 数据：data/sector/sw_daily.parquet（2014-01-02 ~ 2026-08-18，31 板块；环保/石油石化/美容护理 2021-12 起才有）
- 口径：point-in-time 板块（月末有数据的板块才可入池）；月末收盘定序 → 次月首日收盘建仓 → 次月末收盘平仓（无前视）
- 参数矩阵：窗口 1M/3M/6M（21/63/126 交易日）× Top{3,5} × 过滤{无过滤 / 只持动量>0（全负则空仓）}
- 多空诊断：Top3 多 − 最弱 3 空（学术动量价差，不可交易，仅回答"正/负动量延续性差异"）
- 基准：时点可得板块等权买入持有（2014-02 ~ 2026-08）
- 护栏：样本内 2014-02~2020-12 / 样本外 2021-01~2026-08；全矩阵全报（不挑最优）；月度超额 t 统计
用法：python scripts/validate_sector_momentum.py [--out DIR]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SW_DAILY = ROOT / "data" / "sector" / "sw_daily.parquet"
SW_INFO = ROOT / "data" / "sector" / "sw_l1_info.json"
DEFAULT_OUT = ROOT / "lab" / "backtests" / "sector_momentum_validation"
START = "2014-01-01"
IS_END = "2020-12-31"

WINDOWS = {"1M": 21, "3M": 63, "6M": 126}
TOPN = [3, 5]
FILTERS = ["none", "pos"]
RISK_FREE = 0.0


def load_data():
    df = pd.read_parquet(SW_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    df = df[df["日期"] >= START].sort_values("日期")
    close = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    amount = df.pivot_table(index="日期", columns="code", values="成交额", aggfunc="last").sort_index()
    info = json.loads(SW_INFO.read_text(encoding="utf-8"))["industries"]
    names = {str(r["行业代码"]).split(".")[0]: r["行业名称"] for r in info}
    return close, amount, names


def monthly_periods(close: pd.DataFrame) -> list[dict]:
    """连续月份的 (信号日, 建仓日, 平仓日)。信号日=月末收盘；建仓日=次月首日；平仓日=次月末日。"""
    idx = close.index
    per = idx.to_period("M")
    firsts = pd.Series(idx, index=idx).groupby(per).first()
    lasts = pd.Series(idx, index=idx).groupby(per).last()
    periods = sorted(lasts.index)
    out = []
    for i, p in enumerate(periods[:-1]):
        signal_date = lasts.loc[p]
        hold_start = firsts.loc[periods[i + 1]]
        hold_end = lasts.loc[periods[i + 1]]
        out.append({"period": str(p), "signal_date": signal_date, "hold_start": hold_start,
                    "hold_end": hold_end})
    return out


def momentum_at(close: pd.DataFrame, signal_date: pd.Timestamp, window: int) -> pd.Series:
    """信号日收盘 / (信号日-window 交易日)收盘 - 1；历史不足的板块为 NaN（不入池）。"""
    pos = close.index.get_loc(signal_date)
    if pos < window:
        return pd.Series(np.nan, index=close.columns)
    cur = close.iloc[pos]
    prev = close.iloc[pos - window]
    mom = cur / prev - 1.0
    mom[(cur.isna()) | (prev.isna()) | (prev <= 0)] = np.nan
    return mom


def period_return(close: pd.DataFrame, held: list[str], hold_start, hold_end) -> float:
    if not held:
        return 0.0  # 空仓（现金）
    start_px = close.loc[hold_start, held]
    end_px = close.loc[hold_end, held]
    r = (end_px / start_px - 1.0).dropna()
    if len(r) == 0:
        return 0.0
    return float(r.mean())


def benchmark_series(close: pd.DataFrame, periods: list[dict]) -> pd.Series:
    rets = []
    for p in periods:
        held = [c for c in close.columns
                if pd.notna(close.loc[p["hold_start"], c]) and pd.notna(close.loc[p["hold_end"], c])]
        rets.append((p["period"], period_return(close, held, p["hold_start"], p["hold_end"])))
    s = pd.Series(dict(rets)).sort_index()
    s.index = pd.PeriodIndex(s.index, freq="M")
    return s


def run_variant(close, periods, window: int, top_n: int, pos_only: bool) -> pd.Series:
    rets = {}
    for p in periods:
        mom = momentum_at(close, p["signal_date"], window)
        mom = mom.dropna().sort_values(ascending=False)
        if len(mom) == 0:
            rets[p["period"]] = 0.0
            continue
        held = mom.index[:top_n].tolist()
        if pos_only:
            held = [c for c in held if mom[c] > 0]
        rets[p["period"]] = period_return(close, held, p["hold_start"], p["hold_end"])
    s = pd.Series(rets).sort_index()
    s.index = pd.PeriodIndex(s.index, freq="M")
    return s


def long_short_series(close, periods, window: int) -> pd.Series:
    rets = {}
    for p in periods:
        mom = momentum_at(close, p["signal_date"], window).dropna().sort_values(ascending=False)
        if len(mom) < 6:
            rets[p["period"]] = np.nan
            continue
        long = mom.index[:3].tolist()
        short = mom.index[-3:].tolist()
        rl = period_return(close, long, p["hold_start"], p["hold_end"])
        rs = period_return(close, short, p["hold_start"], p["hold_end"])
        rets[p["period"]] = rl - rs
    s = pd.Series(rets).dropna().sort_index()
    s.index = pd.PeriodIndex(s.index, freq="M")
    return s


def perf_metrics(ret: pd.Series) -> dict:
    if len(ret) < 2:
        return {"n_months": int(len(ret))}
    nav = (1 + ret).cumprod()
    n = len(ret)
    cagr = nav.iloc[-1] ** (12 / n) - 1
    vol = ret.std() * np.sqrt(12)
    sharpe = (ret.mean() * 12 - RISK_FREE) / vol if vol > 0 else np.nan
    downside = ret[ret < 0].std() * np.sqrt(12) if (ret < 0).any() else np.nan
    sortino = (ret.mean() * 12) / downside if downside and downside > 0 else np.nan
    dd = (nav / nav.cummax() - 1).min()
    return {
        "n_months": int(n),
        "total_return": float(nav.iloc[-1] - 1),
        "annual_return": float(cagr),
        "annual_vol": float(vol),
        "sharpe": float(sharpe),
        "sortino": float(sortino),
        "max_drawdown": float(dd),
        "positive_month_rate": float((ret > 0).mean()),
        "mean_monthly": float(ret.mean()),
        "t_stat_mean": float(ret.mean() / ret.std() * np.sqrt(n)) if ret.std() > 0 else np.nan,
    }


def excess_stats(ret: pd.Series, bench: pd.Series) -> dict:
    both = pd.concat([ret, bench], axis=1, keys=["ret", "bench"]).dropna()
    if len(both) < 2:
        return {"n_overlap": 0}
    ex = both["ret"] - both["bench"]
    n = len(ex)
    return {
        "n_overlap": int(n),
        "mean_monthly_excess": float(ex.mean()),
        "annualized_excess": float(ex.mean() * 12),
        "t_stat_excess": float(ex.mean() / ex.std() * np.sqrt(n)) if ex.std() > 0 else np.nan,
        "win_rate_vs_bench": float((ex > 0).mean()),
    }


def yearly_table(ret: pd.Series, bench: pd.Series) -> dict:
    df = pd.concat([ret, bench], axis=1, keys=["strategy", "bench"]).dropna()
    out = {}
    for year, g in df.groupby(df.index.year):
        out[str(year)] = {"strategy": round(float((1 + g["strategy"]).prod() - 1), 4),
                          "bench": round(float((1 + g["bench"]).prod() - 1), 4)}
    return out


def split_metrics(ret, bench, period_index=None):
    """样本内（≤2020-12）/ 样本外（≥2021-01）各自相对基准的表现。"""
    is_mask = ret.index <= pd.Period(IS_END, freq="M")
    oos_mask = ~is_mask
    out = {}
    for label, m in [("in_sample", is_mask), ("out_of_sample", oos_mask)]:
        r = ret[m]
        b = bench[m]
        if len(r) < 2:
            out[label] = {"n_months": int(len(r))}
            continue
        out[label] = {
            **excess_stats(r, b),
            "annual_return": perf_metrics(r)["annual_return"],
            "bench_annual_return": perf_metrics(b)["annual_return"],
            "sharpe": perf_metrics(r)["sharpe"],
        }
    return out


def main(out_dir: Path) -> dict:
    close, amount, names = load_data()
    periods = monthly_periods(close)
    bench = benchmark_series(close, periods)
    bench_m = perf_metrics(bench)
    print(f"[data] {close.shape[1]} 板块, {len(periods)} 个月度周期, 基准 {len(bench)} 月")

    variants = {}
    for wname, w in WINDOWS.items():
        for n in TOPN:
            for fname in FILTERS:
                key = f"{wname}_top{n}_{fname}"
                ret = run_variant(close, periods, w, n, fname == "pos")
                m = perf_metrics(ret)
                ex = excess_stats(ret, bench)
                sp = split_metrics(ret, bench)
                variants[key] = {"window": wname, "top_n": n, "filter": fname,
                                 "metrics": m, "excess": ex, "split": sp,
                                 "yearly": yearly_table(ret, bench)}
                print(f"  {key:16s} 年化={m['annual_return']*100:6.2f}%  Sharpe={m['sharpe']:5.2f}  "
                      f"超额年化={ex['annualized_excess']*100:6.2f}%  t={ex['t_stat_excess']:5.2f}  "
                      f"OOS超额年化={sp['out_of_sample']['annualized_excess']*100:6.2f}%")

    ls = {}
    for wname, w in WINDOWS.items():
        s = long_short_series(close, periods, w)
        ls[wname] = {"metrics": perf_metrics(s), "yearly": yearly_table(s, pd.Series(dtype=float)) if len(s) else {}}
        m = ls[wname]["metrics"]
        print(f"  [LS] {wname} 多空价差 年化={m.get('annual_return',0)*100:6.2f}%  Sharpe={m.get('sharpe'):5.2f}  "
              f"t={m.get('t_stat_mean'):5.2f}  n={m.get('n_months')}")

    # ---- 补充诊断：文献口径长窗口（12M 及 12M-1M 跳月） ----
    supp = {}
    for wname, w, skip in [("12M", 252, 0), ("12M-1M", 252, 21)]:
        for n in [3, 5]:
            for fname in FILTERS:
                key = f"{wname}_top{n}_{fname}"
                rets = {}
                for p in periods:
                    pos = close.index.get_loc(p["signal_date"])
                    if pos - skip - w < 0:
                        rets[p["period"]] = 0.0
                        continue
                    # 动量 = close[T-skip] / close[T-skip-w] - 1（12M-1M 跳过最近 21 日）
                    end_px = close.iloc[pos - skip]
                    start_px = close.iloc[pos - skip - w]
                    mom = end_px / start_px - 1.0
                    mom[(end_px.isna()) | (start_px.isna()) | (start_px <= 0)] = np.nan
                    mom = mom.dropna().sort_values(ascending=False)
                    if len(mom) == 0:
                        rets[p["period"]] = 0.0
                        continue
                    held = mom.index[:n].tolist()
                    if fname == "pos":
                        held = [c for c in held if mom[c] > 0]
                    rets[p["period"]] = period_return(close, held, p["hold_start"], p["hold_end"])
                s = pd.Series(rets).sort_index()
                s.index = pd.PeriodIndex(s.index, freq="M")
                m = perf_metrics(s)
                ex = excess_stats(s, bench)
                sp = split_metrics(s, bench)
                supp[key] = {"window": wname, "top_n": n, "filter": fname,
                             "metrics": m, "excess": ex, "split": sp}
                print(f"  [SUPP] {key:16s} 年化={m['annual_return']*100:6.2f}%  Sharpe={m['sharpe']:5.2f}  "
                      f"超额年化={ex['annualized_excess']*100:6.2f}%  t={ex['t_stat_excess']:5.2f}  "
                      f"OOS超额年化={sp['out_of_sample']['annualized_excess']*100:6.2f}%")

    result = {
        "idea_id": "idea_003",
        "signal": "sector_momentum_monthly",
        "data": {"source": "data/sector/sw_daily.parquet", "start": str(close.index[0].date()),
                 "end": str(close.index[-1].date()), "sectors": int(close.shape[1]),
                 "note": "环保/石油石化/美容护理 2021-12 起纳入（point-in-time 口径）"},
        "method": {"signal": "月末收盘定序 → 次月首日收盘建仓 → 次月末收盘平仓",
                   "universe": "point-in-time 时点可得板块", "cost": 0.0,
                   "benchmark": "时点可得板块等权买入持有",
                   "guardrails": ["t+1 两阶段无前视", "IS≤2020-12 / OOS≥2021-01", "全矩阵全报"]},
        "benchmark": {"metrics": bench_m, "periods": int(len(bench))},
        "variants": variants,
        "long_short": ls,
        "supplementary_12m": supp,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=1,
                                                     allow_nan=True), encoding="utf-8")

    # 人类可读 CSV：全部变体的关键指标
    rows = []
    for k, v in variants.items():
        rows.append({
            "variant": k, "window": v["window"], "top_n": v["top_n"], "filter": v["filter"],
            "n_months": v["metrics"].get("n_months"),
            "annual_return_pct": round(v["metrics"].get("annual_return", np.nan) * 100, 2),
            "sharpe": round(v["metrics"].get("sharpe", np.nan), 2),
            "max_drawdown_pct": round(v["metrics"].get("max_drawdown", np.nan) * 100, 2),
            "excess_annual_pct": round(v["excess"].get("annualized_excess", np.nan) * 100, 2),
            "excess_t": round(v["excess"].get("t_stat_excess", np.nan), 2),
            "oos_excess_annual_pct": round(v["split"]["out_of_sample"].get("annualized_excess", np.nan) * 100, 2),
            "oos_excess_t": round(v["split"]["out_of_sample"].get("t_stat_excess", np.nan), 2),
            "win_rate_vs_bench": round(v["excess"].get("win_rate_vs_bench", np.nan), 3),
        })
    pd.DataFrame(rows).to_csv(out_dir / "variants.csv", index=False)

    # 基准年化（对照用）
    print(f"\n[bench] 等权31板块 年化={bench_m['annual_return']*100:.2f}% Sharpe={bench_m['sharpe']:.2f} "
          f"最大回撤={bench_m['max_drawdown']*100:.1f}%")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    res = main(args.out)
    print("\n输出:", args.out / "summary.json")

#!/usr/bin/env python3
"""Build non-overlapping cumulative returns for pure within-sector selections.

The input contains forward 20/60-day returns for sector-date Top-5 tests.
This script chooses non-overlapping signal windows before compounding them,
so overlapping forward labels are never added or compounded as if independent.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

import backtest_type_factor_proxy_v1 as price_source
import compare_single_vs_multifactor as factors
import validate_intra_sector_top5 as selection


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_METRICS = ROOT / "lab/backtests/single_vs_multifactor_v1/factor_sector_date_metrics.csv"
DEFAULT_SCORE_PANEL = ROOT / "lab/backtests/stock_beta_score_v1/stock_beta_score_panel.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/selection_cumulative_returns_v1"


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def nonoverlap_schedule(
    signal_dates: pd.DatetimeIndex,
    trading_calendar: pd.DatetimeIndex,
    *,
    horizon_days: int,
) -> pd.DataFrame:
    """Greedily choose signals whose 20/60-day holding windows do not overlap."""

    signals = pd.DatetimeIndex(pd.to_datetime(signal_dates).dropna().unique()).sort_values()
    calendar = pd.DatetimeIndex(pd.to_datetime(trading_calendar).dropna().unique()).sort_values()
    rows: list[dict[str, pd.Timestamp]] = []
    previous_exit: pd.Timestamp | None = None
    for signal in signals:
        if previous_exit is not None and signal <= previous_exit:
            continue
        position = int(calendar.searchsorted(signal, side="left"))
        if position >= len(calendar) or position + horizon_days >= len(calendar):
            continue
        exit_date = calendar[position + horizon_days]
        rows.append({"signal_date": signal, "exit_date": exit_date})
        previous_exit = exit_date
    return pd.DataFrame(rows)


def _series_summary(period_returns: pd.DataFrame, series_col: str) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for series, group in period_returns.groupby(series_col, sort=True):
        group = group.sort_values("signal_date")
        nav = (1.0 + group["period_return"]).cumprod()
        elapsed_days = max(1, int((group["exit_date"].max() - group["signal_date"].min()).days))
        rows.append(
            {
                "series": series,
                "start": group["signal_date"].min().date().isoformat(),
                "end": group["exit_date"].max().date().isoformat(),
                "nonoverlap_periods": int(len(group)),
                "mean_active_sectors": float(group["active_sectors"].mean()),
                "total_return": float(nav.iloc[-1] - 1.0),
                "annualized_return": float(nav.iloc[-1] ** (365.25 / elapsed_days) - 1.0),
            }
        )
    return pd.DataFrame(rows)


def aggregate_cumulative_returns(metrics: pd.DataFrame, schedule: pd.DataFrame) -> pd.DataFrame:
    """Compound sector-equal period returns for all factor and sector-average series."""

    data = metrics.copy()
    data["date"] = pd.to_datetime(data["date"], errors="coerce").dt.normalize()
    schedule = schedule.copy()
    schedule["signal_date"] = pd.to_datetime(schedule["signal_date"], errors="coerce").dt.normalize()
    selected = data.merge(schedule, left_on="date", right_on="signal_date", how="inner", validate="many_to_one")
    factor_periods = (
        selected.groupby(["factor", "signal_date", "exit_date"], as_index=False)
        .agg(period_return=("top_return", "mean"), active_sectors=("sector_code", "nunique"))
        .rename(columns={"factor": "series"})
    )
    benchmark = selected.drop_duplicates(["sector_code", "signal_date"]).groupby(
        ["signal_date", "exit_date"], as_index=False
    ).agg(period_return=("universe_return", "mean"), active_sectors=("sector_code", "nunique"))
    benchmark.insert(0, "series", "sector_average")
    all_periods = pd.concat([benchmark, factor_periods], ignore_index=True)
    return _series_summary(all_periods, "series")


def sector_cumulative_returns(metrics: pd.DataFrame, schedule: pd.DataFrame) -> pd.DataFrame:
    """Return per-sector cumulative results for sector baseline and every factor."""

    data = metrics.copy()
    data["date"] = pd.to_datetime(data["date"], errors="coerce").dt.normalize()
    schedule = schedule.copy()
    schedule["signal_date"] = pd.to_datetime(schedule["signal_date"], errors="coerce").dt.normalize()
    selected = data.merge(schedule, left_on="date", right_on="signal_date", how="inner", validate="many_to_one")
    factor_rows = selected.rename(columns={"factor": "series", "top_return": "period_return"})[
        ["sector_code", "sector_name", "pool_type", "series", "signal_date", "exit_date", "period_return"]
    ]
    benchmark = selected.drop_duplicates(["sector_code", "signal_date"]).copy()
    benchmark["series"] = "sector_average"
    benchmark["period_return"] = benchmark["universe_return"]
    benchmark = benchmark[
        ["sector_code", "sector_name", "pool_type", "series", "signal_date", "exit_date", "period_return"]
    ]
    rows = pd.concat([benchmark, factor_rows], ignore_index=True)
    output: list[dict[str, object]] = []
    for keys, group in rows.groupby(["sector_code", "sector_name", "pool_type", "series"], sort=True):
        group = group.sort_values("signal_date")
        nav = (1.0 + group["period_return"]).cumprod()
        output.append(
            {
                "sector_code": keys[0],
                "sector_name": keys[1],
                "pool_type": keys[2],
                "series": keys[3],
                "nonoverlap_periods": int(len(group)),
                "total_return": float(nav.iloc[-1] - 1.0),
            }
        )
    return pd.DataFrame(output)


def build_report(summary_20d: pd.DataFrame, summary_60d: pd.DataFrame) -> str:
    return f"""# 行业内选股累计收益 v1

## 口径

- 每个序列均为行业等权汇总：每个信号期先计算各行业的 Top 5 或行业全体平均收益，再对可用行业等权。
- `sector_average` 是同一行业内全部合格股票的平均收益，不是宽基指数。
- 20 日与 60 日分别使用不重叠信号窗口后连乘，避免将重叠未来收益重复计入总收益。
- 这仍是纯选股收益汇总，不是跨行业实际组合回测；未计交易成本、行业配置和实际成交约束。

## 20 日非重叠累计

{price_source.md_table(summary_20d, ['series', 'start', 'end', 'nonoverlap_periods', 'mean_active_sectors', 'total_return', 'annualized_return'])}

## 60 日非重叠累计

{price_source.md_table(summary_60d, ['series', 'start', 'end', 'nonoverlap_periods', 'mean_active_sectors', 'total_return', 'annualized_return'])}

行业级累计见 `sector_cumulative_20d.csv` 和 `sector_cumulative_60d.csv`。
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metrics", default=str(DEFAULT_METRICS))
    parser.add_argument("--score-panel", default=str(DEFAULT_SCORE_PANEL))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--min-avg-amount", type=float, default=factors.DEFAULT_MIN_AVG_AMOUNT)
    args = parser.parse_args()

    metrics = pd.read_csv(output_path(args.metrics), dtype={"stock_code": str}, low_memory=False)
    raw_scores = pd.read_csv(output_path(args.score_panel), dtype={"stock_code": str}, low_memory=False)
    eligible = selection.eligible_panel(raw_scores, min_avg_amount=args.min_avg_amount)
    common = factors.common_factor_universe(eligible)
    close, _ = price_source.read_stock_cache(
        set(common["stock_code"]),
        start=pd.Timestamp(metrics["date"].min()),
        end=pd.Timestamp("2026-07-17"),
    )
    if close.empty:
        raise ValueError("No local price calendar available")

    output_dir = output_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    summaries: dict[str, pd.DataFrame] = {}
    for horizon, days in [("20d", 20), ("60d", 60)]:
        horizon_metrics = metrics[metrics["horizon"].eq(horizon)].copy()
        dates = pd.DatetimeIndex(pd.to_datetime(horizon_metrics["date"], errors="coerce").dropna().unique())
        schedule = nonoverlap_schedule(dates, close.index, horizon_days=days)
        summary = aggregate_cumulative_returns(horizon_metrics, schedule)
        sector_summary = sector_cumulative_returns(horizon_metrics, schedule)
        schedule.to_csv(output_dir / f"nonoverlap_schedule_{horizon}.csv", index=False)
        summary.to_csv(output_dir / f"cumulative_summary_{horizon}.csv", index=False)
        sector_summary.to_csv(output_dir / f"sector_cumulative_{horizon}.csv", index=False)
        summaries[horizon] = summary
    (output_dir / "cumulative_selection_report.md").write_text(
        build_report(summaries["20d"], summaries["60d"]), encoding="utf-8"
    )
    print("20d cumulative")
    print(summaries["20d"].to_string(index=False))
    print("\n60d cumulative")
    print(summaries["60d"].to_string(index=False))
    print(f"artifacts={output_dir}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Validate pure stock selection: Top-N versus peers inside each sector only.

This deliberately has no industry selection, portfolio construction, turnover,
or transaction-cost simulation. At each historical decision date it asks one
question: did the five highest-scoring stocks outperform other stocks in the
same sector over the following horizon?
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

import backtest_type_factor_proxy_v1 as reporting


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_PANEL = ROOT / "lab/backtests/stock_beta_score_v1/stock_beta_score_panel.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/intra_sector_top5_selection_v1"
DEFAULT_TOP_N = 5
DEFAULT_MIN_AVG_AMOUNT = 20_000_000.0


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def true_mask(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.lower().isin({"true", "1", "1.0"})


def evaluate_sector_date(
    sector_snapshot: pd.DataFrame,
    *,
    horizon: str,
    top_n: int,
) -> tuple[dict[str, object] | None, pd.DataFrame]:
    """Score one sector/date with non-overlapping Top-N and Bottom-N groups."""

    label = f"future_return_{horizon}"
    required = {"stock_beta_score", label}
    if required.difference(sector_snapshot.columns):
        return None, pd.DataFrame()
    valid = sector_snapshot.copy()
    if "stock_code" not in valid:
        return None, pd.DataFrame()
    valid["stock_beta_score"] = pd.to_numeric(valid["stock_beta_score"], errors="coerce")
    valid[label] = pd.to_numeric(valid[label], errors="coerce")
    valid = valid.dropna(subset=["stock_beta_score", label]).sort_values(
        ["stock_beta_score", "stock_code"], kind="mergesort"
    )
    if len(valid) < top_n * 2:
        return None, pd.DataFrame()

    top = valid.tail(top_n).copy()
    bottom = valid.head(top_n).copy()
    top["selection_bucket"] = "top"
    bottom["selection_bucket"] = "bottom"
    selections = pd.concat([top, bottom], ignore_index=True)
    selections["rank_in_sector"] = selections["stock_beta_score"].rank(method="first", ascending=False)
    selections["horizon"] = horizon
    rank_ic = np.nan
    if valid["stock_beta_score"].nunique() >= 2 and valid[label].nunique() >= 2:
        rank_ic = float(valid["stock_beta_score"].rank().corr(valid[label].rank()))
    first = valid.iloc[0]
    top_return = float(top[label].mean())
    bottom_return = float(bottom[label].mean())
    universe_return = float(valid[label].mean())
    metrics = {
        "date": pd.Timestamp(first["date"]),
        "sector_code": str(first["sector_code"]),
        "sector_name": str(first.get("sector_name", "")),
        "pool_type": str(first.get("pool_type", "")),
        "horizon": horizon,
        "sample_size": int(len(valid)),
        "top_n": int(top_n),
        "rank_ic": rank_ic,
        "top_return": top_return,
        "universe_return": universe_return,
        "bottom_return": bottom_return,
        "top_excess_vs_universe": top_return - universe_return,
        "top_minus_bottom": top_return - bottom_return,
        "top_win_vs_universe": bool(top_return > universe_return),
        "top_win_vs_bottom": bool(top_return > bottom_return),
    }
    return metrics, selections


def eligible_panel(panel: pd.DataFrame, min_avg_amount: float) -> pd.DataFrame:
    """Apply only stock-level data/score/liquidity availability filters."""

    result = panel.copy()
    result["date"] = pd.to_datetime(result["date"], errors="coerce").dt.normalize()
    result["stock_beta_score"] = pd.to_numeric(result["stock_beta_score"], errors="coerce")
    result["avg_amount_20d_hist"] = pd.to_numeric(result["avg_amount_20d_hist"], errors="coerce")
    result["score_valid"] = true_mask(result["score_valid"])
    result = result[
        result["score_valid"]
        & result["stock_beta_score"].notna()
        & result["avg_amount_20d_hist"].ge(min_avg_amount)
    ].copy()
    return result.drop_duplicates(["date", "sector_code", "stock_code"], keep="last")


def evaluate_panel(panel: pd.DataFrame, *, horizon: str, top_n: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    metric_rows: list[dict[str, object]] = []
    selection_frames: list[pd.DataFrame] = []
    for _, sector_snapshot in panel.groupby(["date", "sector_code"], sort=True):
        metrics, selections = evaluate_sector_date(sector_snapshot, horizon=horizon, top_n=top_n)
        if metrics is not None:
            metric_rows.append(metrics)
            selection_frames.append(selections)
    return pd.DataFrame(metric_rows), pd.concat(selection_frames, ignore_index=True) if selection_frames else pd.DataFrame()


def summarize(metrics: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    aggregations = {
        "sector_date_observations": ("rank_ic", "count"),
        "mean_rank_ic": ("rank_ic", "mean"),
        "median_rank_ic": ("rank_ic", "median"),
        "positive_ic_rate": ("rank_ic", lambda values: float((values > 0).mean())),
        "mean_top_return": ("top_return", "mean"),
        "mean_universe_return": ("universe_return", "mean"),
        "mean_bottom_return": ("bottom_return", "mean"),
        "mean_top_excess_vs_universe": ("top_excess_vs_universe", "mean"),
        "mean_top_minus_bottom": ("top_minus_bottom", "mean"),
        "top_win_vs_universe_rate": ("top_win_vs_universe", "mean"),
        "top_win_vs_bottom_rate": ("top_win_vs_bottom", "mean"),
    }
    overall = metrics.groupby("horizon", as_index=False).agg(**aggregations) if not metrics.empty else pd.DataFrame()
    sector = (
        metrics.groupby(["horizon", "sector_code", "sector_name", "pool_type"], as_index=False)
        .agg(**aggregations)
        .sort_values(["horizon", "mean_top_excess_vs_universe"], ascending=[True, False])
        if not metrics.empty
        else pd.DataFrame()
    )
    pool_type = (
        metrics.groupby(["horizon", "pool_type"], as_index=False).agg(**aggregations)
        if not metrics.empty
        else pd.DataFrame()
    )
    return overall, sector, pool_type


def build_report(overall: pd.DataFrame, by_sector: pd.DataFrame, by_type: pd.DataFrame, top_n: int) -> str:
    return f"""# 行业内 Top {top_n} 个股选择验证 v1

## 验证对象

这不是行业轮动或持仓回测。每个历史调仓日、每个行业独立执行：

1. 只用该日已知的 `stock_beta_score` 排序该行业内股票。
2. 选择最高分 Top {top_n}，并与同一行业的全部合格股票和最低分 Bottom {top_n} 比较未来 20/60 日收益。
3. 不选 Top 3 行业、不跨行业配权、不计交易成本、不因个股数量改变行业是否存在。

## 全行业等权汇总

{reporting.md_table(overall, ['horizon', 'sector_date_observations', 'mean_rank_ic', 'median_rank_ic', 'positive_ic_rate', 'mean_top_return', 'mean_universe_return', 'mean_bottom_return', 'mean_top_excess_vs_universe', 'mean_top_minus_bottom', 'top_win_vs_universe_rate', 'top_win_vs_bottom_rate'])}

## 按类型汇总

{reporting.md_table(by_type, ['horizon', 'pool_type', 'sector_date_observations', 'mean_rank_ic', 'mean_top_excess_vs_universe', 'mean_top_minus_bottom', 'top_win_vs_universe_rate'])}

## 按行业明细

完整行业清单见 `sector_summary.csv`；每期入选的 Top {top_n}/Bottom {top_n} 股票、分数和随后收益见 `sector_date_top_bottom_selections.csv`。
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-panel", default=str(DEFAULT_INPUT_PANEL))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--top-n", type=int, default=DEFAULT_TOP_N)
    parser.add_argument("--min-avg-amount", type=float, default=DEFAULT_MIN_AVG_AMOUNT)
    args = parser.parse_args()

    panel = pd.read_csv(output_path(args.input_panel), dtype={"stock_code": str}, low_memory=False)
    panel = eligible_panel(panel, min_avg_amount=args.min_avg_amount)
    metric_frames: list[pd.DataFrame] = []
    selection_frames: list[pd.DataFrame] = []
    for horizon in ["20d", "60d"]:
        metrics, selections = evaluate_panel(panel, horizon=horizon, top_n=args.top_n)
        metric_frames.append(metrics)
        selection_frames.append(selections)
    metrics = pd.concat(metric_frames, ignore_index=True)
    selections = pd.concat(selection_frames, ignore_index=True)
    overall, by_sector, by_type = summarize(metrics)
    output_dir = output_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics.to_csv(output_dir / "sector_date_top5_metrics.csv", index=False)
    selections.to_csv(output_dir / "sector_date_top_bottom_selections.csv", index=False)
    overall.to_csv(output_dir / "overall_summary.csv", index=False)
    by_sector.to_csv(output_dir / "sector_summary.csv", index=False)
    by_type.to_csv(output_dir / "pool_type_summary.csv", index=False)
    (output_dir / "selection_validation_report.md").write_text(
        build_report(overall, by_sector, by_type, args.top_n), encoding="utf-8"
    )
    print("Overall")
    print(overall.to_string(index=False))
    print("\nBy type")
    print(by_type.to_string(index=False))
    print(f"artifacts={output_dir}")


if __name__ == "__main__":
    main()

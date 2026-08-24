#!/usr/bin/env python3
"""Validate stock Beta score only after the industry stage has selected sectors."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

import backtest_two_stage_stock_beta as two_stage
from build_stock_beta_score_panel import STOCK_COMPONENTS


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_PANEL = ROOT / "lab/backtests/stock_beta_score_v1/stock_beta_score_panel.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/two_stage_stock_beta_validation_v1"
DEFAULT_MIN_AVG_AMOUNT = 20_000_000.0
DEFAULT_TOP_K = 3
DEFAULT_MIN_STOCKS_PER_SECTOR = 5
DEFAULT_TOP_SCORE = 60.0


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def industry_conditioned_observations(
    panel: pd.DataFrame,
    *,
    top_k: int,
    min_stocks_per_sector: int,
    min_avg_amount: float = DEFAULT_MIN_AVG_AMOUNT,
) -> pd.DataFrame:
    """Return stocks in sectors selected with only the industry stage signal."""

    frames: list[pd.DataFrame] = []
    for date, snapshot in panel.groupby("date", sort=True):
        eligible = two_stage.eligible_snapshot(snapshot, min_avg_amount=min_avg_amount)
        sectors = two_stage.select_sectors(eligible, top_k=top_k, min_stocks_per_sector=min_stocks_per_sector)
        selected = eligible[eligible["sector_code"].isin(set(sectors["sector_code"]))].copy()
        selected["industry_selected"] = True
        selected["signal_date"] = pd.Timestamp(date).date().isoformat()
        frames.append(selected)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def score_metrics(
    observations: pd.DataFrame,
    *,
    horizon: str,
    score_columns: list[str],
    min_stocks_per_sector: int,
    top_score: float = DEFAULT_TOP_SCORE,
) -> pd.DataFrame:
    """Compute same-sector IC and high-score spreads for each decision period."""

    label = f"future_return_{horizon}"
    rows: list[dict[str, object]] = []
    for (date, sector_code), group in observations.groupby(["date", "sector_code"], sort=True):
        for score_column in score_columns:
            if score_column not in group or label not in group:
                continue
            valid = group[[score_column, label]].apply(pd.to_numeric, errors="coerce").dropna()
            if len(valid) < min_stocks_per_sector or valid[score_column].nunique() < 2 or valid[label].nunique() < 2:
                continue
            high = valid[valid[score_column].ge(top_score)][label]
            low = valid[valid[score_column].lt(100.0 - top_score)][label]
            rows.append(
                {
                    "date": pd.Timestamp(date),
                    "sector_code": sector_code,
                    "sector_name": str(group["sector_name"].iloc[0]),
                    "pool_type": str(group["pool_type"].iloc[0]),
                    "horizon": horizon,
                    "score_column": score_column,
                    "sample_size": int(len(valid)),
                    "rank_ic": float(valid[score_column].rank().corr(valid[label].rank())),
                    "high_score_return": float(high.mean()) if not high.empty else np.nan,
                    "sector_universe_return": float(valid[label].mean()),
                    "high_minus_universe": float(high.mean() - valid[label].mean()) if not high.empty else np.nan,
                    "low_score_return": float(low.mean()) if not low.empty else np.nan,
                    "high_minus_low": float(high.mean() - low.mean()) if not high.empty and not low.empty else np.nan,
                    "high_count": int(len(high)),
                    "low_count": int(len(low)),
                }
            )
    return pd.DataFrame(rows)


def summarize(metrics: pd.DataFrame) -> pd.DataFrame:
    if metrics.empty:
        return pd.DataFrame()
    summary = (
        metrics.groupby(["horizon", "score_column"], as_index=False)
        .agg(
            sector_date_observations=("rank_ic", "count"),
            mean_rank_ic=("rank_ic", "mean"),
            median_rank_ic=("rank_ic", "median"),
            positive_ic_rate=("rank_ic", lambda values: float((values > 0).mean())),
            mean_high_minus_universe=("high_minus_universe", "mean"),
            mean_high_minus_low=("high_minus_low", "mean"),
            mean_high_count=("high_count", "mean"),
        )
        .sort_values(["horizon", "score_column"])
        .reset_index(drop=True)
    )
    return summary


def report(summary: pd.DataFrame, top_k: int, top_score: float) -> str:
    return f"""# 两阶段股票 Beta 分验证 v1

## 验证口径

- 每个调仓日，先仅按行业趋势选择 Top {top_k} 行业。
- 只在这些行业内部计算个股分数与未来收益的秩相关，不允许强行业中的股票与弱行业中的股票进行横截面比较。
- 高分组定义为 `score >= {top_score:.0f}`；低分组定义为 `score < {100.0 - top_score:.0f}`。
- `rank_ic`、高分相对行业平均收益、高低分收益差都按“行业-调仓日”先计算，再等权汇总。

## 汇总

{two_stage.engine.md_table(summary, ['horizon', 'score_column', 'sector_date_observations', 'mean_rank_ic', 'median_rank_ic', 'positive_ic_rate', 'mean_high_minus_universe', 'mean_high_minus_low', 'mean_high_count'])}

## 判读

- `stock_beta_score` 的 20/60 日 IC 和高分相对行业平均收益应同时为正，才可认为个股总分具有基础预测力。
- 单一组件为负或不稳定，不能用“总分看起来合理”掩盖；应保留为诊断项或从权重矩阵移除。
- 本报告是毛收益信号验证；是否能交易还必须与正式回测中 C 相对 B 的成本后增量一起判断。
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-panel", default=str(DEFAULT_INPUT_PANEL))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument("--min-stocks-per-sector", type=int, default=DEFAULT_MIN_STOCKS_PER_SECTOR)
    parser.add_argument("--min-avg-amount", type=float, default=DEFAULT_MIN_AVG_AMOUNT)
    parser.add_argument("--top-score", type=float, default=DEFAULT_TOP_SCORE)
    args = parser.parse_args()

    panel = pd.read_csv(output_path(args.input_panel), dtype={"stock_code": str}, low_memory=False)
    panel["date"] = pd.to_datetime(panel["date"], errors="coerce").dt.normalize()
    observations = industry_conditioned_observations(
        panel,
        top_k=args.top_k,
        min_stocks_per_sector=args.min_stocks_per_sector,
        min_avg_amount=args.min_avg_amount,
    )
    score_columns = ["stock_beta_score", *STOCK_COMPONENTS]
    metric_frames = [
        score_metrics(
            observations,
            horizon=horizon,
            score_columns=score_columns,
            min_stocks_per_sector=args.min_stocks_per_sector,
            top_score=args.top_score,
        )
        for horizon in ["20d", "60d"]
    ]
    metrics = pd.concat(metric_frames, ignore_index=True)
    summary = summarize(metrics)
    output_dir = output_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    observations.to_csv(output_dir / "industry_conditioned_observations.csv", index=False)
    metrics.to_csv(output_dir / "sector_date_component_metrics.csv", index=False)
    summary.to_csv(output_dir / "component_validation_summary.csv", index=False)
    (output_dir / "validation_report.md").write_text(report(summary, args.top_k, args.top_score), encoding="utf-8")
    print(summary.to_string(index=False))
    print(f"artifacts={output_dir}")


if __name__ == "__main__":
    main()

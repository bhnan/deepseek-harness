#!/usr/bin/env python3
"""Compare single factors and the multifactor score on the same Top-5 universe.

All tests are pure within-sector stock-selection tests. They do not select
industries, allocate capital across sectors, or deduct portfolio costs.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

import backtest_type_factor_proxy_v1 as reporting
import validate_intra_sector_top5 as selection


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_PANEL = ROOT / "lab/backtests/stock_beta_score_v1/stock_beta_score_panel.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/single_vs_multifactor_v1"
DEFAULT_TOP_N = 5
DEFAULT_MIN_AVG_AMOUNT = 20_000_000.0
TRAIN_END = pd.Timestamp("2022-12-31")

SINGLE_FACTORS = [
    "momentum_score",
    "type_beta_score",
    "earnings_growth_score",
    "growth_quality_score",
    "valuation_position_score",
    "capital_liquidity_score",
    "drawdown_constraint_score",
]
SCORE_COLUMNS = ["stock_beta_score", *SINGLE_FACTORS]
FACTOR_LABELS = {
    "stock_beta_score": "多因子总分",
    "momentum_score": "动量",
    "type_beta_score": "类型 Beta",
    "earnings_growth_score": "盈利增长",
    "growth_quality_score": "增长质量",
    "valuation_position_score": "估值位置",
    "capital_liquidity_score": "资金/流动性",
    "drawdown_constraint_score": "回撤约束",
}


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def common_factor_universe(panel: pd.DataFrame) -> pd.DataFrame:
    """Keep only rows where every compared score is observable."""

    required = [column for column in SCORE_COLUMNS if column in panel]
    if set(SCORE_COLUMNS).difference(required):
        missing = sorted(set(SCORE_COLUMNS).difference(required))
        raise ValueError(f"input panel missing score columns: {missing}")
    result = panel.copy()
    for column in SCORE_COLUMNS:
        result[column] = pd.to_numeric(result[column], errors="coerce")
    return result.dropna(subset=SCORE_COLUMNS).copy()


def period_label(dates: pd.Series) -> pd.Series:
    normalized = pd.to_datetime(dates, errors="coerce")
    return pd.Series(np.where(normalized.le(TRAIN_END), "2018-2022", "2023-2026"), index=dates.index)


def evaluate_factor(panel: pd.DataFrame, factor: str, horizon: str, top_n: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Run Top-N sector-selection validation after substituting one score."""

    evaluated = panel.copy()
    evaluated["stock_beta_score"] = evaluated[factor]
    metrics, selections = selection.evaluate_panel(evaluated, horizon=horizon, top_n=top_n)
    if not metrics.empty:
        metrics["factor"] = factor
        metrics["factor_label"] = FACTOR_LABELS[factor]
        metrics["period"] = period_label(metrics["date"])
    if not selections.empty:
        selections["factor"] = factor
        selections["factor_label"] = FACTOR_LABELS[factor]
        selections["period"] = period_label(selections["date"])
    return metrics, selections


def top_n_overlap(panel: pd.DataFrame, factor: str, *, top_n: int) -> pd.DataFrame:
    """Measure how much a single factor chooses the same Top-N as multifactor."""

    rows: list[dict[str, object]] = []
    for (date, sector_code), group in panel.groupby(["date", "sector_code"], sort=True):
        valid = group.dropna(subset=["stock_beta_score", factor]).copy()
        if len(valid) < top_n:
            continue
        multi = set(valid.nlargest(top_n, "stock_beta_score")["stock_code"])
        single = set(valid.nlargest(top_n, factor)["stock_code"])
        intersection = len(multi.intersection(single))
        union = len(multi.union(single))
        rows.append(
            {
                "date": pd.Timestamp(date),
                "sector_code": str(sector_code),
                "sector_name": str(group.get("sector_name", pd.Series([""])).iloc[0]),
                "pool_type": str(group.get("pool_type", pd.Series([""])).iloc[0]),
                "factor": factor,
                "factor_label": FACTOR_LABELS[factor],
                "intersection_count": intersection,
                "jaccard_overlap": intersection / union if union else np.nan,
                "period": "2018-2022" if pd.Timestamp(date) <= TRAIN_END else "2023-2026",
            }
        )
    return pd.DataFrame(rows)


def summarize_metrics(metrics: pd.DataFrame) -> pd.DataFrame:
    aggregations = {
        "sector_date_observations": ("rank_ic", "count"),
        "mean_rank_ic": ("rank_ic", "mean"),
        "positive_ic_rate": ("rank_ic", lambda values: float((values > 0).mean())),
        "mean_top_return": ("top_return", "mean"),
        "mean_universe_return": ("universe_return", "mean"),
        "mean_top_excess_vs_universe": ("top_excess_vs_universe", "mean"),
        "mean_top_minus_bottom": ("top_minus_bottom", "mean"),
        "top_win_vs_universe_rate": ("top_win_vs_universe", "mean"),
        "top_win_vs_bottom_rate": ("top_win_vs_bottom", "mean"),
    }
    return (
        metrics.groupby(["horizon", "period", "factor", "factor_label"], as_index=False)
        .agg(**aggregations)
        .sort_values(["horizon", "period", "mean_top_excess_vs_universe"], ascending=[True, True, False])
        .reset_index(drop=True)
    )


def multifactor_advantage(metrics: pd.DataFrame) -> pd.DataFrame:
    key = ["date", "sector_code", "horizon", "period"]
    selected = metrics[key + ["factor", "top_excess_vs_universe", "top_minus_bottom"]].copy()
    multi = selected[selected["factor"].eq("stock_beta_score")].drop(columns="factor").rename(
        columns={
            "top_excess_vs_universe": "multifactor_top_excess",
            "top_minus_bottom": "multifactor_top_minus_bottom",
        }
    )
    single = selected[~selected["factor"].eq("stock_beta_score")]
    comparison = single.merge(multi, on=key, how="inner", validate="many_to_one")
    comparison["multifactor_minus_single_excess"] = (
        comparison["multifactor_top_excess"] - comparison["top_excess_vs_universe"]
    )
    comparison["multifactor_better"] = comparison["multifactor_minus_single_excess"].gt(0)
    return (
        comparison.groupby(["horizon", "period", "factor"], as_index=False)
        .agg(
            sector_date_observations=("multifactor_minus_single_excess", "count"),
            mean_multifactor_minus_single_excess=("multifactor_minus_single_excess", "mean"),
            multifactor_better_rate=("multifactor_better", "mean"),
        )
        .assign(factor_label=lambda frame: frame["factor"].map(FACTOR_LABELS))
        .sort_values(["horizon", "mean_multifactor_minus_single_excess"], ascending=[True, False])
        .reset_index(drop=True)
    )


def summarize_overlap(overlap: pd.DataFrame) -> pd.DataFrame:
    return (
        overlap.groupby(["period", "factor", "factor_label"], as_index=False)
        .agg(
            sector_date_observations=("jaccard_overlap", "count"),
            mean_jaccard_overlap=("jaccard_overlap", "mean"),
            mean_shared_top5_stocks=("intersection_count", "mean"),
        )
        .sort_values(["period", "mean_jaccard_overlap"], ascending=[True, False])
        .reset_index(drop=True)
    )


def build_report(
    summary: pd.DataFrame,
    advantage: pd.DataFrame,
    overlap: pd.DataFrame,
    common_coverage: float,
    top_n: int,
) -> str:
    test_summary = summary[summary["period"].eq("2023-2026")]
    return f"""# 单因子与多因子行业内 Top {top_n} 对比 v1

## 公平比较口径

- 样本只保留全部七个单因子和多因子总分都有观测值的股票，覆盖原流动性合格样本的 {common_coverage:.1%}。
- 每个行业、每个调仓日独立选择 Top {top_n}；不选择行业、不配置组合、不扣交易成本。
- 单因子与多因子使用完全相同的股票横截面，差异仅来自排名变量。
- `2018-2022` 为前段观察期，`2023-2026` 为后段独立稳定性检查。该切分是回顾性比较，不应被表述为严格未经研究的样本外开发。

## 后段（2023-2026）结果

{reporting.md_table(test_summary, ['horizon', 'factor_label', 'sector_date_observations', 'mean_rank_ic', 'positive_ic_rate', 'mean_top_excess_vs_universe', 'mean_top_minus_bottom', 'top_win_vs_universe_rate'])}

## 多因子相对单因子

正值代表多因子 Top {top_n} 相对行业平均收益高于该单因子 Top {top_n}；负值代表单因子更好。

{reporting.md_table(advantage, ['horizon', 'period', 'factor_label', 'sector_date_observations', 'mean_multifactor_minus_single_excess', 'multifactor_better_rate'])}

## 选股重合度

`mean_shared_top5_stocks` 是多因子与单因子每期、每行业共同选中的平均股票数。重合度过高说明多因子主要在重复某个单因子；重合度过低则说明多因子改变了选股，但不等于改善了预测。

{reporting.md_table(overlap, ['period', 'factor_label', 'sector_date_observations', 'mean_jaccard_overlap', 'mean_shared_top5_stocks'])}

完整明细见 CSV 文件，包括每个行业日期的 Top {top_n} 收益、每个因子的入选股票和全部比较差。
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-panel", default=str(DEFAULT_INPUT_PANEL))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--top-n", type=int, default=DEFAULT_TOP_N)
    parser.add_argument("--min-avg-amount", type=float, default=DEFAULT_MIN_AVG_AMOUNT)
    args = parser.parse_args()

    raw = pd.read_csv(output_path(args.input_panel), dtype={"stock_code": str}, low_memory=False)
    eligible = selection.eligible_panel(raw, min_avg_amount=args.min_avg_amount)
    common = common_factor_universe(eligible)
    common_coverage = len(common) / len(eligible) if len(eligible) else 0.0

    metric_frames: list[pd.DataFrame] = []
    selection_frames: list[pd.DataFrame] = []
    for horizon in ["20d", "60d"]:
        for factor in SCORE_COLUMNS:
            metrics, picks = evaluate_factor(common, factor=factor, horizon=horizon, top_n=args.top_n)
            metric_frames.append(metrics)
            selection_frames.append(picks)
    metrics = pd.concat(metric_frames, ignore_index=True)
    picks = pd.concat(selection_frames, ignore_index=True)
    summary = summarize_metrics(metrics)
    advantage = multifactor_advantage(metrics)
    overlap_frames = [top_n_overlap(common, factor, top_n=args.top_n) for factor in SINGLE_FACTORS]
    overlap = pd.concat(overlap_frames, ignore_index=True)
    overlap_summary = summarize_overlap(overlap)

    output_dir = output_path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics.to_csv(output_dir / "factor_sector_date_metrics.csv", index=False)
    picks.to_csv(output_dir / "factor_top_bottom_selections.csv", index=False)
    summary.to_csv(output_dir / "factor_summary.csv", index=False)
    advantage.to_csv(output_dir / "multifactor_vs_single_advantage.csv", index=False)
    overlap.to_csv(output_dir / "top5_overlap_detail.csv", index=False)
    overlap_summary.to_csv(output_dir / "top5_overlap_summary.csv", index=False)
    (output_dir / "single_vs_multifactor_report.md").write_text(
        build_report(summary, advantage, overlap_summary, common_coverage, args.top_n), encoding="utf-8"
    )

    print("Common factor coverage:", f"{common_coverage:.2%}")
    print("Factor summary")
    print(summary.to_string(index=False))
    print("\nMultifactor versus single-factor advantage")
    print(advantage.to_string(index=False))
    print(f"artifacts={output_dir}")


if __name__ == "__main__":
    main()

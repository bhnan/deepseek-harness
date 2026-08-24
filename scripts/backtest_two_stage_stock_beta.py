#!/usr/bin/env python3
"""Walk-forward test for sector selection plus sector-neutral stock Beta score.

Sleeves share the same monthly decisions, T+1 close execution, local price
cache, and transaction-cost model. Their only difference is the decision
layer retained:

* ``broad_eligible``: all eligible stocks in the routed 19-sector universe.
* ``sector_only``: top-K sectors by industry trend, all eligible stocks inside.
* ``two_stage_stock_beta``: same top-K sectors, then stock Beta score >= cut.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

import backtest_type_factor_proxy_v1 as engine


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_PANEL = ROOT / "lab/backtests/stock_beta_score_v1/stock_beta_score_panel.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/two_stage_stock_beta_v1"
DEFAULT_START = "2018-01-01"
DEFAULT_END = "2026-07-17"
DEFAULT_MIN_AVG_AMOUNT = 20_000_000.0
DEFAULT_TOP_K = 3
DEFAULT_STOCK_SCORE_THRESHOLD = 60.0
DEFAULT_MIN_STOCKS_PER_SECTOR = 5
DEFAULT_COST_BPS = 20.0


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def zcode(value: object) -> str:
    return str(value).split(".")[0].zfill(6)


def true_mask(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.lower().isin({"true", "1", "1.0"})


def eligible_snapshot(snapshot: pd.DataFrame, min_avg_amount: float) -> pd.DataFrame:
    """Keep only liquid, unique stock rows with an observable industry score."""

    data = snapshot.copy()
    data["stock_code"] = data["stock_code"].map(zcode)
    for column in ["avg_amount_20d_hist", "industry_trend_score_hist", "stock_beta_score"]:
        data[column] = pd.to_numeric(data[column], errors="coerce")
    data["score_valid"] = true_mask(data["score_valid"])
    data = data.dropna(subset=["sector_code", "industry_trend_score_hist", "avg_amount_20d_hist"])
    data = data[data["avg_amount_20d_hist"].ge(min_avg_amount)].copy()
    return data.sort_values(["stock_code", "stock_beta_score"], kind="mergesort").drop_duplicates("stock_code", keep="last")


def select_sectors(snapshot: pd.DataFrame, top_k: int, min_stocks_per_sector: int) -> pd.DataFrame:
    """Select sectors solely by the shared industry trend signal."""

    summary = (
        snapshot.groupby(["sector_code", "sector_name"], as_index=False)
        .agg(
            industry_trend_score=("industry_trend_score_hist", "mean"),
            eligible_stock_count=("stock_code", "nunique"),
        )
        .query("eligible_stock_count >= @min_stocks_per_sector")
        .sort_values(["industry_trend_score", "sector_code"], ascending=[False, True], kind="mergesort")
        .head(top_k)
        .reset_index(drop=True)
    )
    summary["sector_rank"] = np.arange(1, len(summary) + 1)
    return summary


def apply_sector_equal_weights(selected: pd.DataFrame) -> pd.DataFrame:
    """Give every retained sector equal capital, then equal capital per stock."""

    result = selected.copy()
    sector_counts = result.groupby("sector_code")["stock_code"].transform("count")
    sector_count = result["sector_code"].nunique()
    result["target_weight"] = 1.0 / sector_count / sector_counts
    return result


def select_stocks_for_sleeve(
    snapshot: pd.DataFrame,
    *,
    sleeve: str,
    top_k: int,
    stock_score_threshold: float,
    min_stocks_per_sector: int,
    min_avg_amount: float = DEFAULT_MIN_AVG_AMOUNT,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Materialize one sleeve's stocks and a stock-level decision audit."""

    eligible = eligible_snapshot(snapshot, min_avg_amount=min_avg_amount)
    sectors = select_sectors(eligible, top_k=top_k, min_stocks_per_sector=min_stocks_per_sector)
    selected_sector_codes = set(sectors["sector_code"])
    audit = eligible.merge(
        sectors[["sector_code", "sector_rank", "industry_trend_score"]], on="sector_code", how="left"
    )
    audit["sector_selected"] = audit["sector_code"].isin(selected_sector_codes)

    if sleeve == "broad_eligible":
        chosen = eligible.copy()
        chosen["target_weight"] = 1.0 / len(chosen) if len(chosen) else np.nan
        audit["stock_selected"] = audit["stock_code"].isin(set(chosen["stock_code"]))
        return chosen, audit

    in_sector = eligible[eligible["sector_code"].isin(selected_sector_codes)].copy()
    if sleeve == "sector_only":
        chosen = in_sector
    elif sleeve == "two_stage_stock_beta":
        chosen = in_sector[
            in_sector["score_valid"] & in_sector["stock_beta_score"].ge(stock_score_threshold)
        ].copy()
    else:
        raise ValueError(f"unknown sleeve: {sleeve}")

    # A sector that has no qualifying stock is not silently replaced by a stock
    # from another sector. Remaining sectors are re-normalized equally.
    chosen = chosen.groupby("sector_code", group_keys=False).filter(
        lambda group: len(group) >= min_stocks_per_sector
    )
    chosen = apply_sector_equal_weights(chosen) if not chosen.empty else chosen
    audit["stock_selected"] = audit["stock_code"].isin(set(chosen["stock_code"]))
    return chosen, audit


def build_signal_targets(
    panel: pd.DataFrame,
    close: pd.DataFrame,
    *,
    sleeve: str,
    top_k: int,
    stock_score_threshold: float,
    min_stocks_per_sector: int,
    min_avg_amount: float,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Create executable next-close targets and complete selection audit rows."""

    targets: dict[pd.Timestamp, pd.Series] = {}
    audit_frames: list[pd.DataFrame] = []
    all_codes = close.columns.map(zcode).tolist()
    for signal_date, snapshot in panel.groupby("date", sort=True):
        signal_date = pd.Timestamp(signal_date)
        mapped = engine.price_dates_for_signal(close.index, signal_date)
        if mapped is None:
            continue
        observed_date, effective_date = mapped
        tradable = set(
            close.columns[
                close.loc[observed_date].notna()
                & close.loc[effective_date].notna()
                & close.loc[observed_date].gt(0)
                & close.loc[effective_date].gt(0)
            ].map(zcode)
        )
        tradable_snapshot = snapshot[snapshot["stock_code"].map(zcode).isin(tradable)].copy()
        chosen, audit = select_stocks_for_sleeve(
            tradable_snapshot,
            sleeve=sleeve,
            top_k=top_k,
            stock_score_threshold=stock_score_threshold,
            min_stocks_per_sector=min_stocks_per_sector,
            min_avg_amount=min_avg_amount,
        )
        audit["sleeve"] = sleeve
        audit["signal_date"] = signal_date.date().isoformat()
        audit["observed_price_date"] = observed_date.date().isoformat()
        audit["effective_date"] = effective_date.date().isoformat()
        audit_frames.append(audit)
        target = pd.Series(0.0, index=all_codes, dtype=float)
        if not chosen.empty:
            target.loc[chosen["stock_code"].map(zcode).tolist()] = chosen["target_weight"].to_numpy()
        targets[signal_date] = target

    target_frame = pd.DataFrame.from_dict(targets, orient="index").reindex(columns=all_codes).sort_index()
    target_frame.index = pd.to_datetime(target_frame.index)
    audits = pd.concat(audit_frames, ignore_index=True) if audit_frames else pd.DataFrame()
    return target_frame, audits


def yearly_returns(returns: pd.Series) -> pd.DataFrame:
    grouped = (1.0 + returns).groupby(returns.index.year).prod() - 1.0
    return pd.DataFrame({"year": grouped.index.astype(int), "return": grouped.to_numpy()})


def write_outputs(
    output_dir: Path,
    runs: dict[str, engine.PortfolioRun],
    selection_audits: list[pd.DataFrame],
    cache_log: pd.DataFrame,
    config: dict[str, object],
) -> pd.DataFrame:
    output_dir.mkdir(parents=True, exist_ok=True)
    metric_rows: list[dict[str, object]] = []
    yearly_frames: list[pd.DataFrame] = []
    for sleeve, run in runs.items():
        pd.concat([run.returns, run.nav], axis=1).to_csv(output_dir / f"{sleeve}_nav.csv", index_label="date")
        run.trades.to_csv(output_dir / f"{sleeve}_trades.csv", index=False)
        run.effective_targets.to_csv(output_dir / f"{sleeve}_effective_targets.csv", index=True)
        metric_rows.append({"sleeve": sleeve, **engine.performance_metrics(run)})
        yearly = yearly_returns(run.returns)
        yearly.insert(0, "sleeve", sleeve)
        yearly_frames.append(yearly)
    metrics = pd.DataFrame(metric_rows).sort_values("sleeve").reset_index(drop=True)
    metrics.to_csv(output_dir / "metrics.csv", index=False)
    pd.concat(yearly_frames, ignore_index=True).to_csv(output_dir / "yearly_returns.csv", index=False)
    pd.concat(selection_audits, ignore_index=True).to_csv(output_dir / "selection_audit.csv", index=False)
    cache_log.to_csv(output_dir / "price_cache_log.csv", index=False)

    comparisons = pd.DataFrame(
        [
            {"comparison": "sector_only_vs_broad", **engine.comparison_metrics(runs["sector_only"], runs["broad_eligible"])},
            {
                "comparison": "two_stage_vs_sector_only",
                **engine.comparison_metrics(runs["two_stage_stock_beta"], runs["sector_only"]),
            },
            {
                "comparison": "two_stage_vs_broad",
                **engine.comparison_metrics(runs["two_stage_stock_beta"], runs["broad_eligible"]),
            },
        ]
    )
    comparisons.to_csv(output_dir / "incremental_comparisons.csv", index=False)
    summary = {
        "strategy_name": "two_stage_stock_beta_v1",
        "config": config,
        "sleeves": {
            "broad_eligible": "All liquid stocks in the 19-sector routed universe, equal weight.",
            "sector_only": "Top-K sectors by industry trend, equal sector then stock weight.",
            "two_stage_stock_beta": "Same sectors, only stocks with valid stock Beta score >= threshold, equal sector then stock weight.",
        },
        "execution": "Signal at T close, execution at next available T+1 close, position PnL starts after execution; one-way turnover cost applied.",
        "limitations": [
            "Current candidate universe is applied historically, so survivorship and historical index-membership bias remain.",
            "Raw historical financial and valuation provider responses can contain retrospective revisions despite NOTICE_DATE and observation-date gating.",
            "Suspension, ST, limit-price and auction/VWAP execution constraints are not fully modelled.",
        ],
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    report = f"""# 两阶段行业-个股 Beta 回测 v1

## 回测合同

- 样本：{config['start']} 至 {config['end']} 的月度调仓信号。
- A `broad_eligible`：19 个已路由行业内所有流动性合格股票等权。
- B `sector_only`：先按行业趋势选 Top {config['top_k']} 行业，再行业等权、行业内股票等权。
- C `two_stage_stock_beta`：同样选行业，行业内仅保留 `stock_beta_score >= {config['stock_score_threshold']:.0f}` 且 `score_valid` 的股票，再行业等权、行业内等权。
- 流动性门槛：20 日平均成交额至少 RMB {config['min_avg_amount'] / 1_000_000:.0f} million；一个行业至少 {config['min_stocks_per_sector']} 只可选股票。
- 执行：T 日收盘观测，T+1 可得收盘价成交；单边成本 {config['cost_bps']:.1f} bp，按实际换手计。

## 三组结果

{engine.md_table(metrics, ['sleeve', 'start', 'end', 'trading_days', 'total_return', 'annual_return', 'annual_vol', 'sharpe_zero_rf', 'max_drawdown', 'rebalance_count', 'avg_holding_count', 'avg_one_way_turnover', 'sum_trade_cost_fraction'])}

## 分层增量

{engine.md_table(comparisons, ['comparison', 'relative_total_return', 'relative_annual_return'])}

## 如何判读

- B 相对 A 的增量检验行业趋势选行业是否有价值。
- C 相对 B 的增量检验板块内个股 Beta 分是否有增量选股价值；这才是本次个股总分的核心检验。
- 详细行业、股票、分数、权重、调仓日、成交日都在 `selection_audit.csv`；每日净值、实际换手与成本在各 sleeve 对应 CSV 中。
- 结果即使为正，也仍有当前股票池回溯造成的幸存者偏差，不能直接视为可实盘收益承诺。
"""
    (output_dir / "backtest_report.md").write_text(report, encoding="utf-8")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-panel", default=str(DEFAULT_INPUT_PANEL))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    parser.add_argument("--min-avg-amount", type=float, default=DEFAULT_MIN_AVG_AMOUNT)
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument("--stock-score-threshold", type=float, default=DEFAULT_STOCK_SCORE_THRESHOLD)
    parser.add_argument("--min-stocks-per-sector", type=int, default=DEFAULT_MIN_STOCKS_PER_SECTOR)
    parser.add_argument("--cost-bps", type=float, default=DEFAULT_COST_BPS)
    args = parser.parse_args()

    panel = pd.read_csv(output_path(args.input_panel), dtype={"stock_code": str}, low_memory=False)
    panel["stock_code"] = panel["stock_code"].map(zcode)
    panel["date"] = pd.to_datetime(panel["date"], errors="coerce").dt.normalize()
    panel = panel[(panel["date"] >= pd.Timestamp(args.start)) & (panel["date"] <= pd.Timestamp(args.end))].copy()
    close, cache_log = engine.read_stock_cache(
        set(panel["stock_code"]), start=pd.Timestamp(args.start), end=pd.Timestamp(args.end)
    )
    if close.empty:
        raise ValueError("No local price cache is available for the score panel.")

    runs: dict[str, engine.PortfolioRun] = {}
    audit_frames: list[pd.DataFrame] = []
    for sleeve in ["broad_eligible", "sector_only", "two_stage_stock_beta"]:
        targets, audits = build_signal_targets(
            panel,
            close,
            sleeve=sleeve,
            top_k=args.top_k,
            stock_score_threshold=args.stock_score_threshold,
            min_stocks_per_sector=args.min_stocks_per_sector,
            min_avg_amount=args.min_avg_amount,
        )
        if targets.empty:
            raise ValueError(f"{sleeve} produced no executable targets")
        runs[sleeve] = engine.simulate_close_to_close_portfolio(close, targets, cost_bps=args.cost_bps)
        audit_frames.append(audits)

    config = {
        "input_panel": str(output_path(args.input_panel)),
        "start": args.start,
        "end": args.end,
        "min_avg_amount": args.min_avg_amount,
        "top_k": args.top_k,
        "stock_score_threshold": args.stock_score_threshold,
        "min_stocks_per_sector": args.min_stocks_per_sector,
        "cost_bps": args.cost_bps,
    }
    metrics = write_outputs(output_path(args.output_dir), runs, audit_frames, cache_log, config)
    print(metrics.to_string(index=False))
    print(f"artifacts={output_path(args.output_dir)}")


if __name__ == "__main__":
    main()

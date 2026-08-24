#!/usr/bin/env python3
"""Validate the recent daily price-reconstructable type-factor proxy.

The live V1 score includes current valuation, earnings, and industry-space
fields. Those fields do not have point-in-time history in this workspace, so
this validator deliberately replays only the daily price/liquidity/beta/
drawdown/capital-migration proxy used by the earlier historical validation.
"""

from __future__ import annotations

import argparse
import json
import math
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

import build_type_factor_pools_v1 as type_factor
import validate_capital_migration_factor as migration_source
import validate_multifactor_v1_price_proxy as beta_source


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "lab/backtests/recent_type_factor_proxy_validation"
HORIZONS = {"1d": 1, "10d": 10, "60d": 60}
DEFAULT_RECENT_DAYS = 60
DEFAULT_LONG_HORIZON = 60
MIN_TYPE_POOL_SIZE = 30
MIN_SECTOR_SIZE = 8


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def pct(value: object, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value) * 100:.{digits}f}%"


def num(value: object, digits: int = 3) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value):.{digits}f}"


def md_table(frame: pd.DataFrame, columns: list[str], rows: int = 40) -> str:
    if frame.empty:
        return "_No valid observations._"
    shown = frame.reindex(columns=[column for column in columns if column in frame.columns]).head(rows).copy()
    if shown.empty:
        return "_No selected columns._"

    def value_text(value: object) -> str:
        if value is None or pd.isna(value):
            return "-"
        if isinstance(value, (float, np.floating)):
            return f"{float(value):.4f}"
        return str(value).replace("|", "\\|").replace("\n", " ")

    header = "| " + " | ".join(shown.columns) + " |"
    divider = "| " + " | ".join("---" for _ in shown.columns) + " |"
    body = ["| " + " | ".join(value_text(value) for value in row) + " |" for row in shown.itertuples(index=False, name=None)]
    return "\n".join([header, divider, *body])


def build_signal_windows(
    dates: pd.DatetimeIndex, recent_days: int = DEFAULT_RECENT_DAYS, long_horizon: int = DEFAULT_LONG_HORIZON
) -> dict[str, pd.DatetimeIndex]:
    """Return recent signals and the newest equal-sized mature long-horizon set."""

    calendar = pd.DatetimeIndex(pd.to_datetime(dates)).unique().sort_values()
    if recent_days <= 0 or long_horizon <= 0:
        raise ValueError("recent_days and long_horizon must be positive")
    if len(calendar) < recent_days + long_horizon:
        raise ValueError("not enough trading dates for requested recent and mature windows")
    recent = calendar[-recent_days:]
    mature = calendar[-(recent_days + long_horizon) : -long_horizon]
    latest_mature_anchor = pd.DatetimeIndex([calendar[-long_horizon - 1]])
    return {"recent_60d": recent, "mature_60d": mature, "latest_60d_anchor": latest_mature_anchor}


def non_overlapping_dates(dates: pd.DatetimeIndex, horizon_days: int) -> pd.DatetimeIndex:
    """Choose signal dates whose forward windows do not overlap by construction."""

    if horizon_days <= 0:
        raise ValueError("horizon_days must be positive")
    calendar = pd.DatetimeIndex(pd.to_datetime(dates)).unique().sort_values()
    return calendar[::horizon_days]


def load_daily_calendar(end: str | None = None) -> pd.DatetimeIndex:
    market_close, _ = beta_source.load_market_close()
    calendar = market_close.index
    if end is not None:
        calendar = calendar[calendar <= pd.Timestamp(end)]
    return pd.DatetimeIndex(calendar).unique().sort_values()


def build_daily_proxy_panel(signal_dates: pd.DatetimeIndex) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Rebuild the two historical price-only source panels only for signal dates."""

    beta_panel, _, beta_cache_log, _ = beta_source.make_factor_panel(signal_dates=signal_dates, horizons=HORIZONS)
    migration_panel, _, migration_cache_log = migration_source.build_factor_panel(signal_dates=signal_dates, horizons=HORIZONS)
    keys = ["date", "source_group", "sector_code", "stock_code"]
    migration_columns = keys + [
        "stock_liquidity_delta_score",
        "sector_liquidity_delta_score",
        "price_confirm_score",
        "relative_strength_score",
        "overheat_penalty",
        "capital_migration_score",
        "static_liquidity_score",
    ]
    history = beta_panel.merge(
        migration_panel[migration_columns],
        on=keys,
        how="left",
        validate="one_to_one",
    )

    pool_panels: list[pd.DataFrame] = []
    for pool_type in type_factor.POOL_SECTORS:
        selected = type_factor.select_preferred_history_rows(history, pool_type)
        if not selected.empty:
            pool_panels.append(type_factor.historical_proxy_scores(selected, pool_type))
    panel = pd.concat(pool_panels, ignore_index=True)
    panel["date"] = pd.to_datetime(panel["date"])
    panel = panel[panel["avg_amount_20d_hist"].fillna(0) >= type_factor.MIN_AVG_AMOUNT].copy()
    return panel, beta_cache_log, migration_cache_log


def rank_ic_snapshots(
    panel: pd.DataFrame,
    horizon: str,
    window_name: str,
    sampling: str,
    min_pool_size: int = MIN_TYPE_POOL_SIZE,
) -> pd.DataFrame:
    label = f"future_return_{horizon}"
    rows: list[dict[str, object]] = []
    if label not in panel.columns:
        return pd.DataFrame(rows)
    for (pool_type, date), group in panel.groupby(["pool_type", "date"]):
        valid = group.dropna(subset=["historical_proxy_score", label])
        if len(valid) < min_pool_size:
            continue
        rows.append(
            {
                "window": window_name,
                "sampling": sampling,
                "horizon": horizon,
                "pool_type": pool_type,
                "date": pd.Timestamp(date).date().isoformat(),
                "rank_ic": float(valid["historical_proxy_score"].rank().corr(valid[label].rank())),
                "sample_size": int(len(valid)),
            }
        )
    return pd.DataFrame(rows)


def summarize_rank_ic(snapshots: pd.DataFrame) -> pd.DataFrame:
    if snapshots.empty:
        return pd.DataFrame(
            columns=["window", "sampling", "horizon", "pool_type", "periods", "mean_rank_ic", "median_rank_ic"]
        )
    return (
        snapshots.groupby(["window", "sampling", "horizon", "pool_type"])
        .agg(
            periods=("rank_ic", "count"),
            mean_rank_ic=("rank_ic", "mean"),
            median_rank_ic=("rank_ic", "median"),
            positive_ratio=("rank_ic", lambda values: float((values > 0).mean())),
            ic_ir=("rank_ic", lambda values: float(values.mean() / values.std(ddof=1)) if values.std(ddof=1) > 0 else np.nan),
            avg_sample_size=("sample_size", "mean"),
        )
        .reset_index()
        .sort_values(["window", "sampling", "horizon", "pool_type"])
        .reset_index(drop=True)
    )


def add_context(frame: pd.DataFrame, window_name: str, sampling: str, signal_date_count: int) -> pd.DataFrame:
    if frame.empty:
        return frame.copy()
    out = frame.copy()
    out.insert(0, "signal_date_count", signal_date_count)
    out.insert(0, "sampling", sampling)
    out.insert(0, "window", window_name)
    return out


def evaluate_dates(
    panel: pd.DataFrame,
    dates: pd.DatetimeIndex,
    horizon: str,
    window_name: str,
    sampling: str,
) -> dict[str, pd.DataFrame]:
    selected = panel[panel["date"].isin(pd.DatetimeIndex(dates))].copy()
    validation = type_factor.build_recommendation_validation(
        selected,
        horizons=[horizon],
        min_type_pool_size=MIN_TYPE_POOL_SIZE,
        min_sector_size=MIN_SECTOR_SIZE,
        time_split_ratio=0.70,
    )
    return {
        "type_pool_summary": add_context(validation["type_pool_summary"], window_name, sampling, len(dates)),
        "sector_neutral_summary": add_context(validation["sector_neutral_summary"], window_name, sampling, len(dates)),
        "observations": add_context(validation["observations"], window_name, sampling, len(dates)),
        "rank_ic_snapshots": rank_ic_snapshots(selected, horizon, window_name, sampling),
    }


def run_evaluations(panel: pd.DataFrame, windows: dict[str, pd.DatetimeIndex]) -> dict[str, pd.DataFrame]:
    type_summaries: list[pd.DataFrame] = []
    sector_summaries: list[pd.DataFrame] = []
    observations: list[pd.DataFrame] = []
    ic_snapshots: list[pd.DataFrame] = []

    plans = [
        ("recent_60d", windows["recent_60d"], ["1d", "10d"]),
        ("latest_60d_anchor", windows["latest_60d_anchor"], ["60d"]),
        ("mature_60d", windows["mature_60d"], ["60d"]),
    ]
    for window_name, dates, horizons in plans:
        for horizon in horizons:
            samples = [("every_signal", dates)]
            horizon_days = HORIZONS[horizon]
            if horizon_days > 1:
                samples.append((f"nonoverlap_{horizon}", non_overlapping_dates(dates, horizon_days)))
            for sampling, sampled_dates in samples:
                result = evaluate_dates(panel, sampled_dates, horizon, window_name, sampling)
                type_summaries.append(result["type_pool_summary"])
                sector_summaries.append(result["sector_neutral_summary"])
                observations.append(result["observations"])
                ic_snapshots.append(result["rank_ic_snapshots"])

    def concat(frames: list[pd.DataFrame]) -> pd.DataFrame:
        usable = [frame for frame in frames if not frame.empty]
        return pd.concat(usable, ignore_index=True) if usable else pd.DataFrame()

    ic = concat(ic_snapshots)
    return {
        "type_pool_summary": concat(type_summaries),
        "sector_neutral_summary": concat(sector_summaries),
        "observations": concat(observations),
        "rank_ic_snapshots": ic,
        "rank_ic_summary": summarize_rank_ic(ic),
    }


def format_summary(frame: pd.DataFrame, sector: bool = False) -> pd.DataFrame:
    shown = frame.copy()
    percent_columns = [
        "a_forward_return_mean",
        "reference_forward_return_mean",
        "a_excess_vs_reference_mean",
        "a_minus_c_mean",
        "a_positive_period_ratio",
        "a_beats_reference_period_ratio",
        "a_beats_c_period_ratio",
    ]
    for column in percent_columns:
        if column in shown:
            shown[column] = shown[column].map(pct)
    return shown


def format_ic(frame: pd.DataFrame) -> pd.DataFrame:
    shown = frame.copy()
    for column in ["mean_rank_ic", "median_rank_ic", "ic_ir"]:
        if column in shown:
            shown[column] = shown[column].map(num)
    if "positive_ratio" in shown:
        shown["positive_ratio"] = shown["positive_ratio"].map(pct)
    return shown


def build_report(
    panel: pd.DataFrame,
    windows: dict[str, pd.DatetimeIndex],
    evaluations: dict[str, pd.DataFrame],
    latest_price_date: pd.Timestamp,
    recent_days: int,
    long_horizon: int,
) -> str:
    type_summary = evaluations["type_pool_summary"]
    sector_summary = evaluations["sector_neutral_summary"]
    ic_summary = evaluations["rank_ic_summary"]
    headline_type = type_summary[type_summary["sampling"].eq("every_signal")] if not type_summary.empty else type_summary
    headline_sector = sector_summary[sector_summary["sampling"].eq("every_signal")] if not sector_summary.empty else sector_summary
    headline_ic = ic_summary[ic_summary["sampling"].eq("every_signal")] if not ic_summary.empty else ic_summary
    return f"""# Recent Daily Type-Factor Proxy Validation

## Purpose

This is a rolling cross-sectional validation of whether higher daily
price-reconstructable type-factor scores were followed by stronger returns in
the most recent market regime. It is **not** a portfolio backtest and it is
**not** a point-in-time test of the full live V1 score.

Latest local price date: `{latest_price_date.date().isoformat()}`.

## Signal Windows

- `recent_60d`: the newest {recent_days} daily score snapshots. It supports
  many T+1 and T+10 observations, but no full T+60 return has matured inside
  this strict window.
- `latest_60d_anchor`: the latest single signal whose T+60 return is known.
  It is descriptive only, not a statistical test.
- `mature_60d`: the newest {recent_days} signal dates ending {long_horizon}
  sessions before the last price date; every one has a known T+60 return.

## Method

- Every signal date recomputes the historical price proxy inside each type
  pool, using only trend, momentum, beta, liquidity, drawdown, and capital
  migration fields available at that date.
- A tier is the top score percentile at or above 80% in its type pool.
- `A excess` compares A average forward return with all eligible stocks in the
  same type pool. `Sector-neutral A excess` compares inside the same sector.
- `Rank IC` asks whether higher scores map to higher future-return ranks.
- `nonoverlap_*` samples signals at the label horizon spacing to avoid treating
  heavily overlapping return windows as independent evidence.

## Type-Pool A Tier Results

{md_table(format_summary(headline_type), ['window', 'horizon', 'pool_type', 'signal_date_count', 'periods', 'a_forward_return_mean', 'reference_forward_return_mean', 'a_excess_vs_reference_mean', 'a_minus_c_mean', 'a_beats_reference_period_ratio', 'a_beats_c_period_ratio'])}

## Sector-Neutral A Tier Results

{md_table(format_summary(headline_sector, sector=True), ['window', 'horizon', 'pool_type', 'signal_date_count', 'periods', 'sector_snapshots', 'a_excess_vs_reference_mean', 'a_minus_c_mean', 'a_beats_reference_period_ratio', 'a_beats_c_period_ratio'])}

## Rank IC Results

{md_table(format_ic(headline_ic), ['window', 'horizon', 'pool_type', 'periods', 'mean_rank_ic', 'median_rank_ic', 'positive_ratio', 'ic_ir', 'avg_sample_size'])}

## Non-Overlapping Robustness View

{md_table(format_summary(type_summary[type_summary['sampling'].ne('every_signal')] if not type_summary.empty else type_summary), ['window', 'sampling', 'horizon', 'pool_type', 'signal_date_count', 'periods', 'a_excess_vs_reference_mean', 'a_minus_c_mean', 'a_beats_reference_period_ratio'])}

## Limits

- Historical valuation, earnings, and industry-space values are unavailable;
  the live V1 full score cannot be claimed as tested here.
- Current candidate universe and type-pool membership are applied backward,
  producing survivorship and membership bias.
- Daily return labels overlap for every-signal T+10/T+60 summaries. The
  non-overlap view is a guardrail, but its small sample sizes reduce precision.
- This report does not include transaction costs, position sizing, or trading
  constraints. Those belong to a later strategy backtest after the factor
  evidence is satisfactory.
"""


def write_outputs(
    output_dir: Path,
    panel: pd.DataFrame,
    windows: dict[str, pd.DatetimeIndex],
    evaluations: dict[str, pd.DataFrame],
    beta_cache_log: pd.DataFrame,
    migration_cache_log: pd.DataFrame,
    latest_price_date: pd.Timestamp,
    recent_days: int,
    long_horizon: int,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[Path] = []
    artifacts_to_write = {
        "daily_historical_proxy_panel.csv": panel,
        "type_pool_summary.csv": evaluations["type_pool_summary"],
        "sector_neutral_summary.csv": evaluations["sector_neutral_summary"],
        "rank_ic_snapshots.csv": evaluations["rank_ic_snapshots"],
        "rank_ic_summary.csv": evaluations["rank_ic_summary"],
        "recommendation_observations.csv": evaluations["observations"],
        "beta_cache_log.csv": beta_cache_log,
        "migration_cache_log.csv": migration_cache_log,
    }
    for name, frame in artifacts_to_write.items():
        path = output_dir / name
        frame.to_csv(path, index=False)
        artifacts.append(path)

    window_rows = []
    for name, dates in windows.items():
        for date in dates:
            window_rows.append({"window": name, "signal_date": date.date().isoformat()})
    window_file = output_dir / "signal_windows.csv"
    pd.DataFrame(window_rows).to_csv(window_file, index=False)
    artifacts.append(window_file)

    report_file = output_dir / "recent_type_factor_proxy_validation_report.md"
    report_file.write_text(
        build_report(panel, windows, evaluations, latest_price_date, recent_days, long_horizon), encoding="utf-8"
    )
    artifacts.append(report_file)

    metadata = {
        "validation": "recent_daily_type_factor_price_proxy",
        "latest_local_price_date": latest_price_date.date().isoformat(),
        "signal_windows": {
            name: {"count": int(len(dates)), "start": dates.min().date().isoformat(), "end": dates.max().date().isoformat()}
            for name, dates in windows.items()
        },
        "horizons": HORIZONS,
        "recent_days": recent_days,
        "long_horizon": long_horizon,
        "definitions": {
            "a_tier": "historical_proxy_score percentile >= 80% within a type pool",
            "type_reference": "all eligible stocks in the same type pool and date",
            "sector_reference": "all eligible stocks in the same type pool, sector, and date",
        },
        "limitations": [
            "Only the price-reconstructable historical proxy score is tested; historical point-in-time valuation, earnings, and industry-space data are absent.",
            "Current candidate universe and type-pool membership are applied backward, creating survivorship and membership bias.",
            "Every-signal multi-day labels overlap; nonoverlap summaries use a horizon-length stride as a robustness view.",
        ],
        "artifacts": [path.name for path in artifacts],
    }
    metadata_file = output_dir / "summary.json"
    metadata_file.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    artifacts.append(metadata_file)

    zip_file = output_dir / "recent_type_factor_proxy_validation_outputs.zip"
    with zipfile.ZipFile(zip_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for artifact in artifacts:
            archive.write(artifact, arcname=artifact.name)
    return zip_file


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR))
    parser.add_argument("--end", default=None)
    parser.add_argument("--recent-days", type=int, default=DEFAULT_RECENT_DAYS)
    parser.add_argument("--long-horizon", type=int, default=DEFAULT_LONG_HORIZON)
    args = parser.parse_args()

    calendar = load_daily_calendar(end=args.end)
    windows = build_signal_windows(calendar, recent_days=args.recent_days, long_horizon=args.long_horizon)
    all_signal_dates = pd.DatetimeIndex(
        sorted(set(windows["recent_60d"]).union(set(windows["mature_60d"])).union(set(windows["latest_60d_anchor"])))
    )
    panel, beta_cache_log, migration_cache_log = build_daily_proxy_panel(all_signal_dates)
    evaluations = run_evaluations(panel, windows)
    output_dir = output_path(args.output_dir)
    zip_file = write_outputs(
        output_dir,
        panel,
        windows,
        evaluations,
        beta_cache_log,
        migration_cache_log,
        latest_price_date=calendar.max(),
        recent_days=args.recent_days,
        long_horizon=args.long_horizon,
    )

    print("Recent type-factor daily Rank IC summary")
    print(evaluations["rank_ic_summary"].to_string(index=False))
    print("\nRecent type-factor daily A-tier summary")
    print(evaluations["type_pool_summary"].to_string(index=False))
    print(f"\nArtifacts written to: {output_dir}")
    print(f"ZIP: {zip_file}")


if __name__ == "__main__":
    main()

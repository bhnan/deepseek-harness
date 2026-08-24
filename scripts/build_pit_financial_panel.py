#!/usr/bin/env python3
"""Build an auditable point-in-time financial panel from AKShare filings.

Financial rows are assigned to a rebalance date only after their NOTICE_DATE.
This prevents a report-period value from leaking into an earlier decision.
The script caches raw provider responses and preserves UPDATE_DATE so later
revisions remain visible to the research audit.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import time
from pathlib import Path

import akshare as ak
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UNIVERSE = ROOT / "lab/backtests/type_factor_pools_v1/type_factor_candidates_all.csv"
DEFAULT_REBALANCE_PANEL = ROOT / "lab/backtests/type_factor_pools_v1/type_factor_historical_proxy_panel.csv"
DEFAULT_CACHE_DIR = ROOT / "data/pit_financial/raw_profit_sheets"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/pit_financial_panel"
SOURCE_NAME = "akshare.stock_profit_sheet_by_report_em"

VALUE_COLUMNS = [
    "TOTAL_OPERATE_INCOME",
    "TOTAL_OPERATE_INCOME_YOY",
    "PARENT_NETPROFIT",
    "PARENT_NETPROFIT_YOY",
    "DEDUCT_PARENT_NETPROFIT",
    "DEDUCT_PARENT_NETPROFIT_YOY",
]

FLOW_COLUMNS = ["TOTAL_OPERATE_INCOME", "PARENT_NETPROFIT", "DEDUCT_PARENT_NETPROFIT"]
TTM_COLUMNS = [f"{column}_TTM" for column in FLOW_COLUMNS]
TTM_AVAILABILITY_COLUMNS = [f"{column}_TTM_AVAILABLE" for column in FLOW_COLUMNS]


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def zcode(value: object) -> str:
    return str(value).split(".")[0].zfill(6)


def market_symbol(stock_code: str) -> str:
    """Return the market-prefixed AKShare symbol for an A-share code."""

    code = zcode(stock_code)
    if code.startswith(("6", "9")):
        return f"SH{code}"
    if code.startswith(("4", "8")):
        return f"BJ{code}"
    return f"SZ{code}"


def raw_cache_path(cache_dir: Path, stock_code: str) -> Path:
    return cache_dir / f"{market_symbol(stock_code)}.csv"


def normalize_financial_reports(raw: pd.DataFrame, stock_code: str) -> pd.DataFrame:
    """Normalize one stock's filing rows while keeping provider timestamps."""

    columns = [
        "SECURITY_CODE",
        "SECURITY_NAME_ABBR",
        "REPORT_DATE",
        "REPORT_TYPE",
        "REPORT_DATE_NAME",
        "NOTICE_DATE",
        "UPDATE_DATE",
        *VALUE_COLUMNS,
    ]
    present = [column for column in columns if column in raw.columns]
    frame = raw.reindex(columns=present).copy()
    if frame.empty or "REPORT_DATE" not in frame or "NOTICE_DATE" not in frame:
        return pd.DataFrame()

    frame.insert(0, "stock_code", zcode(stock_code))
    frame = frame.rename(columns={"SECURITY_NAME_ABBR": "stock_name"})
    for column in ["REPORT_DATE", "NOTICE_DATE", "UPDATE_DATE"]:
        if column in frame:
            frame[column] = pd.to_datetime(frame[column], errors="coerce").dt.normalize()
    for column in VALUE_COLUMNS:
        if column in frame:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
        else:
            frame[column] = np.nan
    frame["source"] = SOURCE_NAME
    frame = frame.dropna(subset=["REPORT_DATE", "NOTICE_DATE"]).copy()
    frame = frame[frame["NOTICE_DATE"].ge(frame["REPORT_DATE"])].copy()
    # Retain the earliest available filing for each period. Later updates remain
    # in the raw cache, but cannot silently replace the originally known row.
    frame = (
        frame.sort_values(["REPORT_DATE", "NOTICE_DATE", "UPDATE_DATE"], na_position="last")
        .drop_duplicates(["stock_code", "REPORT_DATE"], keep="first")
        .reset_index(drop=True)
    )
    return add_trailing_twelve_months(frame)


def add_trailing_twelve_months(reports: pd.DataFrame) -> pd.DataFrame:
    """Derive TTM flow metrics using only filings public by the current filing.

    For an interim report, TTM = current year-to-date flow + prior annual flow
    - prior-year same-period flow. Both historical components must have been
    published no later than the current report's NOTICE_DATE. This conservative
    check prevents accidental use of a later-announced annual report.
    """

    if reports.empty:
        return reports.copy()

    frame = reports.copy()
    frame["REPORT_DATE"] = pd.to_datetime(frame["REPORT_DATE"], errors="coerce").dt.normalize()
    frame["NOTICE_DATE"] = pd.to_datetime(frame["NOTICE_DATE"], errors="coerce").dt.normalize()
    frame["_report_year"] = frame["REPORT_DATE"].dt.year
    frame["_report_month"] = frame["REPORT_DATE"].dt.month

    reference_columns = ["stock_code", "_report_year", "_report_month", "NOTICE_DATE", *FLOW_COLUMNS]
    previous_annual = frame.loc[frame["_report_month"].eq(12), reference_columns].copy()
    previous_annual["_report_year"] += 1
    previous_annual = previous_annual.drop(columns="_report_month").rename(
        columns={
            "NOTICE_DATE": "_prior_annual_notice_date",
            **{column: f"_prior_annual_{column}" for column in FLOW_COLUMNS},
        }
    )
    previous_same_period = frame[reference_columns].copy()
    previous_same_period["_report_year"] += 1
    previous_same_period = previous_same_period.rename(
        columns={
            "NOTICE_DATE": "_prior_period_notice_date",
            **{column: f"_prior_period_{column}" for column in FLOW_COLUMNS},
        }
    )

    frame = frame.merge(previous_annual, on=["stock_code", "_report_year"], how="left", validate="many_to_one")
    frame = frame.merge(
        previous_same_period,
        on=["stock_code", "_report_year", "_report_month"],
        how="left",
        validate="many_to_one",
    )
    historical_components_public = (
        frame["_prior_annual_notice_date"].le(frame["NOTICE_DATE"])
        & frame["_prior_period_notice_date"].le(frame["NOTICE_DATE"])
    )
    is_annual = frame["_report_month"].eq(12)

    for column in FLOW_COLUMNS:
        ttm_column = f"{column}_TTM"
        available_column = f"{column}_TTM_AVAILABLE"
        annual_available = is_annual & frame[column].notna()
        interim_available = (
            ~is_annual
            & historical_components_public
            & frame[[column, f"_prior_annual_{column}", f"_prior_period_{column}"]].notna().all(axis=1)
        )
        frame[available_column] = annual_available | interim_available
        frame[ttm_column] = np.where(
            annual_available,
            frame[column],
            np.where(
                interim_available,
                frame[column] + frame[f"_prior_annual_{column}"] - frame[f"_prior_period_{column}"],
                np.nan,
            ),
        )

    return frame.drop(
        columns=[
            "_report_year",
            "_report_month",
            "_prior_annual_notice_date",
            "_prior_period_notice_date",
            *[f"_prior_annual_{column}" for column in FLOW_COLUMNS],
            *[f"_prior_period_{column}" for column in FLOW_COLUMNS],
        ]
    )


def load_universe(path: Path, limit: int | None = None) -> pd.DataFrame:
    universe = pd.read_csv(path, dtype={"stock_code": str})
    required = {"stock_code", "stock_name", "sector_name", "sector_code"}
    missing = sorted(required.difference(universe.columns))
    if missing:
        raise ValueError(f"universe is missing columns: {', '.join(missing)}")
    universe["stock_code"] = universe["stock_code"].map(zcode)
    unique = universe.sort_values("stock_code").drop_duplicates("stock_code", keep="first")
    return unique.head(limit).reset_index(drop=True) if limit else unique.reset_index(drop=True)


def load_rebalance_dates(path: Path) -> pd.DatetimeIndex:
    panel = pd.read_csv(path, usecols=["date"])
    return pd.DatetimeIndex(pd.to_datetime(panel["date"], errors="coerce").dropna().unique()).sort_values()


def get_raw_report(stock_code: str, cache_dir: Path, fetch_missing: bool) -> tuple[pd.DataFrame, str, str | None]:
    """Load cached raw data or fetch exactly one provider response."""

    cache_file = raw_cache_path(cache_dir, stock_code)
    if cache_file.exists():
        return pd.read_csv(cache_file), "cache", None
    if not fetch_missing:
        return pd.DataFrame(), "missing", "cache miss with fetching disabled"
    try:
        frame = ak.stock_profit_sheet_by_report_em(symbol=market_symbol(stock_code))
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        frame.to_csv(cache_file, index=False)
        return frame, "fetched", None
    except Exception as error:  # Provider errors must be materialized for reruns.
        return pd.DataFrame(), "error", f"{type(error).__name__}: {error}"


def collect_reports(
    stocks: pd.DataFrame,
    cache_dir: Path,
    fetch_missing: bool,
    workers: int,
    throttle_seconds: float,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Collect and normalize filings, with a conservative worker default."""

    def task(stock_code: str) -> tuple[str, pd.DataFrame, str, str | None]:
        raw, status, error = get_raw_report(stock_code, cache_dir, fetch_missing)
        if status == "fetched" and throttle_seconds > 0:
            time.sleep(throttle_seconds)
        return stock_code, normalize_financial_reports(raw, stock_code), status, error

    report_frames: list[pd.DataFrame] = []
    log_rows: list[dict[str, object]] = []
    codes = stocks["stock_code"].tolist()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(task, code) for code in codes]
        for future in concurrent.futures.as_completed(futures):
            stock_code, reports, status, error = future.result()
            if not reports.empty:
                report_frames.append(reports)
            log_rows.append(
                {
                    "stock_code": stock_code,
                    "symbol": market_symbol(stock_code),
                    "status": status,
                    "error": error,
                    "normalized_rows": int(len(reports)),
                }
            )
    reports = pd.concat(report_frames, ignore_index=True) if report_frames else pd.DataFrame()
    cache_log = pd.DataFrame(log_rows).sort_values("stock_code").reset_index(drop=True)
    return reports, cache_log


def build_asof_panel(
    stocks: pd.DataFrame,
    reports: pd.DataFrame,
    rebalance_dates: pd.DatetimeIndex,
) -> pd.DataFrame:
    """Attach the latest filing that was actually public on each decision date."""

    decisions = pd.MultiIndex.from_product(
        [stocks["stock_code"].tolist(), rebalance_dates], names=["stock_code", "date"]
    ).to_frame(index=False)
    metadata = stocks[["stock_code", "stock_name", "sector_name", "sector_code"]]
    decisions = decisions.merge(metadata, on="stock_code", how="left", validate="many_to_one")
    frames: list[pd.DataFrame] = []
    for stock_code, dates in decisions.groupby("stock_code", sort=False):
        left = dates.sort_values("date").copy()
        right = reports[reports["stock_code"].eq(stock_code)].sort_values("NOTICE_DATE").copy()
        if right.empty:
            for column in ["REPORT_DATE", "NOTICE_DATE", "UPDATE_DATE", *VALUE_COLUMNS, *TTM_COLUMNS, "source"]:
                left[column] = np.nan
            for column in TTM_AVAILABILITY_COLUMNS:
                left[column] = False
            frames.append(left)
            continue
        merged = pd.merge_asof(
            left,
            right.drop(columns=["stock_code", "stock_name"], errors="ignore"),
            left_on="date",
            right_on="NOTICE_DATE",
            direction="backward",
        )
        # A provider anomaly can never make a future report available earlier.
        invalid = merged["REPORT_DATE"].notna() & merged["REPORT_DATE"].gt(merged["date"])
        merged.loc[invalid, ["REPORT_DATE", "NOTICE_DATE", "UPDATE_DATE", *VALUE_COLUMNS, *TTM_COLUMNS]] = np.nan
        merged.loc[invalid, TTM_AVAILABILITY_COLUMNS] = False
        frames.append(merged)

    panel = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    # Dates before a stock's first filing have no matched right-hand row.
    # Record those TTM flags as explicitly unavailable rather than leaving a
    # mixed object/NaN column in the audit panel.
    for column in TTM_AVAILABILITY_COLUMNS:
        panel[column] = panel[column].fillna(False).astype(bool)
    panel["financial_data_age_days"] = (panel["date"] - panel["NOTICE_DATE"]).dt.days
    panel["availability_valid"] = panel["NOTICE_DATE"].le(panel["date"]) & panel["REPORT_DATE"].le(panel["date"])
    panel.loc[panel["NOTICE_DATE"].isna(), "availability_valid"] = False
    return panel.sort_values(["date", "stock_code"]).reset_index(drop=True)


def write_outputs(
    output_dir: Path,
    reports: pd.DataFrame,
    asof_panel: pd.DataFrame,
    cache_log: pd.DataFrame,
    stocks: pd.DataFrame,
    rebalance_dates: pd.DatetimeIndex,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    reports.to_csv(output_dir / "normalized_financial_reports.csv", index=False)
    asof_panel.to_csv(output_dir / "pit_financial_asof_panel.csv", index=False)
    cache_log.to_csv(output_dir / "provider_cache_log.csv", index=False)
    valid_rows = asof_panel[asof_panel["availability_valid"]] if not asof_panel.empty else asof_panel
    summary = {
        "source": SOURCE_NAME,
        "stocks_requested": int(len(stocks)),
        "rebalance_dates": int(len(rebalance_dates)),
        "normalized_reports": int(len(reports)),
        "asof_rows": int(len(asof_panel)),
        "asof_coverage_ratio": float(len(valid_rows) / len(asof_panel)) if len(asof_panel) else 0.0,
        "availability_violations": int((~valid_rows["availability_valid"]).sum()) if not valid_rows.empty else 0,
        "version_policy": "Use the earliest NOTICE_DATE row for each stock/report period; preserve UPDATE_DATE and raw cache for audit.",
        "limitation": "A provider may retrospectively revise historic statement values. NOTICE_DATE blocks publication-date look-ahead but does not create a full historical vendor-vintage database.",
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe", default=str(DEFAULT_UNIVERSE))
    parser.add_argument("--rebalance-panel", default=str(DEFAULT_REBALANCE_PANEL))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE_DIR))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--limit", type=int, default=None, help="only process the first N deterministic stock codes")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--throttle-seconds", type=float, default=0.20)
    parser.add_argument("--no-fetch", action="store_true", help="use cache only")
    args = parser.parse_args()

    stocks = load_universe(output_path(args.universe), args.limit)
    rebalance_dates = load_rebalance_dates(output_path(args.rebalance_panel))
    reports, cache_log = collect_reports(
        stocks,
        output_path(args.cache_dir),
        fetch_missing=not args.no_fetch,
        workers=args.workers,
        throttle_seconds=args.throttle_seconds,
    )
    asof_panel = build_asof_panel(stocks, reports, rebalance_dates)
    output_dir = output_path(args.output_dir)
    write_outputs(output_dir, reports, asof_panel, cache_log, stocks, rebalance_dates)

    print(cache_log["status"].value_counts().to_string())
    print(f"reports={len(reports)} asof_rows={len(asof_panel)}")
    print(f"artifacts={output_dir}")


if __name__ == "__main__":
    main()

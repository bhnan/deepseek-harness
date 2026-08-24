#!/usr/bin/env python3
"""Build a point-in-time valuation panel from historical daily series."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import time
from pathlib import Path

import akshare as ak
import numpy as np
import pandas as pd

import build_pit_financial_panel as financial_source


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UNIVERSE = ROOT / "lab/backtests/type_factor_pools_v1/type_factor_candidates_all.csv"
DEFAULT_REBALANCE_PANEL = ROOT / "lab/backtests/type_factor_pools_v1/type_factor_historical_proxy_panel.csv"
DEFAULT_CACHE_DIR = ROOT / "data/pit_valuation"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/pit_valuation_panel"
VALUATION_METRICS = {"market_cap_yi": "总市值", "pe_ttm": "市盈率(TTM)", "pb": "市净率"}
SOURCE_NAME = "akshare.stock_zh_valuation_baidu"


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def cache_path(cache_dir: Path, stock_code: str, metric: str) -> Path:
    return cache_dir / metric / f"{financial_source.zcode(stock_code)}.csv"


def normalize_history(raw: pd.DataFrame, stock_code: str, metric: str) -> pd.DataFrame:
    if not {"date", "value"}.issubset(raw.columns):
        return pd.DataFrame()
    frame = raw[["date", "value"]].copy()
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce").dt.normalize()
    frame["value"] = pd.to_numeric(frame["value"], errors="coerce")
    frame = frame.dropna(subset=["date", "value"]).drop_duplicates("date", keep="last")
    frame.insert(0, "stock_code", financial_source.zcode(stock_code))
    frame = frame.rename(columns={"value": metric})
    return frame.sort_values("date").reset_index(drop=True)


def get_metric(stock_code: str, metric: str, cache_dir: Path, fetch_missing: bool) -> tuple[pd.DataFrame, str, str | None]:
    target = cache_path(cache_dir, stock_code, metric)
    if target.exists():
        return pd.read_csv(target), "cache", None
    if not fetch_missing:
        return pd.DataFrame(), "missing", "cache miss with fetching disabled"
    try:
        raw = ak.stock_zh_valuation_baidu(
            symbol=financial_source.zcode(stock_code), indicator=VALUATION_METRICS[metric], period="全部"
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        raw.to_csv(target, index=False)
        return raw, "fetched", None
    except Exception as error:
        return pd.DataFrame(), "error", f"{type(error).__name__}: {error}"


def collect_valuations(
    stocks: pd.DataFrame,
    cache_dir: Path,
    fetch_missing: bool,
    workers: int,
    throttle_seconds: float,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    def task(stock_code: str, metric: str) -> tuple[str, str, pd.DataFrame, str, str | None]:
        raw, status, error = get_metric(stock_code, metric, cache_dir, fetch_missing)
        if status == "fetched" and throttle_seconds > 0:
            time.sleep(throttle_seconds)
        return stock_code, metric, normalize_history(raw, stock_code, metric), status, error

    frames: list[pd.DataFrame] = []
    logs: list[dict[str, object]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [
            executor.submit(task, stock_code, metric)
            for stock_code in stocks["stock_code"].tolist()
            for metric in VALUATION_METRICS
        ]
        for future in concurrent.futures.as_completed(futures):
            stock_code, metric, frame, status, error = future.result()
            if not frame.empty:
                frames.append(frame)
            logs.append(
                {
                    "stock_code": stock_code,
                    "metric": metric,
                    "status": status,
                    "error": error,
                    "rows": int(len(frame)),
                }
            )

    long = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    if long.empty:
        return pd.DataFrame(), pd.DataFrame(logs)
    wide = (
        long.pivot_table(index=["stock_code", "date"], values=list(VALUATION_METRICS), aggfunc="last")
        .reset_index()
        .sort_values(["stock_code", "date"])
        .reset_index(drop=True)
    )
    return wide, pd.DataFrame(logs).sort_values(["stock_code", "metric"]).reset_index(drop=True)


def build_asof_panel(
    stocks: pd.DataFrame,
    valuation_history: pd.DataFrame,
    rebalance_dates: pd.DatetimeIndex,
) -> pd.DataFrame:
    decisions = pd.MultiIndex.from_product(
        [stocks["stock_code"].tolist(), rebalance_dates], names=["stock_code", "date"]
    ).to_frame(index=False)
    metadata = stocks[["stock_code", "stock_name", "sector_name", "sector_code"]]
    decisions = decisions.merge(metadata, on="stock_code", how="left", validate="many_to_one")
    # CSV-derived dates can have a different datetime resolution from provider data.
    # merge_asof requires exact dtype parity, so normalize both sides before joining.
    decisions["date"] = pd.to_datetime(decisions["date"], errors="coerce").dt.as_unit("ns")
    valuation_history = valuation_history.copy()
    valuation_history["date"] = pd.to_datetime(valuation_history["date"], errors="coerce").dt.as_unit("ns")
    frames: list[pd.DataFrame] = []
    for stock_code, dates in decisions.groupby("stock_code", sort=False):
        left = dates.sort_values("date")
        right = valuation_history[valuation_history["stock_code"].eq(stock_code)].sort_values("date")
        if right.empty:
            missing = left.copy()
            missing["valuation_date"] = pd.NaT
            for metric in VALUATION_METRICS:
                missing[metric] = np.nan
            frames.append(missing)
            continue
        right = right.rename(columns={"date": "valuation_date"}).drop(columns="stock_code")
        frames.append(pd.merge_asof(left, right, left_on="date", right_on="valuation_date", direction="backward"))
    panel = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    panel["valuation_age_days"] = (panel["date"] - panel["valuation_date"]).dt.days
    panel["availability_valid"] = panel["valuation_date"].le(panel["date"])
    panel.loc[panel["valuation_date"].isna(), "availability_valid"] = False
    return panel.sort_values(["date", "stock_code"]).reset_index(drop=True)


def write_outputs(
    output_dir: Path,
    valuation_history: pd.DataFrame,
    asof_panel: pd.DataFrame,
    cache_log: pd.DataFrame,
    stocks: pd.DataFrame,
    rebalance_dates: pd.DatetimeIndex,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    valuation_history.to_csv(output_dir / "valuation_history.csv", index=False)
    asof_panel.to_csv(output_dir / "pit_valuation_asof_panel.csv", index=False)
    cache_log.to_csv(output_dir / "provider_cache_log.csv", index=False)
    valid = asof_panel[asof_panel["availability_valid"]] if not asof_panel.empty else asof_panel
    summary = {
        "source": SOURCE_NAME,
        "stocks_requested": int(len(stocks)),
        "rebalance_dates": int(len(rebalance_dates)),
        "history_rows": int(len(valuation_history)),
        "asof_rows": int(len(asof_panel)),
        "asof_coverage_ratio": float(len(valid) / len(asof_panel)) if len(asof_panel) else 0.0,
        "availability_violations": int((asof_panel["valuation_date"].notna() & ~asof_panel["availability_valid"]).sum())
        if not asof_panel.empty
        else 0,
        "market_cap_unit": "亿元, as returned by the provider",
        "limitation": "Provider valuation history is a current retrieval of historical series; raw responses are cached for audit.",
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe", default=str(DEFAULT_UNIVERSE))
    parser.add_argument("--rebalance-panel", default=str(DEFAULT_REBALANCE_PANEL))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE_DIR))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--throttle-seconds", type=float, default=0.15)
    parser.add_argument("--no-fetch", action="store_true")
    args = parser.parse_args()

    stocks = financial_source.load_universe(output_path(args.universe), args.limit)
    rebalance_dates = financial_source.load_rebalance_dates(output_path(args.rebalance_panel))
    history, cache_log = collect_valuations(
        stocks,
        output_path(args.cache_dir),
        fetch_missing=not args.no_fetch,
        workers=args.workers,
        throttle_seconds=args.throttle_seconds,
    )
    asof_panel = build_asof_panel(stocks, history, rebalance_dates)
    output_dir = output_path(args.output_dir)
    write_outputs(output_dir, history, asof_panel, cache_log, stocks, rebalance_dates)
    print(cache_log["status"].value_counts().to_string())
    print(f"history_rows={len(history)} asof_rows={len(asof_panel)}")
    print(f"artifacts={output_dir}")


if __name__ == "__main__":
    main()

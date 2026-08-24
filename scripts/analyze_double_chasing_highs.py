#!/usr/bin/env python3
"""Analyze whether sector momentum plus stock momentum buys near local highs."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.append(str(Path(__file__).resolve().parent))
from backtest_two_layer_sector_stock import ETF_POOL, build_sector_pools  # noqa: E402


OUTPUT_DIR = Path("lab/backtests/two_layer_sector_stock")
ANALYSIS_DIR = OUTPUT_DIR / "double_chasing_highs"
STOCK_CACHE = OUTPUT_DIR / "akshare_cache" / "stocks"
EXTERNAL_STOCK_CACHE = Path("lab/backtests/stock_momentum_validation/akshare_cache/stocks")
ETF_CACHE = OUTPUT_DIR / "akshare_cache" / "etfs"

HORIZONS = {
    "1m": 21,
    "3m": 63,
    "6m": 126,
}


def load_cache_field(cache_dir: Path, prefix: str, field: str) -> pd.DataFrame:
    values: dict[str, pd.Series] = {}
    for path in sorted(cache_dir.glob(f"{prefix}*.csv")):
        parts = path.stem.split("_")
        if prefix == "etf_":
            code = parts[1]
        else:
            symbol = parts[0]
            code = symbol[2:]
        df = pd.read_csv(path)
        if "date" not in df or field not in df:
            continue
        df["date"] = pd.to_datetime(df["date"])
        df[field] = pd.to_numeric(df[field], errors="coerce")
        values[code] = df.set_index("date")[field].sort_index()
    return pd.DataFrame(values).sort_index()


def load_price_cache(cache_dir: Path, prefix: str) -> pd.DataFrame:
    return load_cache_field(cache_dir, prefix, "close")


def merge_panels(primary: pd.DataFrame, secondary: pd.DataFrame) -> pd.DataFrame:
    columns = sorted(set(primary.columns) | set(secondary.columns))
    index = primary.index.union(secondary.index).sort_values()
    primary = primary.reindex(index=index, columns=columns)
    secondary = secondary.reindex(index=index, columns=columns)
    return primary.combine_first(secondary)


def month_end_index(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.Series(index, index=index).groupby(index.to_period("M")).tail(1).values)


def next_date(index: pd.DatetimeIndex, date: pd.Timestamp) -> pd.Timestamp | None:
    pos = index.searchsorted(date, side="right")
    if pos >= len(index):
        return None
    return index[pos]


def future_stats(series: pd.Series, entry_date: pd.Timestamp, horizon_days: int) -> dict[str, float]:
    valid = series.dropna()
    if entry_date not in valid.index:
        next_pos = valid.index.searchsorted(entry_date, side="left")
        if next_pos >= len(valid):
            return {}
        entry_date = valid.index[next_pos]
    pos = valid.index.get_loc(entry_date)
    if not isinstance(pos, (int, np.integer)):
        return {}
    end_pos = pos + horizon_days
    if end_pos >= len(valid):
        return {}
    path = valid.iloc[pos : end_pos + 1]
    entry = float(path.iloc[0])
    if not entry or math.isnan(entry):
        return {}
    future_high = float(path.max())
    future_low = float(path.min())
    denom = future_high - future_low
    future_range_position = (entry - future_low) / denom if denom > 0 else np.nan
    return {
        "forward_return": float(path.iloc[-1] / entry - 1.0),
        "max_drawdown": float(path.min() / entry - 1.0),
        "max_runup": float(path.max() / entry - 1.0),
        "future_range_position": float(future_range_position),
    }


def prior_features(close: pd.DataFrame) -> pd.DataFrame:
    trailing_high_252 = close.rolling(252, min_periods=126).max()
    trailing_low_252 = close.rolling(252, min_periods=126).min()
    trailing_range = trailing_high_252 - trailing_low_252
    out = {
        "momentum_252_skip20": close.shift(20) / close.shift(252) - 1.0,
        "ret_63": close / close.shift(63) - 1.0,
        "ret_126": close / close.shift(126) - 1.0,
        "ret_252": close / close.shift(252) - 1.0,
        "dist_to_252d_high": close / trailing_high_252 - 1.0,
        "trailing_252d_range_position": (close - trailing_low_252) / trailing_range,
    }
    return pd.concat(out, axis=1)


def parse_selection_log(path: Path) -> pd.DataFrame:
    log = pd.read_csv(path, dtype={"etf": str, "chosen_codes": str})
    log["date"] = pd.to_datetime(log["date"])
    log["chosen_codes"] = log["chosen_codes"].fillna("")
    rows = []
    for row in log.itertuples(index=False):
        for rank, code in enumerate(str(row.chosen_codes).split(","), start=1):
            code = code.strip()
            if not code:
                continue
            rows.append(
                {
                    "signal_date": row.date,
                    "etf": row.etf,
                    "etf_name": row.etf_name,
                    "rank_in_sector": rank,
                    "code": code,
                    "candidate_count": row.candidate_count,
                    "valid_count": row.valid_count,
                }
            )
    return pd.DataFrame(rows)


def rank_bucket(rank: int) -> str:
    if rank <= 5:
        return "top5"
    if rank <= 20:
        return "rank6_20"
    return "rank21_plus"


def summarize_bool(series: pd.Series) -> float:
    series = series.dropna()
    return float(series.mean()) if len(series) else np.nan


def main() -> None:
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    stock_close = merge_panels(
        load_price_cache(STOCK_CACHE, prefix=""),
        load_price_cache(EXTERNAL_STOCK_CACHE, prefix=""),
    )
    stock_amount = merge_panels(
        load_cache_field(STOCK_CACHE, prefix="", field="amount"),
        load_cache_field(EXTERNAL_STOCK_CACHE, prefix="", field="amount"),
    ).reindex(stock_close.index)
    etf_close = load_price_cache(ETF_CACHE, prefix="etf_")
    trading_index = etf_close.index
    selected = parse_selection_log(OUTPUT_DIR / "stock_selection_log.csv")
    features = prior_features(stock_close)
    stock_scores = stock_close.shift(20) / stock_close.shift(252) - 1.0
    avg_amount = stock_amount.rolling(20, min_periods=10).mean()
    pools, _ = build_sector_pools(OUTPUT_DIR / "akshare_cache")

    rows = []
    for row in selected.itertuples(index=False):
        signal_date = pd.Timestamp(row.signal_date)
        if signal_date not in trading_index:
            continue
        entry_date = next_date(trading_index, signal_date)
        if entry_date is None or row.code not in stock_close or row.etf not in etf_close:
            continue

        record = {
            "signal_date": signal_date.date().isoformat(),
            "entry_date": entry_date.date().isoformat(),
            "etf": row.etf,
            "etf_name": row.etf_name,
            "code": row.code,
            "rank_in_sector": row.rank_in_sector,
            "candidate_count": row.candidate_count,
            "valid_count": row.valid_count,
        }
        for name in [
            "momentum_252_skip20",
            "ret_63",
            "ret_126",
            "ret_252",
            "dist_to_252d_high",
            "trailing_252d_range_position",
        ]:
            try:
                record[name] = float(features.loc[signal_date, (name, row.code)])
            except Exception:  # noqa: BLE001
                record[name] = np.nan

        stock_series = stock_close[row.code]
        etf_series = etf_close[row.etf]
        for label, days in HORIZONS.items():
            stock_stats = future_stats(stock_series, entry_date, days)
            etf_stats = future_stats(etf_series, entry_date, days)
            if stock_stats:
                for key, value in stock_stats.items():
                    record[f"{label}_{key}"] = value
            if stock_stats and etf_stats:
                record[f"{label}_excess_vs_etf"] = stock_stats["forward_return"] - etf_stats["forward_return"]
                record[f"{label}_underperform_etf"] = stock_stats["forward_return"] < etf_stats["forward_return"]
        rows.append(record)

    events = pd.DataFrame(rows)
    events.to_csv(ANALYSIS_DIR / "selected_top5_event_stats.csv", index=False)

    candidate_rows = []
    selection_points = pd.read_csv(OUTPUT_DIR / "stock_selection_log.csv", dtype={"etf": str})
    selection_points["date"] = pd.to_datetime(selection_points["date"])
    for row in selection_points.itertuples(index=False):
        signal_date = pd.Timestamp(row.date)
        entry_date = next_date(trading_index, signal_date)
        if entry_date is None or row.etf not in etf_close:
            continue
        pool = pools.get(row.etf, pd.DataFrame())
        codes = [code for code in pool.get("code", []) if code in stock_close.columns]
        if not codes:
            continue
        sample = pd.DataFrame(
            {
                "score": stock_scores.loc[signal_date, codes],
                "amount": avg_amount.loc[signal_date, codes],
            }
        ).dropna()
        sample = sample[sample["amount"] >= 30_000_000]
        ranked = sample["score"].sort_values(ascending=False)
        etf_stats = {label: future_stats(etf_close[row.etf], entry_date, days) for label, days in HORIZONS.items()}
        for rank, (code, score) in enumerate(ranked.items(), start=1):
            record = {
                "signal_date": signal_date.date().isoformat(),
                "entry_date": entry_date.date().isoformat(),
                "etf": row.etf,
                "etf_name": row.etf_name,
                "code": code,
                "momentum_rank": rank,
                "rank_bucket": rank_bucket(rank),
                "score": float(score),
            }
            try:
                record["dist_to_252d_high"] = float(features.loc[signal_date, ("dist_to_252d_high", code)])
                record["trailing_252d_range_position"] = float(features.loc[signal_date, ("trailing_252d_range_position", code)])
            except Exception:  # noqa: BLE001
                record["dist_to_252d_high"] = np.nan
                record["trailing_252d_range_position"] = np.nan
            for label, days in HORIZONS.items():
                stock_stats = future_stats(stock_close[code], entry_date, days)
                if stock_stats:
                    for key, value in stock_stats.items():
                        record[f"{label}_{key}"] = value
                if stock_stats and etf_stats[label]:
                    record[f"{label}_excess_vs_etf"] = stock_stats["forward_return"] - etf_stats[label]["forward_return"]
            candidate_rows.append(record)
    candidates = pd.DataFrame(candidate_rows)
    candidates.to_csv(ANALYSIS_DIR / "candidate_rank_event_stats.csv", index=False)

    summary_rows = []
    for label in HORIZONS:
        valid = events.dropna(subset=[f"{label}_forward_return"])
        summary_rows.append(
            {
                "horizon": label,
                "events": int(len(valid)),
                "avg_forward_return": float(valid[f"{label}_forward_return"].mean()),
                "median_forward_return": float(valid[f"{label}_forward_return"].median()),
                "positive_forward_rate": summarize_bool(valid[f"{label}_forward_return"] > 0),
                "avg_excess_vs_etf": float(valid[f"{label}_excess_vs_etf"].mean()),
                "median_excess_vs_etf": float(valid[f"{label}_excess_vs_etf"].median()),
                "beat_etf_rate": summarize_bool(valid[f"{label}_excess_vs_etf"] > 0),
                "avg_max_drawdown": float(valid[f"{label}_max_drawdown"].mean()),
                "median_max_drawdown": float(valid[f"{label}_max_drawdown"].median()),
                "drawdown_worse_10pct_rate": summarize_bool(valid[f"{label}_max_drawdown"] <= -0.10),
                "entry_in_future_top20_rate": summarize_bool(valid[f"{label}_future_range_position"] >= 0.80),
                "entry_in_future_top10_rate": summarize_bool(valid[f"{label}_future_range_position"] >= 0.90),
                "low_runup_lt_5pct_rate": summarize_bool(valid[f"{label}_max_runup"] < 0.05),
            }
        )
    summary = pd.DataFrame(summary_rows)
    summary.to_csv(ANALYSIS_DIR / "summary_by_horizon.csv", index=False)

    prior_summary = {
        "events": int(len(events)),
        "near_trailing_252d_high_within_5pct_rate": summarize_bool(events["dist_to_252d_high"] >= -0.05),
        "near_trailing_252d_high_within_10pct_rate": summarize_bool(events["dist_to_252d_high"] >= -0.10),
        "trailing_range_top20_rate": summarize_bool(events["trailing_252d_range_position"] >= 0.80),
        "trailing_range_top10_rate": summarize_bool(events["trailing_252d_range_position"] >= 0.90),
        "avg_momentum_252_skip20": float(events["momentum_252_skip20"].mean()),
        "median_momentum_252_skip20": float(events["momentum_252_skip20"].median()),
        "avg_ret_63": float(events["ret_63"].mean()),
        "avg_ret_126": float(events["ret_126"].mean()),
        "avg_ret_252": float(events["ret_252"].mean()),
    }

    worst = events.sort_values("3m_excess_vs_etf").head(20)
    worst.to_csv(ANALYSIS_DIR / "worst_3m_excess_events.csv", index=False)
    by_sector = (
        events.groupby(["etf", "etf_name"])
        .agg(
            events=("code", "count"),
            avg_3m_excess=("3m_excess_vs_etf", "mean"),
            beat_3m_rate=("3m_excess_vs_etf", lambda x: float((x > 0).mean())),
            avg_3m_dd=("3m_max_drawdown", "mean"),
            future_top20_3m_rate=("3m_future_range_position", lambda x: float((x >= 0.8).mean())),
            near_252d_high_5pct_rate=("dist_to_252d_high", lambda x: float((x >= -0.05).mean())),
        )
        .reset_index()
    )
    by_sector.to_csv(ANALYSIS_DIR / "summary_by_sector.csv", index=False)

    candidate_summary = (
        candidates.groupby("rank_bucket")
        .agg(
            events=("code", "count"),
            avg_score=("score", "mean"),
            avg_3m_return=("3m_forward_return", "mean"),
            median_3m_return=("3m_forward_return", "median"),
            positive_3m_rate=("3m_forward_return", lambda x: float((x > 0).mean())),
            avg_3m_excess=("3m_excess_vs_etf", "mean"),
            median_3m_excess=("3m_excess_vs_etf", "median"),
            beat_3m_etf_rate=("3m_excess_vs_etf", lambda x: float((x > 0).mean())),
            avg_3m_dd=("3m_max_drawdown", "mean"),
            dd_worse_10pct_3m_rate=("3m_max_drawdown", lambda x: float((x <= -0.10).mean())),
            entry_future_top20_3m_rate=("3m_future_range_position", lambda x: float((x >= 0.80).mean())),
            near_252d_high_5pct_rate=("dist_to_252d_high", lambda x: float((x >= -0.05).mean())),
        )
        .reindex(["top5", "rank6_20", "rank21_plus"])
        .reset_index()
    )
    candidate_summary.to_csv(ANALYSIS_DIR / "candidate_rank_bucket_summary.csv", index=False)

    payload = {
        "definition": {
            "event": "A stock selected as Top5 within a first-layer winning sector on a month-end signal date.",
            "entry": "Next trading day after the signal date.",
            "future_range_position": "0 means entry near future low, 1 means entry near future high over the future window.",
        },
        "prior_summary": prior_summary,
        "summary_by_horizon": summary.to_dict("records"),
        "artifacts": {
            "events": str(ANALYSIS_DIR / "selected_top5_event_stats.csv"),
            "summary_by_horizon": str(ANALYSIS_DIR / "summary_by_horizon.csv"),
            "summary_by_sector": str(ANALYSIS_DIR / "summary_by_sector.csv"),
            "worst_3m_excess_events": str(ANALYSIS_DIR / "worst_3m_excess_events.csv"),
            "candidate_rank_events": str(ANALYSIS_DIR / "candidate_rank_event_stats.csv"),
            "candidate_rank_bucket_summary": str(ANALYSIS_DIR / "candidate_rank_bucket_summary.csv"),
        },
        "candidate_rank_bucket_summary": candidate_summary.to_dict("records"),
    }
    (ANALYSIS_DIR / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

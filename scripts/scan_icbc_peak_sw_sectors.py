#!/usr/bin/env python3
"""Scan SW first-level sectors after ICBC confirmed peaks."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from qlib_validate_icbc_peak_rotation import PEAK_PARAMS, detect_confirmed_peaks, load_ohlcv  # noqa: E402


ICBC_PATH = ROOT / "lab/backtests/two_layer_sector_stock/akshare_cache/stocks/sh601398_20150101_20260717_qfq.csv"
SW_PATH = ROOT / "lab/backtests/sw_sector_cycle_analysis/sw_first_level_daily_bars.csv"
OUTPUT_DIR = ROOT / "lab/backtests/icbc_peak_sw_sector_scan"
START_DATE = pd.Timestamp("2016-01-01")
HORIZONS = (10, 20, 30)
VARIANT_LABELS = {
    "oracle_peak": "峰值当日入场(事后上限)",
    "confirmed_next": "确认后次日入场(可执行)",
}


def binomial_tail(successes: int, trials: int, p: float) -> float:
    if trials <= 0:
        return math.nan
    p = min(max(p, 0.0), 1.0)
    total = 0.0
    for hits in range(successes, trials + 1):
        total += math.comb(trials, hits) * (p**hits) * ((1.0 - p) ** (trials - hits))
    return total


def load_sw_panel(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path)
    frame["date"] = pd.to_datetime(frame["date"])
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    frame = frame.loc[frame["date"] >= START_DATE, ["date", "code", "name", "close"]].dropna()
    return frame.sort_values(["code", "date"]).drop_duplicates(["code", "date"])


def get_exit_date(index: pd.Index, entry_date: pd.Timestamp, horizon: int) -> pd.Timestamp | None:
    if entry_date not in index:
        return None
    loc = int(index.get_loc(entry_date))
    if loc + horizon >= len(index):
        return None
    return pd.Timestamp(index[loc + horizon])


def build_baseline_metrics(sector_series: pd.Series, icbc_series: pd.Series, horizon: int) -> tuple[pd.Series, pd.Series]:
    future_sector = sector_series.shift(-horizon) / sector_series - 1.0
    future_icbc = icbc_series.shift(-horizon) / icbc_series - 1.0
    aligned = pd.concat({"sector_ret": future_sector, "icbc_ret": future_icbc}, axis=1).dropna()
    return aligned["sector_ret"], aligned["sector_ret"] - aligned["icbc_ret"]


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    icbc = load_ohlcv(ICBC_PATH).set_index("date")["close"]
    peaks = detect_confirmed_peaks(icbc, PEAK_PARAMS)
    peaks = peaks.loc[pd.to_datetime(peaks["date"]) >= START_DATE].copy()
    if peaks.empty:
        raise SystemExit("No ICBC peaks found after 2016-01-01.")

    sw = load_sw_panel(SW_PATH)
    icbc = icbc.loc[icbc.index >= START_DATE]

    event_rows: list[dict[str, object]] = []
    summary_rows: list[dict[str, object]] = []

    for code, sector in sw.groupby("code", sort=True):
        sector = sector.sort_values("date")
        name = str(sector["name"].iloc[0])
        sector_close = sector.set_index("date")["close"]
        joint_dates = sector_close.index.intersection(icbc.index)
        if len(joint_dates) < 200:
            continue
        sector_close = sector_close.loc[joint_dates]
        icbc_close = icbc.loc[joint_dates]

        for variant, label in VARIANT_LABELS.items():
            variant_events = []
            for _, peak in peaks.iterrows():
                entry_date = pd.Timestamp(peak["date"]) if variant == "oracle_peak" else pd.Timestamp(peak["executable_entry_date"])
                peak_date = pd.Timestamp(peak["date"])
                if entry_date not in joint_dates:
                    continue
                for horizon in HORIZONS:
                    exit_date = get_exit_date(joint_dates, entry_date, horizon)
                    if exit_date is None:
                        continue
                    sector_ret = float(sector_close.at[exit_date] / sector_close.at[entry_date] - 1.0)
                    icbc_ret = float(icbc_close.at[exit_date] / icbc_close.at[entry_date] - 1.0)
                    event_rows.append(
                        {
                            "code": code,
                            "name": name,
                            "variant": variant,
                            "variant_label": label,
                            "horizon_days": horizon,
                            "peak_date": peak_date.date().isoformat(),
                            "entry_date": entry_date.date().isoformat(),
                            "exit_date": exit_date.date().isoformat(),
                            "sector_return": sector_ret,
                            "icbc_return": icbc_ret,
                            "spread_vs_icbc": sector_ret - icbc_ret,
                            "sector_up": float(sector_ret > 0),
                            "outperform_icbc": float(sector_ret > icbc_ret),
                        }
                    )
                    variant_events.append((horizon, sector_ret, icbc_ret))

            event_df = pd.DataFrame([row for row in event_rows if row["code"] == code and row["variant"] == variant])
            if event_df.empty:
                continue

            for horizon in HORIZONS:
                current = event_df.loc[event_df["horizon_days"] == horizon].copy()
                if current.empty:
                    continue
                baseline_sector, baseline_spread = build_baseline_metrics(sector_close, icbc_close, horizon)
                up_success = int((current["sector_return"] > 0).sum())
                out_success = int((current["spread_vs_icbc"] > 0).sum())
                baseline_up = float((baseline_sector > 0).mean())
                baseline_out = float((baseline_spread > 0).mean())
                summary_rows.append(
                    {
                        "code": code,
                        "name": name,
                        "variant": variant,
                        "variant_label": label,
                        "horizon_days": horizon,
                        "event_count": int(len(current)),
                        "baseline_sample_count": int(len(baseline_sector)),
                        "event_up_rate": float((current["sector_return"] > 0).mean()),
                        "baseline_up_rate": baseline_up,
                        "event_outperform_rate": float((current["spread_vs_icbc"] > 0).mean()),
                        "baseline_outperform_rate": baseline_out,
                        "event_avg_return": float(current["sector_return"].mean()),
                        "baseline_avg_return": float(baseline_sector.mean()),
                        "event_avg_spread": float(current["spread_vs_icbc"].mean()),
                        "baseline_avg_spread": float(baseline_spread.mean()),
                        "up_rate_pvalue": binomial_tail(up_success, len(current), baseline_up),
                        "outperform_pvalue": binomial_tail(out_success, len(current), baseline_out),
                    }
                )

    events = pd.DataFrame(event_rows).sort_values(["variant", "horizon_days", "code", "entry_date"])
    summary = pd.DataFrame(summary_rows).sort_values(["variant", "horizon_days", "outperform_pvalue", "event_avg_spread"], ascending=[True, True, True, False])

    focus = summary.loc[(summary["variant"] == "confirmed_next") & (summary["horizon_days"] == 10)].copy()
    top_confirmed_10 = focus.sort_values(["outperform_pvalue", "event_avg_spread"], ascending=[True, False]).head(12)

    summary.to_csv(OUTPUT_DIR / "sector_summary.csv", index=False)
    events.to_csv(OUTPUT_DIR / "sector_event_returns.csv", index=False)
    top_confirmed_10.to_csv(OUTPUT_DIR / "top_confirmed_10d.csv", index=False)
    (OUTPUT_DIR / "summary.json").write_text(
        json.dumps(
            {
                "start_date": START_DATE.date().isoformat(),
                "peak_count": int(len(peaks)),
                "horizons": list(HORIZONS),
                "variants": VARIANT_LABELS,
                "sector_count": int(summary["code"].nunique()) if not summary.empty else 0,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    preview_cols = [
        "code",
        "name",
        "event_count",
        "event_up_rate",
        "event_outperform_rate",
        "event_avg_return",
        "event_avg_spread",
        "outperform_pvalue",
    ]
    with pd.option_context("display.max_rows", None, "display.max_columns", None, "display.width", 220):
        print(top_confirmed_10[preview_cols].to_string(index=False))


if __name__ == "__main__":
    main()

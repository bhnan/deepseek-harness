#!/usr/bin/env python3
"""Validate grouped SW sector handoff after ICBC confirmed peaks."""

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
OUTPUT_DIR = ROOT / "lab/backtests/icbc_peak_sector_groups"
START_DATE = pd.Timestamp("2016-01-01")
HORIZONS = (10, 20, 30)
VARIANT_LABELS = {
    "oracle_peak": "峰值当日入场(事后上限)",
    "confirmed_next": "确认后次日入场(可执行)",
}

GROUPS = {
    "growth_handoff": {
        "label": "成长接棒组",
        "members": ["801750", "801770", "801760", "801890"],
    },
    "repair_handoff": {
        "label": "修复接棒组",
        "members": ["801200", "801130", "801140"],
    },
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
    frame["code"] = frame["code"].astype(str)
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


def build_group_series(sw: pd.DataFrame, member_codes: list[str]) -> pd.Series:
    member_frames = []
    for code in member_codes:
        group = sw.loc[sw["code"] == code, ["date", "close"]].copy()
        if group.empty:
            raise ValueError(f"Missing sector code {code}")
        member_frames.append(group.set_index("date")["close"].rename(code))
    panel = pd.concat(member_frames, axis=1).dropna()
    return panel.mean(axis=1)


def summarize_variant(group_close: pd.Series, icbc_close: pd.Series, peaks: pd.DataFrame, variant: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    joint_dates = group_close.index.intersection(icbc_close.index)
    group_close = group_close.loc[joint_dates]
    icbc_close = icbc_close.loc[joint_dates]

    event_rows = []
    for _, peak in peaks.iterrows():
        entry_date = pd.Timestamp(peak["date"]) if variant == "oracle_peak" else pd.Timestamp(peak["executable_entry_date"])
        if entry_date not in joint_dates:
            continue
        for horizon in HORIZONS:
            exit_date = get_exit_date(joint_dates, entry_date, horizon)
            if exit_date is None:
                continue
            group_ret = float(group_close.at[exit_date] / group_close.at[entry_date] - 1.0)
            icbc_ret = float(icbc_close.at[exit_date] / icbc_close.at[entry_date] - 1.0)
            event_rows.append(
                {
                    "variant": variant,
                    "variant_label": VARIANT_LABELS[variant],
                    "horizon_days": horizon,
                    "peak_date": pd.Timestamp(peak["date"]).date().isoformat(),
                    "entry_date": entry_date.date().isoformat(),
                    "exit_date": exit_date.date().isoformat(),
                    "group_return": group_ret,
                    "icbc_return": icbc_ret,
                    "spread_vs_icbc": group_ret - icbc_ret,
                    "group_up": float(group_ret > 0),
                    "outperform_icbc": float(group_ret > icbc_ret),
                }
            )

    events = pd.DataFrame(event_rows)
    if events.empty:
        return events, pd.DataFrame()

    summary_rows = []
    for horizon in HORIZONS:
        current = events.loc[events["horizon_days"] == horizon].copy()
        future_group = group_close.shift(-horizon) / group_close - 1.0
        future_icbc = icbc_close.shift(-horizon) / icbc_close - 1.0
        baseline = pd.concat({"group_ret": future_group, "icbc_ret": future_icbc}, axis=1).dropna()
        baseline["spread"] = baseline["group_ret"] - baseline["icbc_ret"]
        up_success = int((current["group_return"] > 0).sum())
        out_success = int((current["spread_vs_icbc"] > 0).sum())
        baseline_up = float((baseline["group_ret"] > 0).mean())
        baseline_out = float((baseline["spread"] > 0).mean())
        summary_rows.append(
            {
                "variant": variant,
                "variant_label": VARIANT_LABELS[variant],
                "horizon_days": horizon,
                "event_count": int(len(current)),
                "baseline_sample_count": int(len(baseline)),
                "event_up_rate": float((current["group_return"] > 0).mean()),
                "baseline_up_rate": baseline_up,
                "event_outperform_rate": float((current["spread_vs_icbc"] > 0).mean()),
                "baseline_outperform_rate": baseline_out,
                "event_avg_return": float(current["group_return"].mean()),
                "baseline_avg_return": float(baseline["group_ret"].mean()),
                "event_avg_spread": float(current["spread_vs_icbc"].mean()),
                "baseline_avg_spread": float(baseline["spread"].mean()),
                "up_rate_pvalue": binomial_tail(up_success, len(current), baseline_up),
                "outperform_pvalue": binomial_tail(out_success, len(current), baseline_out),
            }
        )
    return events, pd.DataFrame(summary_rows)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    icbc = load_ohlcv(ICBC_PATH).set_index("date")["close"]
    peaks = detect_confirmed_peaks(icbc, PEAK_PARAMS)
    peaks = peaks.loc[pd.to_datetime(peaks["date"]) >= START_DATE].copy()
    if peaks.empty:
        raise SystemExit("No peaks found.")

    sw = load_sw_panel(SW_PATH)
    icbc = icbc.loc[icbc.index >= START_DATE]

    all_events = []
    all_summary = []
    group_preview = []

    group_series_map = {}
    for group_key, group_spec in GROUPS.items():
        series = build_group_series(sw, group_spec["members"])
        group_series_map[group_key] = series
        for variant in VARIANT_LABELS:
            events, summary = summarize_variant(series, icbc, peaks, variant)
            if not events.empty:
                events.insert(0, "group_key", group_key)
                events.insert(1, "group_label", group_spec["label"])
                all_events.append(events)
            if not summary.empty:
                summary.insert(0, "group_key", group_key)
                summary.insert(1, "group_label", group_spec["label"])
                all_summary.append(summary)

    events = pd.concat(all_events, ignore_index=True).sort_values(["group_key", "variant", "horizon_days", "entry_date"])
    summary = pd.concat(all_summary, ignore_index=True).sort_values(["variant", "horizon_days", "outperform_pvalue", "event_avg_spread"])

    confirmed_10 = summary.loc[(summary["variant"] == "confirmed_next") & (summary["horizon_days"] == 10)].copy()
    if len(confirmed_10) == 2:
        growth = confirmed_10.loc[confirmed_10["group_key"] == "growth_handoff"].iloc[0]
        repair = confirmed_10.loc[confirmed_10["group_key"] == "repair_handoff"].iloc[0]
        group_preview.append(
            {
                "winner_metric": "10d confirmed_next event_avg_spread",
                "winner_group": growth["group_label"] if growth["event_avg_spread"] > repair["event_avg_spread"] else repair["group_label"],
                "growth_spread": float(growth["event_avg_spread"]),
                "repair_spread": float(repair["event_avg_spread"]),
            }
        )

    pair_rows = []
    growth_events = events.loc[(events["group_key"] == "growth_handoff") & (events["variant"] == "confirmed_next")]
    repair_events = events.loc[(events["group_key"] == "repair_handoff") & (events["variant"] == "confirmed_next")]
    merged = growth_events.merge(
        repair_events,
        on=["variant", "variant_label", "horizon_days", "peak_date", "entry_date", "exit_date"],
        suffixes=("_growth", "_repair"),
    )
    for horizon, group in merged.groupby("horizon_days"):
        pair_rows.append(
            {
                "variant": "confirmed_next",
                "horizon_days": int(horizon),
                "sample_count": int(len(group)),
                "growth_beat_repair_rate": float((group["group_return_growth"] > group["group_return_repair"]).mean()),
                "growth_avg_minus_repair": float((group["group_return_growth"] - group["group_return_repair"]).mean()),
                "growth_median_minus_repair": float((group["group_return_growth"] - group["group_return_repair"]).median()),
            }
        )
    pair_summary = pd.DataFrame(pair_rows)

    events.to_csv(OUTPUT_DIR / "group_event_returns.csv", index=False)
    summary.to_csv(OUTPUT_DIR / "group_summary.csv", index=False)
    pair_summary.to_csv(OUTPUT_DIR / "growth_vs_repair.csv", index=False)
    (OUTPUT_DIR / "summary.json").write_text(
        json.dumps(
            {
                "start_date": START_DATE.date().isoformat(),
                "peak_count": int(len(peaks)),
                "groups": GROUPS,
                "horizons": list(HORIZONS),
                "preview": group_preview,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    preview = summary.loc[
        summary["variant"] == "confirmed_next",
        [
            "group_label",
            "horizon_days",
            "event_count",
            "event_up_rate",
            "event_outperform_rate",
            "event_avg_return",
            "event_avg_spread",
            "outperform_pvalue",
        ],
    ]
    with pd.option_context("display.max_rows", None, "display.max_columns", None, "display.width", 220):
        print(preview.to_string(index=False))
        print()
        print(pair_summary.to_string(index=False))


if __name__ == "__main__":
    main()

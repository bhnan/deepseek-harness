#!/usr/bin/env python3
"""Validate whether confirmed ICBC peaks are followed by semiconductor strength."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/icbc_peak_semiconductor_rotation"
DEFAULT_REPORT_PATH = ROOT / "docs/research/icbc-peak-semiconductor-rotation-validation.md"

ICBC_PATH = ROOT / "lab/backtests/two_layer_sector_stock/akshare_cache/stocks/sh601398_20150101_20260717_qfq.csv"
ETF_DIR = ROOT / "lab/backtests/sector_etf_rotation_2015_dynamic_top1/akshare_cache"


@dataclass(frozen=True)
class PeakParams:
    left_window: int = 15
    right_window: int = 15
    pre_window: int = 20
    min_pre_return: float = 0.04
    confirm_window: int = 15
    min_future_drawdown: float = 0.03
    duplicate_window: int = 5
    min_spacing_days: int = 15


@dataclass(frozen=True)
class ProxySpec:
    key: str
    label: str
    series_key: str
    start_date: str


PROXY_SPECS = [
    ProxySpec("semi", "半导体ETF 512480", "semi", "2019-06-12"),
    ProxySpec("chip", "芯片ETF 159995", "chip", "2020-02-10"),
    ProxySpec("tech_basket", "科技等权篮子", "tech_basket", "2020-04-13"),
]

TECH_BASKET_MEMBERS = {
    "semi": ("512480", "半导体ETF"),
    "chip": ("159995", "芯片ETF"),
    "computer": ("159998", "计算机ETF"),
    "5g": ("515050", "5GETF"),
}

HORIZONS = [5, 10, 20]


def pct(value: float | None, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value * 100:.{digits}f}%"


def load_close(path: Path) -> pd.Series:
    frame = pd.read_csv(path)
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame[["date", "close"]].sort_values("date").drop_duplicates("date")
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    return frame.set_index("date")["close"].dropna()


def load_etf(code: str) -> pd.Series:
    return load_close(ETF_DIR / f"etf_{code}_20150101_20260717_sina.csv")


def detect_confirmed_peaks(close: pd.Series, params: PeakParams) -> pd.DataFrame:
    values = close.to_numpy(dtype=float)
    dates = close.index
    rows: list[dict[str, object]] = []
    start = max(params.left_window, params.pre_window)
    end = len(close) - params.right_window
    for idx in range(start, end):
        price = values[idx]
        if not np.isfinite(price):
            continue
        window = values[idx - params.left_window : idx + params.right_window + 1]
        if np.nanmax(window) != price:
            continue
        dup_left = max(0, idx - params.duplicate_window)
        dup_right = min(len(values), idx + params.duplicate_window + 1)
        if int(np.sum(values[dup_left:dup_right] == price)) > 1:
            continue
        pre_ret = price / values[idx - params.pre_window] - 1.0
        future = values[idx + 1 : idx + 1 + params.confirm_window]
        if len(future) < params.confirm_window:
            continue
        future_min = np.nanmin(future)
        future_min_idx = idx + 1 + int(np.nanargmin(future))
        future_drawdown = future_min / price - 1.0
        if pre_ret < params.min_pre_return or future_drawdown > -params.min_future_drawdown:
            continue
        rows.append(
            {
                "date": dates[idx],
                "close": float(price),
                "pre_window_close": float(values[idx - params.pre_window]),
                "pre_window_return": float(pre_ret),
                "future_min_close": float(future_min),
                "future_min_date": dates[future_min_idx],
                "future_drawdown": float(future_drawdown),
            }
        )

    if not rows:
        return pd.DataFrame(columns=["date", "close", "pre_window_close", "pre_window_return", "future_min_close", "future_min_date", "future_drawdown"])

    filtered: list[dict[str, object]] = []
    for row in rows:
        if not filtered:
            filtered.append(row)
            continue
        prev = filtered[-1]
        if (row["date"] - prev["date"]).days <= params.min_spacing_days:
            if float(row["close"]) >= float(prev["close"]):
                filtered[-1] = row
        else:
            filtered.append(row)
    return pd.DataFrame(filtered)


def build_proxy_panel() -> pd.DataFrame:
    panel = {"icbc": load_close(ICBC_PATH)}
    for key, (code, _label) in TECH_BASKET_MEMBERS.items():
        panel[key] = load_etf(code)
    frame = pd.concat(panel, axis=1).sort_index()
    frame["tech_basket"] = frame[list(TECH_BASKET_MEMBERS.keys())].mean(axis=1)
    return frame


def compute_event_rows(panel: pd.DataFrame, peaks: pd.DataFrame, proxy: ProxySpec) -> pd.DataFrame:
    aligned = panel[["icbc", proxy.series_key]].dropna()
    aligned = aligned.loc[pd.to_datetime(proxy.start_date) :]
    peak_dates = [date for date in pd.to_datetime(peaks["date"]) if date in aligned.index]
    rows: list[dict[str, object]] = []
    for event_date in peak_dates:
        idx = int(aligned.index.get_loc(event_date))
        row: dict[str, object] = {
            "proxy_key": proxy.key,
            "proxy_label": proxy.label,
            "event_date": event_date.date().isoformat(),
            "icbc_close": float(aligned.at[event_date, "icbc"]),
            "proxy_close": float(aligned.at[event_date, proxy.series_key]),
        }
        for horizon in HORIZONS:
            if idx + horizon >= len(aligned):
                row[f"icbc_{horizon}d"] = np.nan
                row[f"proxy_{horizon}d"] = np.nan
                row[f"spread_{horizon}d"] = np.nan
                row[f"bank_down_proxy_up_{horizon}d"] = np.nan
                row[f"proxy_outperform_{horizon}d"] = np.nan
                continue
            icbc_ret = float(aligned["icbc"].iloc[idx + horizon] / aligned["icbc"].iloc[idx] - 1.0)
            proxy_ret = float(aligned[proxy.series_key].iloc[idx + horizon] / aligned[proxy.series_key].iloc[idx] - 1.0)
            row[f"icbc_{horizon}d"] = icbc_ret
            row[f"proxy_{horizon}d"] = proxy_ret
            row[f"spread_{horizon}d"] = proxy_ret - icbc_ret
            row[f"bank_down_proxy_up_{horizon}d"] = float(icbc_ret < 0 and proxy_ret > 0)
            row[f"proxy_outperform_{horizon}d"] = float(proxy_ret > icbc_ret)
        rows.append(row)
    return pd.DataFrame(rows)


def binomial_tail(successes: int, trials: int, p: float) -> float:
    if trials <= 0:
        return math.nan
    p = min(max(p, 0.0), 1.0)
    total = 0.0
    for hits in range(successes, trials + 1):
        total += math.comb(trials, hits) * (p**hits) * ((1.0 - p) ** (trials - hits))
    return total


def summarize_proxy(panel: pd.DataFrame, peaks: pd.DataFrame, proxy: ProxySpec) -> pd.DataFrame:
    aligned = panel[["icbc", proxy.series_key]].dropna()
    aligned = aligned.loc[pd.to_datetime(proxy.start_date) :]
    peak_dates = [date for date in pd.to_datetime(peaks["date"]) if date in aligned.index]
    rows: list[dict[str, object]] = []
    for horizon in HORIZONS:
        future = pd.DataFrame(index=aligned.index)
        future["icbc_ret"] = aligned["icbc"].shift(-horizon) / aligned["icbc"] - 1.0
        future["proxy_ret"] = aligned[proxy.series_key].shift(-horizon) / aligned[proxy.series_key] - 1.0
        future["spread"] = future["proxy_ret"] - future["icbc_ret"]
        future = future.dropna()
        events = future.loc[peak_dates].dropna()
        both_mask = (future["icbc_ret"] < 0) & (future["proxy_ret"] > 0)
        out_mask = future["proxy_ret"] > future["icbc_ret"]
        event_both_mask = (events["icbc_ret"] < 0) & (events["proxy_ret"] > 0)
        event_out_mask = events["proxy_ret"] > events["icbc_ret"]
        baseline_both = float(both_mask.mean()) if len(future) else math.nan
        baseline_out = float(out_mask.mean()) if len(future) else math.nan
        event_both = float(event_both_mask.mean()) if len(events) else math.nan
        event_out = float(event_out_mask.mean()) if len(events) else math.nan
        both_success = int(event_both_mask.sum())
        out_success = int(event_out_mask.sum())
        rows.append(
            {
                "proxy_key": proxy.key,
                "proxy_label": proxy.label,
                "horizon_days": horizon,
                "event_count": int(len(events)),
                "sample_count": int(len(future)),
                "baseline_bank_down_proxy_up": baseline_both,
                "event_bank_down_proxy_up": event_both,
                "bank_down_proxy_up_successes": both_success,
                "bank_down_proxy_up_pvalue": binomial_tail(both_success, len(events), baseline_both) if len(events) else math.nan,
                "baseline_proxy_outperform": baseline_out,
                "event_proxy_outperform": event_out,
                "proxy_outperform_successes": out_success,
                "proxy_outperform_pvalue": binomial_tail(out_success, len(events), baseline_out) if len(events) else math.nan,
                "event_avg_spread": float(events["spread"].mean()) if len(events) else math.nan,
                "baseline_avg_spread": float(future["spread"].mean()) if len(future) else math.nan,
                "event_median_spread": float(events["spread"].median()) if len(events) else math.nan,
                "spread_pctile_vs_baseline": float((future["spread"] <= events["spread"].mean()).mean()) if len(events) and len(future) else math.nan,
            }
        )
    return pd.DataFrame(rows)


def markdown_table(frame: pd.DataFrame) -> str:
    if frame.empty:
        return "无数据。"
    return frame.to_markdown(index=False)


def format_pvalue(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "NA"
    if value < 1e-4:
        return f"{value:.2e}"
    return f"{value:.4f}"


def render_report(peaks: pd.DataFrame, events: pd.DataFrame, summary: pd.DataFrame, params: PeakParams) -> str:
    peak_view = peaks.copy()
    peak_view["date"] = pd.to_datetime(peak_view["date"]).dt.date.astype(str)
    peak_view["future_min_date"] = pd.to_datetime(peak_view["future_min_date"]).dt.date.astype(str)
    peak_view["pre_window_return"] = peak_view["pre_window_return"].map(pct)
    peak_view["future_drawdown"] = peak_view["future_drawdown"].map(pct)

    focus_cols = [
        "proxy_label",
        "horizon_days",
        "event_count",
        "baseline_bank_down_proxy_up",
        "event_bank_down_proxy_up",
        "bank_down_proxy_up_pvalue",
        "baseline_proxy_outperform",
        "event_proxy_outperform",
        "proxy_outperform_pvalue",
        "event_avg_spread",
        "baseline_avg_spread",
        "spread_pctile_vs_baseline",
    ]
    summary_view = summary[focus_cols].copy()
    for col in [
        "baseline_bank_down_proxy_up",
        "event_bank_down_proxy_up",
        "baseline_proxy_outperform",
        "event_proxy_outperform",
        "event_avg_spread",
        "baseline_avg_spread",
        "spread_pctile_vs_baseline",
    ]:
        summary_view[col] = summary_view[col].map(pct)
    for col in ["bank_down_proxy_up_pvalue", "proxy_outperform_pvalue"]:
        summary_view[col] = summary_view[col].map(format_pvalue)

    recent = events[events["proxy_key"].isin(["semi", "chip"])].copy()
    if not recent.empty:
        recent = (
            recent.sort_values(["proxy_key", "event_date"])
            .groupby("proxy_key", group_keys=False)
            .tail(3)
            .reset_index(drop=True)
        )
    if not recent.empty:
        for col in [c for c in recent.columns if c.endswith("5d") or c.endswith("10d") or c.endswith("20d")]:
            if col.startswith("bank_down") or col.startswith("proxy_outperform"):
                continue
            recent[col] = recent[col].map(pct)

    lines = [
        "# 工商银行阶段顶后半导体轮动验证",
        "",
        "## 固定定义",
        "",
        f"- 前 {params.pre_window} 个交易日涨幅至少 {pct(params.min_pre_return, 0)}。",
        f"- 当天是前后各 {params.left_window}/{params.right_window} 个交易日窗口里的唯一最高收盘。",
        f"- 后 {params.confirm_window} 个交易日最大回撤至少 {pct(params.min_future_drawdown, 0)}，才算已确认阶段顶。",
        f"- 相邻 {params.min_spacing_days} 个自然日内若出现重复候选，只保留更高的那个点。",
        "",
        "## 样本范围",
        "",
        "- 工商银行高点识别使用 2015-01-05 到 2026-07-17 的本地前复权日线。",
        "- 半导体ETF验证从 2019-06-12 开始。",
        "- 芯片ETF验证从 2020-02-10 开始。",
        "- 科技等权篮子验证从 2020-04-13 开始，成员是半导体ETF、芯片ETF、计算机ETF、5GETF。",
        "",
        "## 工商银行已确认阶段顶",
        "",
        markdown_table(peak_view[["date", "close", "pre_window_close", "pre_window_return", "future_min_date", "future_min_close", "future_drawdown"]]),
        "",
        "## 置信度汇总",
        "",
        markdown_table(summary_view),
    ]
    if not recent.empty:
        lines.extend(
            [
                "",
                "## 近一年三个关注样本",
                "",
                markdown_table(
                    recent[[
                        "proxy_label",
                        "event_date",
                        "icbc_5d",
                        "proxy_5d",
                        "spread_5d",
                        "icbc_10d",
                        "proxy_10d",
                        "spread_10d",
                        "icbc_20d",
                        "proxy_20d",
                        "spread_20d",
                    ]]
                ),
            ]
        )
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--report-path", type=Path, default=DEFAULT_REPORT_PATH)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.report_path.parent.mkdir(parents=True, exist_ok=True)

    params = PeakParams()
    panel = build_proxy_panel()
    peaks = detect_confirmed_peaks(panel["icbc"].dropna(), params)

    event_frames = []
    summary_frames = []
    for proxy in PROXY_SPECS:
        event_frames.append(compute_event_rows(panel, peaks, proxy))
        summary_frames.append(summarize_proxy(panel, peaks, proxy))

    events = pd.concat(event_frames, ignore_index=True)
    summary = pd.concat(summary_frames, ignore_index=True)

    peaks.to_csv(args.output_dir / "confirmed_peaks.csv", index=False)
    events.to_csv(args.output_dir / "event_returns.csv", index=False)
    summary.to_csv(args.output_dir / "summary.csv", index=False)
    (args.output_dir / "summary.json").write_text(
        json.dumps(
            {
                "peak_params": asdict(params),
                "peak_count_total": int(len(peaks)),
                "peaks_since_2019_06_12": int((pd.to_datetime(peaks["date"]) >= pd.Timestamp("2019-06-12")).sum()),
                "peaks_since_2020_02_10": int((pd.to_datetime(peaks["date"]) >= pd.Timestamp("2020-02-10")).sum()),
                "proxies": [asdict(proxy) for proxy in PROXY_SPECS],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    args.report_path.write_text(render_report(peaks, events, summary, params), encoding="utf-8")

    print(f"peaks={len(peaks)}")
    print(f"output_dir={args.output_dir}")
    print(f"report_path={args.report_path}")


if __name__ == "__main__":
    main()

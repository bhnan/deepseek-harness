#!/usr/bin/env python3
"""Analyze SW sector indices with daily structural intervals."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

import matplotlib.font_manager as fm
import matplotlib.patches as patches
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np
import pandas as pd


INPUT_BARS = Path("lab/backtests/sw_sector_cycle_analysis/sw_first_level_daily_bars.csv")
OUTPUT_DIR = Path("lab/backtests/sw_sector_daily_structure_analysis")
CHART_DIR = OUTPUT_DIR / "structure_charts"
REPORT_PATH = Path("docs/research/sw-sector-daily-structure-analysis-report.md")
COMPACT_REPORT_PATH = Path("docs/research/sw-sector-daily-structure-analysis-report-compact.md")
TRADING_DAYS_PER_YEAR = 244


@dataclass(frozen=True)
class StructureParams:
    zigzag_threshold: float = 0.10
    min_pivot_gap_days: int = 10
    low_tolerance: float = 0.03
    min_major_days: int = 20


def setup_fonts() -> None:
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            fm.fontManager.addfont(path)
            plt.rcParams["font.family"] = fm.FontProperties(fname=path).get_name()
            break
    plt.rcParams["axes.unicode_minus"] = False


def pct(value: float | None, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value * 100:.{digits}f}%"


def num(value: float | int | None, digits: int = 1) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value:.{digits}f}"


def safe_name(text: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "_", text).strip("_")


def md_table(df: pd.DataFrame, columns: list[str] | None = None) -> str:
    if columns is not None:
        df = df[columns]
    if df.empty:
        return "无。"
    return df.to_markdown(index=False)


def load_bars() -> pd.DataFrame:
    bars = pd.read_csv(INPUT_BARS, dtype={"code": str})
    bars["date"] = pd.to_datetime(bars["date"])
    return bars.sort_values(["code", "date"]).reset_index(drop=True)


def max_drawdown(close: pd.Series) -> float:
    if close.empty:
        return math.nan
    return float((close / close.cummax() - 1.0).min())


def find_zigzag_pivots(daily: pd.DataFrame, params: StructureParams) -> pd.DataFrame:
    series = daily.set_index("date")["close"].dropna()
    if series.empty:
        return pd.DataFrame()

    dates = series.index.to_list()
    prices = series.to_numpy(dtype=float)
    pivots: list[dict] = []

    low_idx = high_idx = 0
    low_price = high_price = prices[0]
    state = "undetermined"
    peak_idx = trough_idx = 0
    peak_price = trough_price = prices[0]

    def append_pivot(kind: str, idx: int, confirm_idx: int, open_: bool = False) -> None:
        if pivots and pivots[-1]["type"] == kind:
            should_replace = (kind == "peak" and prices[idx] >= pivots[-1]["price"]) or (kind == "trough" and prices[idx] <= pivots[-1]["price"])
            if should_replace:
                pivots[-1] = {
                    "type": kind,
                    "idx": idx,
                    "date": dates[idx],
                    "price": float(prices[idx]),
                    "confirm_idx": confirm_idx,
                    "confirm_date": dates[confirm_idx],
                    "open": open_,
                }
            return
        pivots.append(
            {
                "type": kind,
                "idx": idx,
                "date": dates[idx],
                "price": float(prices[idx]),
                "confirm_idx": confirm_idx,
                "confirm_date": dates[confirm_idx],
                "open": open_,
            }
        )

    for i, price in enumerate(prices[1:], start=1):
        if state == "undetermined":
            if price < low_price:
                low_idx, low_price = i, price
            if price > high_price:
                high_idx, high_price = i, price
            if i - low_idx >= params.min_pivot_gap_days and price / low_price - 1.0 >= params.zigzag_threshold:
                append_pivot("trough", low_idx, i)
                state = "up"
                peak_idx, peak_price = i, price
            elif i - high_idx >= params.min_pivot_gap_days and price / high_price - 1.0 <= -params.zigzag_threshold:
                append_pivot("peak", high_idx, i)
                state = "down"
                trough_idx, trough_price = i, price
            continue

        if state == "up":
            if price > peak_price:
                peak_idx, peak_price = i, price
            if i - peak_idx >= params.min_pivot_gap_days and price / peak_price - 1.0 <= -params.zigzag_threshold:
                append_pivot("peak", peak_idx, i)
                state = "down"
                trough_idx, trough_price = i, price
        elif state == "down":
            if price < trough_price:
                trough_idx, trough_price = i, price
            if i - trough_idx >= params.min_pivot_gap_days and price / trough_price - 1.0 >= params.zigzag_threshold:
                append_pivot("trough", trough_idx, i)
                state = "up"
                peak_idx, peak_price = i, price

    if state == "up":
        append_pivot("peak", peak_idx, len(prices) - 1, open_=True)
    elif state == "down":
        append_pivot("trough", trough_idx, len(prices) - 1, open_=True)

    if not pivots:
        return pd.DataFrame()
    return pd.DataFrame(pivots)


def build_swing_segments(code: str, name: str, daily: pd.DataFrame, pivots: pd.DataFrame) -> pd.DataFrame:
    rows = []
    indexed = daily.set_index("date")
    for segment_id, (left, right) in enumerate(zip(pivots.itertuples(index=False), pivots.iloc[1:].itertuples(index=False)), start=1):
        start_date = pd.to_datetime(left.date)
        end_date = pd.to_datetime(right.date)
        section = indexed.loc[start_date:end_date]
        direction = "上涨摆动" if right.price > left.price else "下跌摆动"
        rows.append(
            {
                "code": code,
                "name": name,
                "segment_id": segment_id,
                "start_date": start_date.date().isoformat(),
                "end_date": end_date.date().isoformat(),
                "start_type": left.type,
                "end_type": right.type,
                "start_price": left.price,
                "end_price": right.price,
                "direction": direction,
                "days": int(len(section)),
                "return": right.price / left.price - 1.0,
                "max_drawdown": max_drawdown(section["close"]),
                "high": float(section["high"].max()),
                "low": float(section["low"].min()),
            }
        )
    return pd.DataFrame(rows)


def structure_label(left_low: float, right_low: float, tolerance: float) -> str:
    if right_low > left_low * (1.0 + tolerance):
        return "上移结构"
    if right_low < left_low * (1.0 - tolerance):
        return "下移结构"
    return "震荡结构"


def build_trough_intervals(code: str, name: str, daily: pd.DataFrame, pivots: pd.DataFrame, params: StructureParams) -> pd.DataFrame:
    troughs = pivots[pivots["type"] == "trough"].reset_index(drop=True)
    if len(troughs) < 2:
        return pd.DataFrame()

    indexed = daily.set_index("date")
    rows = []
    for unit_id, (left, right) in enumerate(zip(troughs.itertuples(index=False), troughs.iloc[1:].itertuples(index=False)), start=1):
        start_date = pd.to_datetime(left.date)
        end_date = pd.to_datetime(right.date)
        section = indexed.loc[start_date:end_date]
        peak_idx = section["high"].idxmax()
        peak_loc = int(section.index.get_loc(peak_idx))
        peak_price = float(section.loc[peak_idx, "high"])
        label = structure_label(left.price, right.price, params.low_tolerance)
        rows.append(
            {
                "code": code,
                "name": name,
                "unit_id": unit_id,
                "start_date": start_date.date().isoformat(),
                "end_date": end_date.date().isoformat(),
                "left_low": float(left.price),
                "right_low": float(right.price),
                "peak_date": pd.to_datetime(peak_idx).date().isoformat(),
                "peak_price": peak_price,
                "structure": label,
                "days": int(len(section)),
                "up_days": peak_loc + 1,
                "down_days": len(section) - peak_loc - 1,
                "low_to_low_return": right.price / left.price - 1.0,
                "left_low_to_peak_return": peak_price / left.price - 1.0,
                "peak_to_right_low_drawdown": right.price / peak_price - 1.0,
                "max_drawdown": max_drawdown(section["close"]),
            }
        )
    return pd.DataFrame(rows)


def merge_structure_intervals(units: pd.DataFrame, params: StructureParams) -> pd.DataFrame:
    if units.empty:
        return pd.DataFrame()

    rows = []
    current = None
    for row in units.itertuples(index=False):
        if current is None:
            current = {
                "code": row.code,
                "name": row.name,
                "start_unit_id": row.unit_id,
                "end_unit_id": row.unit_id,
                "start_date": row.start_date,
                "end_date": row.end_date,
                "structure": row.structure,
                "start_low": row.left_low,
                "end_low": row.right_low,
                "peak_date": row.peak_date,
                "peak_price": row.peak_price,
                "days": row.days,
                "units": 1,
            }
            continue
        if row.structure == current["structure"]:
            current["end_unit_id"] = row.unit_id
            current["end_date"] = row.end_date
            current["end_low"] = row.right_low
            current["days"] += row.days
            current["units"] += 1
            if row.peak_price > current["peak_price"]:
                current["peak_price"] = row.peak_price
                current["peak_date"] = row.peak_date
        else:
            rows.append(current)
            current = {
                "code": row.code,
                "name": row.name,
                "start_unit_id": row.unit_id,
                "end_unit_id": row.unit_id,
                "start_date": row.start_date,
                "end_date": row.end_date,
                "structure": row.structure,
                "start_low": row.left_low,
                "end_low": row.right_low,
                "peak_date": row.peak_date,
                "peak_price": row.peak_price,
                "days": row.days,
                "units": 1,
            }
    if current is not None:
        rows.append(current)

    regimes = pd.DataFrame(rows)
    if regimes.empty:
        return regimes

    indexed = pd.read_csv(INPUT_BARS, dtype={"code": str}, parse_dates=["date"]).set_index(["code", "date"]).sort_index()
    stats = []
    for row in regimes.itertuples(index=False):
        section = indexed.loc[(row.code, slice(pd.to_datetime(row.start_date), pd.to_datetime(row.end_date))), :]
        start_close = float(section["close"].iloc[0])
        end_close = float(section["close"].iloc[-1])
        high = float(section["high"].max())
        low = float(section["low"].min())
        peak_key = section["high"].idxmax()
        peak_date = pd.to_datetime(peak_key[1] if isinstance(peak_key, tuple) else peak_key)
        peak_dates = section.index.get_level_values("date")
        peak_loc = int(np.where(peak_dates == peak_date)[0][0])
        peak_price = float(section["high"].iloc[peak_loc])
        stats.append(
            {
                "return": end_close / start_close - 1.0,
                "start_low_to_peak_return": peak_price / row.start_low - 1.0,
                "peak_to_end_low_drawdown": row.end_low / peak_price - 1.0,
                "range_return": high / low - 1.0,
                "max_drawdown": max_drawdown(section["close"]),
                "up_days": peak_loc + 1,
                "down_days": len(section) - peak_loc - 1,
            }
        )
    regimes = pd.concat([regimes.reset_index(drop=True), pd.DataFrame(stats)], axis=1)
    regimes["regime_id"] = regimes.groupby("code").cumcount() + 1
    return regimes


def summarize_sector(code: str, name: str, daily: pd.DataFrame, pivots: pd.DataFrame, swings: pd.DataFrame, units: pd.DataFrame, regimes: pd.DataFrame) -> dict:
    close = daily["close"]
    years = max((daily["date"].iloc[-1] - daily["date"].iloc[0]).days / 365.25, 1 / 244)
    total_return = close.iloc[-1] / close.iloc[0] - 1.0
    annual_return = (1.0 + total_return) ** (1.0 / years) - 1.0
    current_structure = regimes.iloc[-1]["structure"] if not regimes.empty else "NA"
    return {
        "code": code,
        "name": name,
        "start": daily["date"].iloc[0].date().isoformat(),
        "end": daily["date"].iloc[-1].date().isoformat(),
        "total_return": total_return,
        "annual_return": annual_return,
        "max_drawdown": max_drawdown(close),
        "pivots": len(pivots),
        "swing_segments": len(swings),
        "structure_units": len(units),
        "merged_regimes": len(regimes),
        "up_units": int((units["structure"] == "上移结构").sum()) if not units.empty else 0,
        "down_units": int((units["structure"] == "下移结构").sum()) if not units.empty else 0,
        "range_units": int((units["structure"] == "震荡结构").sum()) if not units.empty else 0,
        "median_unit_days": units["days"].median() if not units.empty else math.nan,
        "median_up_unit_days": units.loc[units["structure"] == "上移结构", "days"].median() if not units.empty else math.nan,
        "median_down_unit_days": units.loc[units["structure"] == "下移结构", "days"].median() if not units.empty else math.nan,
        "current_structure": current_structure,
    }


def format_index_level(value: float, _pos: int | None = None) -> str:
    if not np.isfinite(value) or value <= 0:
        return ""
    return f"{value:.0f}"


def nearest_x(dates: pd.DatetimeIndex, date: str | pd.Timestamp) -> int | None:
    ts = pd.to_datetime(date)
    pos = int(np.searchsorted(dates.values, ts.to_datetime64()))
    if pos <= 0:
        return 0
    if pos >= len(dates):
        return len(dates) - 1
    before = dates[pos - 1]
    after = dates[pos]
    return pos - 1 if abs(ts - before) <= abs(after - ts) else pos


def set_date_ticks(ax: plt.Axes, dates: pd.DatetimeIndex) -> None:
    years = pd.Series(dates.year).drop_duplicates().to_numpy()
    positions = []
    labels = []
    for year in years:
        matches = np.where(dates.year == year)[0]
        if len(matches) and year % 2 == 0:
            positions.append(matches[0])
            labels.append(str(year))
    ax.set_xticks(positions)
    ax.set_xticklabels(labels, rotation=0, fontsize=8)


def render_chart(code: str, name: str, daily: pd.DataFrame, pivots: pd.DataFrame, units: pd.DataFrame, regimes: pd.DataFrame, summary: dict) -> Path:
    dates = pd.DatetimeIndex(daily["date"])
    x = np.arange(len(daily))
    fig = plt.figure(figsize=(22, 10), dpi=150)
    gs = fig.add_gridspec(4, 1, height_ratios=[3.2, 0.08, 1.0, 0.2], hspace=0.05)
    ax_price = fig.add_subplot(gs[0, 0])
    ax_dd = fig.add_subplot(gs[2, 0], sharex=ax_price)

    colors = {"上移结构": "#2ca25f", "下移结构": "#de2d26", "震荡结构": "#737373"}
    for row in regimes.itertuples(index=False):
        start_x = nearest_x(dates, row.start_date)
        end_x = nearest_x(dates, row.end_date)
        if start_x is not None and end_x is not None:
            ax_price.axvspan(start_x, end_x, color=colors.get(row.structure, "#737373"), alpha=0.08, linewidth=0)

    ax_price.plot(x, daily["close"].to_numpy(dtype=float), color="#222222", linewidth=0.75, label="日收盘")
    for window, color, label in [(20, "#1f77b4", "MA20日"), (60, "#ff7f0e", "MA60日"), (120, "#6f42c1", "MA120日")]:
        ma = daily["close"].rolling(window, min_periods=max(10, window // 3)).mean()
        ax_price.plot(x, ma, color=color, linewidth=0.95, label=label, alpha=0.85)

    for row in units.itertuples(index=False):
        start_x = nearest_x(dates, row.start_date)
        end_x = nearest_x(dates, row.end_date)
        if start_x is not None and end_x is not None:
            y = 0.016
            rect = patches.Rectangle(
                (start_x, y),
                max(end_x - start_x, 1),
                0.012,
                transform=ax_price.get_xaxis_transform(),
                color=colors.get(row.structure, "#737373"),
                alpha=0.75,
                linewidth=0,
                clip_on=False,
            )
            ax_price.add_patch(rect)

    if not pivots.empty:
        troughs = pivots[pivots["type"] == "trough"]
        peaks = pivots[pivots["type"] == "peak"]
        for row in troughs.itertuples(index=False):
            pos = nearest_x(dates, row.date)
            if pos is not None:
                ax_price.scatter(pos, row.price * 0.965, marker="^", s=26, color="#0b8f3a", zorder=5)
        for row in peaks.itertuples(index=False):
            pos = nearest_x(dates, row.date)
            if pos is not None:
                ax_price.scatter(pos, row.price * 1.035, marker="o", s=22, color="#f28e2b", zorder=5)

    title = f"{name}（{code}）日线走势结构图：{summary['start']} 至 {summary['end']}"
    subtitle = (
        f"总收益 {pct(summary['total_return'])} | 年化 {pct(summary['annual_return'])} | "
        f"最大回撤 {pct(summary['max_drawdown'])} | 小结构 {summary['structure_units']} 段 | "
        f"合并大区间 {summary['merged_regimes']} 段 | 当前 {summary['current_structure']}"
    )
    ax_price.set_title(title, loc="left", fontsize=16, fontweight="bold", pad=12)
    ax_price.text(0.0, 1.01, subtitle, transform=ax_price.transAxes, fontsize=10, color="#333333")
    ax_price.legend(loc="upper left", ncols=4, frameon=False, fontsize=9)
    ax_price.set_yscale("log")
    ax_price.yaxis.set_major_locator(mticker.LogLocator(base=10, subs=(1.0, 2.0, 5.0)))
    ax_price.yaxis.set_major_formatter(mticker.FuncFormatter(format_index_level))
    ax_price.yaxis.set_minor_formatter(mticker.NullFormatter())
    ax_price.grid(axis="y", which="major", alpha=0.24, linewidth=0.65)
    ax_price.grid(axis="y", which="minor", alpha=0.10, linewidth=0.45)
    ax_price.set_ylabel("指数点位（对数坐标）")
    ax_price.margins(x=0.01)

    peak = daily["close"].cummax()
    dd = daily["close"] / peak - 1.0
    ax_dd.fill_between(x, dd.values, 0, where=dd.values < 0, color="#c1121f", alpha=0.28, linewidth=0)
    ax_dd.plot(x, dd.values, color="#8b0000", linewidth=0.75)
    for level in [-0.2, -0.3, -0.4]:
        ax_dd.axhline(level, color="#666666", linestyle="--", linewidth=0.7, alpha=0.7)
    ax_dd.set_ylim(min(-0.9, float(dd.min()) * 1.05), 0.05)
    ax_dd.set_ylabel("回撤")
    ax_dd.yaxis.set_major_formatter(lambda value, _pos: pct(value, 0))
    ax_dd.grid(axis="y", alpha=0.2, linewidth=0.6)
    set_date_ticks(ax_dd, dates)
    plt.setp(ax_price.get_xticklabels(), visible=False)

    legend_text = "背景色=合并后的大区间：绿=上移结构、红=下移结构、灰=震荡结构；价格图底部色条=相邻结构低点形成的小区间；绿三角=结构低点；橙点=结构高点"
    fig.text(0.012, 0.025, legend_text, fontsize=9, color="#444444")

    CHART_DIR.mkdir(parents=True, exist_ok=True)
    file_path = CHART_DIR / f"{code}_{safe_name(name)}_daily_structure.png"
    fig.savefig(file_path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return file_path


def format_summary_table(summary: pd.DataFrame) -> pd.DataFrame:
    out = summary.copy()
    for col in ["total_return", "annual_return", "max_drawdown"]:
        out[col] = out[col].map(pct)
    for col in ["median_unit_days", "median_up_unit_days", "median_down_unit_days"]:
        out[col] = out[col].map(lambda x: num(x, 0))
    return out


def format_units_table(units: pd.DataFrame, tail: int | None = None) -> pd.DataFrame:
    if units.empty:
        return units
    out = units.copy()
    if tail is not None:
        out = out.tail(tail)
    for col in ["low_to_low_return", "left_low_to_peak_return", "peak_to_right_low_drawdown", "max_drawdown"]:
        out[col] = out[col].map(pct)
    return out[
        [
            "unit_id",
            "structure",
            "start_date",
            "end_date",
            "peak_date",
            "days",
            "up_days",
            "down_days",
            "low_to_low_return",
            "left_low_to_peak_return",
            "peak_to_right_low_drawdown",
            "max_drawdown",
        ]
    ].rename(
        columns={
            "unit_id": "序号",
            "structure": "结构",
            "start_date": "左低点",
            "end_date": "右低点",
            "peak_date": "区间高点",
            "days": "天数",
            "up_days": "上涨天数",
            "down_days": "下跌天数",
            "low_to_low_return": "低点抬升/降低",
            "left_low_to_peak_return": "左低到高点涨幅",
            "peak_to_right_low_drawdown": "高点到右低跌幅",
            "max_drawdown": "区间最大回撤",
        }
    )


def format_regimes_table(regimes: pd.DataFrame) -> pd.DataFrame:
    if regimes.empty:
        return regimes
    out = regimes.copy()
    for col in ["return", "start_low_to_peak_return", "peak_to_end_low_drawdown", "range_return", "max_drawdown"]:
        out[col] = out[col].map(pct)
    return out[
        [
            "regime_id",
            "structure",
            "start_date",
            "end_date",
            "units",
            "days",
            "up_days",
            "down_days",
            "peak_date",
            "return",
            "start_low_to_peak_return",
            "peak_to_end_low_drawdown",
            "range_return",
            "max_drawdown",
        ]
    ].rename(
        columns={
            "regime_id": "序号",
            "structure": "大区间",
            "start_date": "开始",
            "end_date": "结束",
            "units": "包含小区间",
            "days": "天数",
            "up_days": "上涨天数",
            "down_days": "下跌天数",
            "peak_date": "最高点日期",
            "return": "首尾涨跌",
            "start_low_to_peak_return": "起点低到高点涨幅",
            "peak_to_end_low_drawdown": "高点到结束低点跌幅",
            "range_return": "区间振幅",
            "max_drawdown": "最大回撤",
        }
    )


def build_sector_character_metrics(units: pd.DataFrame) -> pd.DataFrame:
    if units.empty:
        return pd.DataFrame()
    metrics = (
        units.groupby(["code", "name"])
        .agg(
            units=("unit_id", "count"),
            up_units=("structure", lambda s: int((s == "上移结构").sum())),
            down_units=("structure", lambda s: int((s == "下移结构").sum())),
            range_units=("structure", lambda s: int((s == "震荡结构").sum())),
            median_up_days=("up_days", "median"),
            median_down_days=("down_days", "median"),
            median_rally=("left_low_to_peak_return", "median"),
            median_peak_drop=("peak_to_right_low_drawdown", "median"),
        )
        .reset_index()
    )
    metrics["up_ratio"] = metrics["up_units"] / metrics["units"]
    metrics["down_ratio"] = metrics["down_units"] / metrics["units"]
    metrics["range_ratio"] = metrics["range_units"] / metrics["units"]
    metrics["rally_per_20d"] = metrics["median_rally"] / (metrics["median_up_days"] / 20)
    metrics["drop_per_20d"] = metrics["median_peak_drop"].abs() / (metrics["median_down_days"].replace(0, np.nan) / 20)
    return metrics


def format_current_regime_table(regimes: pd.DataFrame, structure: str | None = None, limit: int | None = None) -> pd.DataFrame:
    if regimes.empty:
        return regimes
    latest = regimes.sort_values(["code", "regime_id"]).groupby("code").tail(1).copy()
    if structure is not None:
        latest = latest[latest["structure"] == structure]
    if latest.empty:
        return latest
    sort_col = "start_low_to_peak_return" if structure == "上移结构" else "return"
    latest = latest.sort_values(sort_col, ascending=structure != "上移结构")
    if limit is not None:
        latest = latest.head(limit)
    for col in ["return", "start_low_to_peak_return", "peak_to_end_low_drawdown", "max_drawdown"]:
        latest[col] = latest[col].map(pct)
    return latest[
        [
            "code",
            "name",
            "structure",
            "start_date",
            "end_date",
            "days",
            "up_days",
            "down_days",
            "return",
            "start_low_to_peak_return",
            "peak_to_end_low_drawdown",
        ]
    ].rename(
        columns={
            "code": "代码",
            "name": "行业",
            "structure": "当前结构",
            "start_date": "开始",
            "end_date": "结束",
            "days": "天数",
            "up_days": "上涨天数",
            "down_days": "下跌天数",
            "return": "首尾涨跌",
            "start_low_to_peak_return": "低到高点涨幅",
            "peak_to_end_low_drawdown": "高点后跌幅",
        }
    )


def format_character_table(metrics: pd.DataFrame, sort_col: str, ascending: bool = False, limit: int = 8) -> pd.DataFrame:
    if metrics.empty:
        return metrics
    out = metrics.sort_values(sort_col, ascending=ascending).head(limit).copy()
    for col in ["up_ratio", "down_ratio", "range_ratio", "median_rally", "median_peak_drop", "rally_per_20d", "drop_per_20d"]:
        out[col] = out[col].map(pct)
    for col in ["median_up_days", "median_down_days"]:
        out[col] = out[col].map(lambda x: num(x, 0))
    return out[
        [
            "code",
            "name",
            "up_ratio",
            "down_ratio",
            "range_ratio",
            "median_up_days",
            "median_down_days",
            "median_rally",
            "median_peak_drop",
            "rally_per_20d",
            "drop_per_20d",
        ]
    ].rename(
        columns={
            "code": "代码",
            "name": "行业",
            "up_ratio": "上移占比",
            "down_ratio": "下移占比",
            "range_ratio": "震荡占比",
            "median_up_days": "中位上涨天数",
            "median_down_days": "中位下跌天数",
            "median_rally": "中位低到高点涨幅",
            "median_peak_drop": "中位高点后跌幅",
            "rally_per_20d": "20日上涨弹性",
            "drop_per_20d": "20日下跌强度",
        }
    )


def append_industry_analysis(lines: list[str], units: pd.DataFrame, regimes: pd.DataFrame) -> None:
    if units.empty or regimes.empty:
        return
    latest = regimes.sort_values(["code", "regime_id"]).groupby("code").tail(1)
    current_counts = latest["structure"].value_counts()
    up_count = int(current_counts.get("上移结构", 0))
    down_count = int(current_counts.get("下移结构", 0))
    range_count = int(current_counts.get("震荡结构", 0))
    metrics = build_sector_character_metrics(units)

    lines.append("## 行业分析")
    lines.append("")
    lines.append(
        f"按最新一个已完成的合并大区间看，当前横截面不是普涨结构：31 个行业中，{up_count} 个处于上移结构，{down_count} 个处于下移结构，{range_count} 个处于震荡结构。这里的“当前”指最新一个低点到低点的完整结构段，不等同于实时交易信号；它更适合描述行业所处的阶段。"
    )
    lines.append("")
    lines.append("### 当前上移结构行业")
    lines.append("")
    lines.append(
        "上移结构里，通信、电子、建筑材料的低点到高点涨幅最高，说明这些行业在最近一轮结构中弹性最强；银行、公用事业、石油石化虽然也处于上移结构，但上涨更慢，更偏防守或低波动修复。"
    )
    lines.append("")
    lines.append(md_table(format_current_regime_table(regimes, structure="上移结构")))
    lines.append("")
    lines.append("### 当前下移结构行业")
    lines.append("")
    lines.append(
        "下移结构覆盖更多行业，说明这一轮结构并不是全市场共同上行。美容护理、食品饮料、国防军工、传媒、房地产等行业的最新大区间首尾跌幅较深；社会服务和商贸零售虽然中途反弹不弱，但高点后的跌幅也较大，属于“反弹有弹性、回落也重”的结构。"
    )
    lines.append("")
    lines.append(md_table(format_current_regime_table(regimes, structure="下移结构", limit=12)))
    lines.append("")
    lines.append("### 行业长期结构性格")
    lines.append("")
    lines.append(
        "从全部历史小结构看，行业可以粗分为三类：一类是上移占比更高、趋势更容易延续的行业；一类是上涨弹性很高但下跌也快的高波动行业；一类是下移占比偏高、结构压力更重的行业。"
    )
    lines.append("")
    lines.append("**上移占比较高：偏长期顺势/慢牛特征。**")
    lines.append("")
    lines.append(md_table(format_character_table(metrics, "up_ratio", ascending=False, limit=8)))
    lines.append("")
    lines.append("**上涨弹性较高：适合观察阶段性主线，但更容易出现急涨急跌。**")
    lines.append("")
    lines.append(md_table(format_character_table(metrics, "rally_per_20d", ascending=False, limit=8)))
    lines.append("")
    lines.append("**下移占比较高：历史上更容易出现低点持续下移，需要等待更明确的结构修复。**")
    lines.append("")
    lines.append(md_table(format_character_table(metrics, "down_ratio", ascending=False, limit=8)))
    lines.append("")
    lines.append("### 结论")
    lines.append("")
    lines.append(
        "当前结构最强的不是传统消费或地产链，而是通信、电子、建筑材料、机械设备等偏科技/制造/顺周期修复方向；防守型的银行、公用事业也保持上移，但速度慢。相反，食品饮料、美容护理、社会服务、商贸零售、房地产等消费服务和地产链相关行业仍表现为下移或高回撤结构。后续如果要继续做板块轮动分析，应优先观察“上移结构能否扩散”，以及当前下移行业是否先出现震荡结构，再转为连续上移结构。"
    )
    lines.append("")


def generate_report(summary: pd.DataFrame, units: pd.DataFrame, regimes: pd.DataFrame, manifest: list[dict], params: StructureParams) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# 申万一级行业指数走势结构分析报告（日线分段口径）")
    lines.append("")
    lines.append("生成日期：2026-07-19")
    lines.append("")
    lines.append("## 分析目标")
    lines.append("")
    lines.append("本报告不是回测，也不定义买卖点；目标是把板块指数肉眼看到的“底部震荡、上涨波段、下跌波段、再次筑底”转成可复查的结构区间。方法是先基于日线数据识别小结构，再由小结构合并大区间。")
    lines.append("")
    lines.append("## 分段规则")
    lines.append("")
    lines.append(f"- 数据频率：申万一级行业指数日线 OHLC。")
    lines.append(f"- 结构拐点：使用日线 ZigZag，价格从阶段高/低点反向波动至少 {pct(params.zigzag_threshold, 0)}，且拐点间隔至少 {params.min_pivot_gap_days} 个交易日。")
    lines.append("- 小结构区间：用相邻两个结构低点切分，形式为“左低点 → 区间高点 → 右低点”。所有小结构在结构低点之间顺序相接，不重不漏。")
    lines.append(f"- 小结构标签：右低点高于左低点超过 {pct(params.low_tolerance, 0)} 记为上移结构；右低点低于左低点超过 {pct(params.low_tolerance, 0)} 记为下移结构；落在容忍区间内记为震荡结构。")
    lines.append("- 大区间合并：相邻且标签相同的小结构合并为一个大区间。当前版本不主观跨越震荡段，避免为了“看起来顺”而过度合并。")
    lines.append("- 注意：ZigZag 拐点是事后结构识别工具，不是实时交易信号。")
    lines.append("")
    lines.append("## 全市场概览")
    lines.append("")
    lines.append(f"本版覆盖 {summary['code'].nunique()} 个申万一级行业。共识别 {len(units)} 个低点到低点的小结构区间，并合并为 {len(regimes)} 个大结构区间。")
    lines.append("")
    if not units.empty:
        unit_dist = (
            units.groupby("structure", observed=False)
            .agg(
                count=("code", "count"),
                median_days=("days", "median"),
                median_low_move=("low_to_low_return", "median"),
                median_peak_gain=("left_low_to_peak_return", "median"),
                median_peak_drawdown=("peak_to_right_low_drawdown", "median"),
            )
            .reset_index()
        )
        unit_dist["pct"] = unit_dist["count"] / len(units)
        for col in ["median_low_move", "median_peak_gain", "median_peak_drawdown", "pct"]:
            unit_dist[col] = unit_dist[col].map(pct)
        unit_dist["median_days"] = unit_dist["median_days"].map(lambda x: num(x, 0))
        lines.append("### 小结构分布")
        lines.append("")
        lines.append(
            md_table(
                unit_dist.rename(
                    columns={
                        "structure": "结构",
                        "count": "数量",
                        "pct": "占比",
                        "median_days": "中位天数",
                        "median_low_move": "中位低点变化",
                        "median_peak_gain": "中位左低到高点",
                        "median_peak_drawdown": "中位高点到右低",
                    }
                )[["结构", "数量", "占比", "中位天数", "中位低点变化", "中位左低到高点", "中位高点到右低"]]
            )
        )
        lines.append("")
    if not regimes.empty:
        regime_dist = (
            regimes.groupby("structure", observed=False)
            .agg(
                count=("code", "count"),
                median_units=("units", "median"),
                median_days=("days", "median"),
                median_return=("return", "median"),
                median_drawdown=("max_drawdown", "median"),
            )
            .reset_index()
        )
        for col in ["median_return", "median_drawdown"]:
            regime_dist[col] = regime_dist[col].map(pct)
        for col in ["median_units", "median_days"]:
            regime_dist[col] = regime_dist[col].map(lambda x: num(x, 0))
        lines.append("### 合并大区间分布")
        lines.append("")
        lines.append(
            md_table(
                regime_dist.rename(
                    columns={
                        "structure": "大区间",
                        "count": "数量",
                        "median_units": "中位小区间数",
                        "median_days": "中位天数",
                        "median_return": "中位首尾涨跌",
                        "median_drawdown": "中位最大回撤",
                    }
                )
            )
        )
        lines.append("")
    append_industry_analysis(lines, units, regimes)
    lines.append("### 行业摘要")
    lines.append("")
    summary_table = format_summary_table(summary.sort_values(["structure_units", "merged_regimes"], ascending=[False, False]))
    lines.append(
        md_table(
            summary_table.rename(
                columns={
                    "code": "代码",
                    "name": "行业",
                    "start": "起始",
                    "end": "截至",
                    "total_return": "总收益",
                    "annual_return": "年化收益",
                    "max_drawdown": "最大回撤",
                    "pivots": "拐点数",
                    "structure_units": "小结构数",
                    "merged_regimes": "大区间数",
                    "up_units": "上移数",
                    "down_units": "下移数",
                    "range_units": "震荡数",
                    "median_unit_days": "小结构中位天数",
                    "current_structure": "当前结构",
                }
            )[
                [
                    "代码",
                    "行业",
                    "起始",
                    "截至",
                    "总收益",
                    "最大回撤",
                    "拐点数",
                    "小结构数",
                    "大区间数",
                    "上移数",
                    "下移数",
                    "震荡数",
                    "小结构中位天数",
                    "当前结构",
                ]
            ]
        )
    )
    lines.append("")
    lines.append("## 分行业结构分析")
    lines.append("")

    manifest_map = {item["code"]: item for item in manifest}
    for row in summary.sort_values("code").itertuples(index=False):
        code = row.code
        name = row.name
        lines.append(f"## {name}（{code}）")
        lines.append("")
        lines.append(f"配图占位：{manifest_map[code]['caption']}")
        lines.append("")
        lines.append("### 板块概览")
        lines.append("")
        lines.append(
            f"{name}指数样本区间为 {row.start} 至 {row.end}，总收益 {pct(row.total_return)}，年化收益 {pct(row.annual_return)}，最大回撤 {pct(row.max_drawdown)}。本版识别出 {int(row.structure_units)} 个低点到低点小结构区间，并合并为 {int(row.merged_regimes)} 个大结构区间；当前结构为“{row.current_structure}”。"
        )
        lines.append("")
        sector_regimes = regimes[regimes["code"] == code].sort_values("regime_id")
        lines.append("### 合并大区间清单")
        lines.append("")
        lines.append(md_table(format_regimes_table(sector_regimes)))
        lines.append("")
        sector_units = units[units["code"] == code].sort_values("unit_id")
        lines.append("### 全部小结构清单")
        lines.append("")
        lines.append(md_table(format_units_table(sector_units)))
        lines.append("")
        lines.append("### 最近10个小结构")
        lines.append("")
        lines.append(md_table(format_units_table(sector_units, tail=10)))
        lines.append("")

    lines.append("## 输出文件")
    lines.append("")
    lines.append(f"- 小结构区间：`{OUTPUT_DIR / 'structure_units.csv'}`")
    lines.append(f"- 合并大区间：`{OUTPUT_DIR / 'merged_regimes.csv'}`")
    lines.append(f"- 摆动段：`{OUTPUT_DIR / 'swing_segments.csv'}`")
    lines.append(f"- 行业摘要：`{OUTPUT_DIR / 'sector_structure_summary.csv'}`")
    lines.append(f"- 图片目录：`{CHART_DIR}`")
    lines.append("")
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def generate_compact_report(summary: pd.DataFrame, units: pd.DataFrame, regimes: pd.DataFrame, manifest: list[dict], params: StructureParams) -> None:
    COMPACT_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# 申万一级行业指数走势结构分析报告（日线分段口径·配图版）")
    lines.append("")
    lines.append("生成日期：2026-07-19")
    lines.append("")
    lines.append("## 分析目标")
    lines.append("")
    lines.append("本报告不是回测，也不定义买卖点；目标是把板块指数的历史走势拆成可复查的结构区间。为了避免飞书文档过大，配图版保留全市场摘要、每个板块的结构图、合并大区间清单和最近 10 个小结构；完整小结构清单保存在本地 CSV 和完整 Markdown 报告中。")
    lines.append("")
    lines.append("## 分段规则")
    lines.append("")
    lines.append(f"- 数据频率：申万一级行业指数日线 OHLC。")
    lines.append(f"- 结构拐点：使用日线 ZigZag，价格从阶段高/低点反向波动至少 {pct(params.zigzag_threshold, 0)}，且拐点间隔至少 {params.min_pivot_gap_days} 个交易日。")
    lines.append("- 小结构区间：用相邻两个结构低点切分，形式为“左低点 → 区间高点 → 右低点”。")
    lines.append(f"- 小结构标签：右低点高于左低点超过 {pct(params.low_tolerance, 0)} 记为上移结构；右低点低于左低点超过 {pct(params.low_tolerance, 0)} 记为下移结构；落在容忍区间内记为震荡结构。")
    lines.append("- 大区间合并：相邻且标签相同的小结构合并为一个大区间；当前版本不主观跨越震荡段。")
    lines.append("- 注意：ZigZag 拐点是事后结构识别工具，不是实时交易信号。")
    lines.append("")
    lines.append("## 全市场概览")
    lines.append("")
    lines.append(f"本版覆盖 {summary['code'].nunique()} 个申万一级行业。共识别 {len(units)} 个低点到低点的小结构区间，并合并为 {len(regimes)} 个大结构区间。")
    lines.append("")
    if not units.empty:
        unit_dist = (
            units.groupby("structure", observed=False)
            .agg(
                count=("code", "count"),
                median_days=("days", "median"),
                median_low_move=("low_to_low_return", "median"),
                median_peak_gain=("left_low_to_peak_return", "median"),
                median_peak_drawdown=("peak_to_right_low_drawdown", "median"),
            )
            .reset_index()
        )
        unit_dist["pct"] = unit_dist["count"] / len(units)
        for col in ["median_low_move", "median_peak_gain", "median_peak_drawdown", "pct"]:
            unit_dist[col] = unit_dist[col].map(pct)
        unit_dist["median_days"] = unit_dist["median_days"].map(lambda x: num(x, 0))
        lines.append("### 小结构分布")
        lines.append("")
        lines.append(
            md_table(
                unit_dist.rename(
                    columns={
                        "structure": "结构",
                        "count": "数量",
                        "pct": "占比",
                        "median_days": "中位天数",
                        "median_low_move": "中位低点变化",
                        "median_peak_gain": "中位左低到高点",
                        "median_peak_drawdown": "中位高点到右低",
                    }
                )[["结构", "数量", "占比", "中位天数", "中位低点变化", "中位左低到高点", "中位高点到右低"]]
            )
        )
        lines.append("")
    if not regimes.empty:
        regime_dist = (
            regimes.groupby("structure", observed=False)
            .agg(
                count=("code", "count"),
                median_units=("units", "median"),
                median_days=("days", "median"),
                median_return=("return", "median"),
                median_drawdown=("max_drawdown", "median"),
            )
            .reset_index()
        )
        for col in ["median_return", "median_drawdown"]:
            regime_dist[col] = regime_dist[col].map(pct)
        for col in ["median_units", "median_days"]:
            regime_dist[col] = regime_dist[col].map(lambda x: num(x, 0))
        lines.append("### 合并大区间分布")
        lines.append("")
        lines.append(
            md_table(
                regime_dist.rename(
                    columns={
                        "structure": "大区间",
                        "count": "数量",
                        "median_units": "中位小区间数",
                        "median_days": "中位天数",
                        "median_return": "中位首尾涨跌",
                        "median_drawdown": "中位最大回撤",
                    }
                )
            )
        )
        lines.append("")
    append_industry_analysis(lines, units, regimes)
    lines.append("### 行业摘要")
    lines.append("")
    summary_table = format_summary_table(summary.sort_values(["structure_units", "merged_regimes"], ascending=[False, False]))
    lines.append(
        md_table(
            summary_table.rename(
                columns={
                    "code": "代码",
                    "name": "行业",
                    "start": "起始",
                    "end": "截至",
                    "total_return": "总收益",
                    "max_drawdown": "最大回撤",
                    "pivots": "拐点数",
                    "structure_units": "小结构数",
                    "merged_regimes": "大区间数",
                    "up_units": "上移数",
                    "down_units": "下移数",
                    "range_units": "震荡数",
                    "median_unit_days": "小结构中位天数",
                    "current_structure": "当前结构",
                }
            )[
                [
                    "代码",
                    "行业",
                    "起始",
                    "截至",
                    "总收益",
                    "最大回撤",
                    "拐点数",
                    "小结构数",
                    "大区间数",
                    "上移数",
                    "下移数",
                    "震荡数",
                    "小结构中位天数",
                    "当前结构",
                ]
            ]
        )
    )
    lines.append("")
    lines.append("## 分行业结构分析")
    lines.append("")

    manifest_map = {item["code"]: item for item in manifest}
    for row in summary.sort_values("code").itertuples(index=False):
        code = row.code
        name = row.name
        lines.append(f"## {name}（{code}）")
        lines.append("")
        lines.append(
            f"{name}指数样本区间为 {row.start} 至 {row.end}，总收益 {pct(row.total_return)}，最大回撤 {pct(row.max_drawdown)}。本版识别出 {int(row.structure_units)} 个低点到低点小结构区间，并合并为 {int(row.merged_regimes)} 个大结构区间；当前结构为“{row.current_structure}”。"
        )
        lines.append("")
        sector_regimes = regimes[regimes["code"] == code].sort_values("regime_id")
        lines.append("### 合并大区间清单")
        lines.append("")
        lines.append(md_table(format_regimes_table(sector_regimes)))
        lines.append("")
        sector_units = units[units["code"] == code].sort_values("unit_id")
        lines.append("### 最近10个小结构")
        lines.append("")
        lines.append(md_table(format_units_table(sector_units, tail=10)))
        lines.append("")

    lines.append("## 输出文件")
    lines.append("")
    lines.append(f"- 完整 Markdown 报告：`{REPORT_PATH}`")
    lines.append(f"- 小结构区间：`{OUTPUT_DIR / 'structure_units.csv'}`")
    lines.append(f"- 合并大区间：`{OUTPUT_DIR / 'merged_regimes.csv'}`")
    lines.append(f"- 摆动段：`{OUTPUT_DIR / 'swing_segments.csv'}`")
    lines.append(f"- 行业摘要：`{OUTPUT_DIR / 'sector_structure_summary.csv'}`")
    lines.append(f"- 图片目录：`{CHART_DIR}`")
    lines.append("")
    COMPACT_REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    setup_fonts()
    params = StructureParams()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    CHART_DIR.mkdir(parents=True, exist_ok=True)
    bars = load_bars()

    summaries = []
    pivots_all = []
    swings_all = []
    units_all = []
    regimes_all = []
    manifest = []
    for (code, name), daily in bars.groupby(["code", "name"], sort=True):
        daily = daily.sort_values("date").reset_index(drop=True)
        pivots = find_zigzag_pivots(daily, params)
        swings = build_swing_segments(code, name, daily, pivots) if not pivots.empty else pd.DataFrame()
        units = build_trough_intervals(code, name, daily, pivots, params) if not pivots.empty else pd.DataFrame()
        regimes = merge_structure_intervals(units, params) if not units.empty else pd.DataFrame()
        summary = summarize_sector(code, name, daily, pivots, swings, units, regimes)
        image_path = render_chart(code, name, daily, pivots, units, regimes, summary)
        manifest.append(
            {
                "code": code,
                "name": name,
                "file": str(image_path),
                "caption": f"{name}（{code}）日线走势结构图（对数坐标）：结构拐点 + 小结构区间 + 合并大区间",
            }
        )
        summaries.append(summary)
        if not pivots.empty:
            pivots_all.append(pivots.assign(code=code, name=name))
        if not swings.empty:
            swings_all.append(swings)
        if not units.empty:
            units_all.append(units)
        if not regimes.empty:
            regimes_all.append(regimes)

    summary_df = pd.DataFrame(summaries)
    pivots_df = pd.concat(pivots_all, ignore_index=True) if pivots_all else pd.DataFrame()
    swings_df = pd.concat(swings_all, ignore_index=True) if swings_all else pd.DataFrame()
    units_df = pd.concat(units_all, ignore_index=True) if units_all else pd.DataFrame()
    regimes_df = pd.concat(regimes_all, ignore_index=True) if regimes_all else pd.DataFrame()

    summary_df.to_csv(OUTPUT_DIR / "sector_structure_summary.csv", index=False)
    pivots_df.to_csv(OUTPUT_DIR / "structure_pivots.csv", index=False)
    swings_df.to_csv(OUTPUT_DIR / "swing_segments.csv", index=False)
    units_df.to_csv(OUTPUT_DIR / "structure_units.csv", index=False)
    regimes_df.to_csv(OUTPUT_DIR / "merged_regimes.csv", index=False)
    (CHART_DIR / "chart_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "summary.json").write_text(
        json.dumps(
            {
                "params": params.__dict__,
                "sector_count": int(summary_df["code"].nunique()),
                "pivots": int(len(pivots_df)),
                "swing_segments": int(len(swings_df)),
                "structure_units": int(len(units_df)),
                "merged_regimes": int(len(regimes_df)),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    generate_report(summary_df, units_df, regimes_df, manifest, params)
    generate_compact_report(summary_df, units_df, regimes_df, manifest, params)
    print(json.dumps(json.loads((OUTPUT_DIR / "summary.json").read_text(encoding="utf-8")), ensure_ascii=False, indent=2))
    print(REPORT_PATH)
    print(COMPACT_REPORT_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

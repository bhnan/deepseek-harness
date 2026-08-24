#!/usr/bin/env python3
"""Analyze SW first-level sector indices with a major-cycle definition."""

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
OUTPUT_DIR = Path("lab/backtests/sw_sector_balanced_cycle_analysis")
CHART_DIR = OUTPUT_DIR / "kline_charts"
REPORT_PATH = Path("docs/research/sw-sector-balanced-cycle-analysis-report.md")
TRADING_WEEKS_PER_YEAR = 52


@dataclass(frozen=True)
class MajorCycleParams:
    up_confirm: float = 0.22
    down_confirm: float = 0.18
    min_cycle_weeks: int = 16
    min_up_return: float = 0.25
    bottom_confirm_weeks: int = 8
    min_confirm_to_peak_weeks: int = 4
    min_confirm_to_peak_return: float = 0.08
    bottom_min_weeks: int = 20


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


def resample_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    indexed = daily.set_index("date").sort_index()
    weekly = indexed.resample("W-FRI").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
        }
    )
    return weekly.dropna(subset=["open", "high", "low", "close"])


def find_major_pivots(close: pd.Series, params: MajorCycleParams) -> list[dict]:
    values = close.dropna()
    if values.empty:
        return []

    dates = values.index.to_list()
    prices = values.to_numpy(dtype=float)
    pivots: list[dict] = []

    low_idx = high_idx = 0
    low_price = high_price = prices[0]
    state = "undetermined"
    peak_idx = trough_idx = 0
    peak_price = trough_price = prices[0]

    def confirmed_trough(candidate_idx: int, confirm_idx: int) -> dict:
        return {
            "type": "trough",
            "idx": confirm_idx,
            "date": dates[confirm_idx],
            "price": prices[confirm_idx],
            "base_low_idx": candidate_idx,
            "base_low_date": dates[candidate_idx],
            "base_low_price": prices[candidate_idx],
            "base_weeks": confirm_idx - candidate_idx + 1,
        }

    for i, price in enumerate(prices[1:], start=1):
        if state == "undetermined":
            if price < low_price:
                low_idx, low_price = i, price
            if price > high_price:
                high_idx, high_price = i, price
            weeks_since_low = i - low_idx + 1
            if price / low_price - 1 >= params.up_confirm and weeks_since_low >= params.bottom_confirm_weeks:
                pivots.append(confirmed_trough(low_idx, i))
                state = "up"
                peak_idx, peak_price = i, price
            elif price / high_price - 1 <= -params.down_confirm:
                pivots.append({"type": "peak", "idx": high_idx, "date": dates[high_idx], "price": high_price})
                state = "down"
                trough_idx, trough_price = i, price
            continue

        if state == "up":
            if price > peak_price:
                peak_idx, peak_price = i, price
            elif price / peak_price - 1 <= -params.down_confirm:
                pivots.append({"type": "peak", "idx": peak_idx, "date": dates[peak_idx], "price": peak_price})
                state = "down"
                trough_idx, trough_price = i, price
            continue

        if state == "down":
            if price < trough_price:
                trough_idx, trough_price = i, price
            weeks_since_trough = i - trough_idx + 1
            if price / trough_price - 1 >= params.up_confirm and weeks_since_trough >= params.bottom_confirm_weeks:
                pivots.append(confirmed_trough(trough_idx, i))
                state = "up"
                peak_idx, peak_price = i, price

    if state == "up":
        pivots.append({"type": "peak", "idx": peak_idx, "date": dates[peak_idx], "price": peak_price, "open": True})
    elif state == "down":
        pivots.append({"type": "trough", "idx": trough_idx, "date": dates[trough_idx], "price": trough_price, "open": True})

    cleaned: list[dict] = []
    for pivot in pivots:
        if not cleaned:
            cleaned.append(pivot)
            continue
        last = cleaned[-1]
        if pivot["type"] != last["type"]:
            cleaned.append(pivot)
        elif pivot["type"] == "peak" and pivot["price"] > last["price"]:
            cleaned[-1] = pivot
        elif pivot["type"] == "trough" and pivot["price"] < last["price"]:
            cleaned[-1] = pivot
    return cleaned


def extract_major_cycles(code: str, name: str, weekly: pd.DataFrame, params: MajorCycleParams) -> tuple[pd.DataFrame, list[dict]]:
    pivots = find_major_pivots(weekly["close"], params)
    rows = []
    for i in range(len(pivots) - 2):
        first, second, third = pivots[i], pivots[i + 1], pivots[i + 2]
        if first["type"] != "trough" or second["type"] != "peak" or third["type"] != "trough":
            continue
        start_date = first["date"]
        peak_date = second["date"]
        end_date = third["date"]
        cycle_weeks = int((weekly.index.get_loc(end_date) - weekly.index.get_loc(start_date)) + 1)
        up_weeks = int((weekly.index.get_loc(peak_date) - weekly.index.get_loc(start_date)) + 1)
        base_weeks = first.get("base_weeks", np.nan)
        base_to_peak_weeks = base_weeks + up_weeks - 1 if pd.notna(base_weeks) else np.nan
        base_low_price = first.get("base_low_price", first["price"])
        base_to_peak = second["price"] / base_low_price - 1.0
        start_to_peak = second["price"] / first["price"] - 1.0
        peak_to_end = third["price"] / second["price"] - 1.0
        start_to_end = third["price"] / first["price"] - 1.0
        if (
            cycle_weeks < params.min_cycle_weeks
            or base_to_peak < params.min_up_return
            or up_weeks < params.min_confirm_to_peak_weeks
            or start_to_peak < params.min_confirm_to_peak_return
        ):
            continue
        section = weekly.loc[start_date:end_date]
        max_dd = float((section["close"] / section["close"].cummax() - 1.0).min())
        rows.append(
            {
                "code": code,
                "name": name,
                "start_date": start_date.date().isoformat(),
                "base_low_date": first.get("base_low_date", start_date).date().isoformat(),
                "peak_date": peak_date.date().isoformat(),
                "end_date": end_date.date().isoformat(),
                "base_weeks": base_weeks,
                "base_to_peak_weeks": base_to_peak_weeks,
                "cycle_weeks": cycle_weeks,
                "up_weeks": up_weeks,
                "down_weeks": cycle_weeks - up_weeks,
                "start_price": first["price"],
                "base_low_price": base_low_price,
                "peak_price": second["price"],
                "end_price": third["price"],
                "base_to_peak_return": base_to_peak,
                "start_to_peak_return": start_to_peak,
                "peak_to_end_drawdown": peak_to_end,
                "start_to_end_return": start_to_end,
                "max_drawdown_in_cycle": max_dd,
            }
        )
    return pd.DataFrame(rows), pivots


def detect_drawdowns(code: str, name: str, weekly: pd.DataFrame, thresholds: tuple[float, ...] = (0.2, 0.3, 0.4)) -> pd.DataFrame:
    rows = []
    for threshold in thresholds:
        in_event = False
        peak_date = None
        peak_price = -np.inf
        trough_date = None
        trough_price = np.inf
        trigger_date = None
        for date, close in weekly["close"].items():
            if not in_event:
                if close > peak_price:
                    peak_price = float(close)
                    peak_date = date
                if peak_price > 0 and close / peak_price - 1 <= -threshold:
                    in_event = True
                    trigger_date = date
                    trough_date = date
                    trough_price = float(close)
                continue

            if close < trough_price:
                trough_price = float(close)
                trough_date = date
            if close >= peak_price:
                rows.append(
                    {
                        "code": code,
                        "name": name,
                        "threshold": threshold,
                        "peak_date": peak_date.date().isoformat(),
                        "trigger_date": trigger_date.date().isoformat(),
                        "trough_date": trough_date.date().isoformat(),
                        "end_date": date.date().isoformat(),
                        "trough_drawdown": trough_price / peak_price - 1.0,
                        "peak_to_trough_weeks": int((weekly.index.get_loc(trough_date) - weekly.index.get_loc(peak_date)) + 1),
                        "recovery_weeks_from_trough": int((weekly.index.get_loc(date) - weekly.index.get_loc(trough_date)) + 1),
                        "recovered": True,
                    }
                )
                in_event = False
                peak_date = date
                peak_price = float(close)
                trough_date = None
                trough_price = np.inf
                trigger_date = None
        if in_event:
            last_date = weekly.index[-1]
            rows.append(
                {
                    "code": code,
                    "name": name,
                    "threshold": threshold,
                    "peak_date": peak_date.date().isoformat(),
                    "trigger_date": trigger_date.date().isoformat(),
                    "trough_date": trough_date.date().isoformat(),
                    "end_date": last_date.date().isoformat(),
                    "trough_drawdown": trough_price / peak_price - 1.0,
                    "peak_to_trough_weeks": int((weekly.index.get_loc(trough_date) - weekly.index.get_loc(peak_date)) + 1),
                    "recovery_weeks_from_trough": np.nan,
                    "recovered": False,
                }
            )
    return pd.DataFrame(rows)


def extract_bottom_periods(code: str, name: str, weekly: pd.DataFrame, cycles: pd.DataFrame, params: MajorCycleParams) -> pd.DataFrame:
    if cycles.empty:
        return pd.DataFrame()
    rows = []
    sorted_cycles = cycles.sort_values("start_date")
    for prev, nxt in zip(sorted_cycles.itertuples(index=False), sorted_cycles.iloc[1:].itertuples(index=False)):
        start = pd.to_datetime(prev.end_date)
        end = pd.to_datetime(nxt.start_date)
        if end <= start:
            continue
        section = weekly.loc[start:end]
        if len(section) < params.bottom_min_weeks:
            continue
        rows.append(
            {
                "code": code,
                "name": name,
                "start_date": start.date().isoformat(),
                "end_date": end.date().isoformat(),
                "weeks": len(section),
                "period_return": section["close"].iloc[-1] / section["close"].iloc[0] - 1.0,
                "range_return": section["high"].max() / section["low"].min() - 1.0,
            }
        )
    last = sorted_cycles.iloc[-1]
    start = pd.to_datetime(last["end_date"])
    section = weekly.loc[start:]
    if len(section) >= params.bottom_min_weeks:
        rows.append(
            {
                "code": code,
                "name": name,
                "start_date": start.date().isoformat(),
                "end_date": weekly.index[-1].date().isoformat(),
                "weeks": len(section),
                "period_return": section["close"].iloc[-1] / section["close"].iloc[0] - 1.0,
                "range_return": section["high"].max() / section["low"].min() - 1.0,
            }
        )
    return pd.DataFrame(rows)


def current_state(weekly: pd.DataFrame, pivots: list[dict]) -> str:
    if not pivots:
        return "样本不足"
    latest = float(weekly["close"].iloc[-1])
    last = pivots[-1]
    if last["type"] == "trough":
        rebound = latest / last["price"] - 1.0
        if rebound >= 0.30:
            return "新周期启动观察"
        if rebound >= 0.12:
            return "筑底后反弹"
        return "筑底/低位震荡"
    drawdown = latest / last["price"] - 1.0
    if drawdown <= -0.30:
        return "衰退/深回撤"
    if drawdown <= -0.18:
        return "高位回撤"
    return "高位震荡/趋势延续"


def summarize_sector(code: str, name: str, weekly: pd.DataFrame, cycles: pd.DataFrame, drawdowns: pd.DataFrame, bottoms: pd.DataFrame, pivots: list[dict]) -> dict:
    close = weekly["close"]
    total_return = close.iloc[-1] / close.iloc[0] - 1.0
    years = max((weekly.index[-1] - weekly.index[0]).days / 365.25, 1 / 52)
    annual_return = (1.0 + total_return) ** (1.0 / years) - 1.0
    max_drawdown = float((close / close.cummax() - 1.0).min())
    threshold_counts = drawdowns.groupby("threshold").size().to_dict() if not drawdowns.empty else {}
    return {
        "code": code,
        "name": name,
        "start": weekly.index[0].date().isoformat(),
        "end": weekly.index[-1].date().isoformat(),
        "years": years,
        "total_return": total_return,
        "annual_return": annual_return,
        "max_drawdown": max_drawdown,
        "major_cycles": len(cycles),
        "median_cycle_weeks": cycles["cycle_weeks"].median() if not cycles.empty else np.nan,
        "max_cycle_weeks": cycles["cycle_weeks"].max() if not cycles.empty else np.nan,
        "median_up_return": cycles["base_to_peak_return"].median() if not cycles.empty else np.nan,
        "max_up_return": cycles["base_to_peak_return"].max() if not cycles.empty else np.nan,
        "median_peak_to_end_drawdown": cycles["peak_to_end_drawdown"].median() if not cycles.empty else np.nan,
        "drawdown_20_events": int(threshold_counts.get(0.2, 0)),
        "drawdown_30_events": int(threshold_counts.get(0.3, 0)),
        "drawdown_40_events": int(threshold_counts.get(0.4, 0)),
        "bottom_periods": len(bottoms),
        "current_state": current_state(weekly, pivots),
    }


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


def draw_candles(ax: plt.Axes, weekly: pd.DataFrame) -> None:
    up_color = "#d62728"
    down_color = "#2ca02c"
    width = 0.55
    for i, row in enumerate(weekly.itertuples()):
        open_price = float(row.open)
        high_price = float(row.high)
        low_price = float(row.low)
        close_price = float(row.close)
        color = up_color if close_price >= open_price else down_color
        ax.vlines(i, low_price, high_price, color=color, linewidth=0.55, alpha=0.85)
        lower = min(open_price, close_price)
        height = abs(close_price - open_price)
        if height <= 0:
            ax.hlines(close_price, i - width / 2, i + width / 2, color=color, linewidth=0.8)
        else:
            ax.add_patch(
                patches.Rectangle(
                    (i - width / 2, lower),
                    width,
                    height,
                    facecolor=color,
                    edgecolor=color,
                    linewidth=0.35,
                    alpha=0.85,
                )
            )


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


def format_index_level(value: float, _pos: int | None = None) -> str:
    if not np.isfinite(value) or value <= 0:
        return ""
    return f"{value:.0f}"


def render_chart(code: str, name: str, weekly: pd.DataFrame, cycles: pd.DataFrame, drawdowns: pd.DataFrame, summary: dict) -> Path:
    dates = weekly.index
    x = np.arange(len(weekly))
    fig = plt.figure(figsize=(22, 10), dpi=150)
    gs = fig.add_gridspec(4, 1, height_ratios=[3.2, 0.08, 1.0, 0.2], hspace=0.05)
    ax_price = fig.add_subplot(gs[0, 0])
    ax_dd = fig.add_subplot(gs[2, 0], sharex=ax_price)

    for row in cycles.itertuples(index=False):
        start_x = nearest_x(dates, row.start_date)
        peak_x = nearest_x(dates, row.peak_date)
        end_x = nearest_x(dates, row.end_date)
        if start_x is not None and peak_x is not None and peak_x >= start_x:
            ax_price.axvspan(start_x, peak_x, color="#f6c85f", alpha=0.18, linewidth=0)
        if peak_x is not None and end_x is not None and end_x >= peak_x:
            ax_price.axvspan(peak_x, end_x, color="#e76f51", alpha=0.08, linewidth=0)

    draw_candles(ax_price, weekly)
    for window, color, label in [(20, "#1f77b4", "MA20周"), (60, "#ff7f0e", "MA60周"), (120, "#6f42c1", "MA120周")]:
        ma = weekly["close"].rolling(window, min_periods=max(8, window // 3)).mean()
        ax_price.plot(x, ma, color=color, linewidth=1.05, label=label, alpha=0.9)

    for row in cycles.itertuples(index=False):
        base_x = nearest_x(dates, row.base_low_date) if hasattr(row, "base_low_date") else None
        start_x = nearest_x(dates, row.start_date)
        peak_x = nearest_x(dates, row.peak_date)
        end_x = nearest_x(dates, row.end_date)
        if base_x is not None:
            ax_price.scatter(base_x, weekly["low"].iloc[base_x] * 0.91, marker="D", s=24, facecolors="none", edgecolors="#0b8f3a", linewidths=1.1, zorder=5)
        if start_x is not None:
            ax_price.scatter(start_x, weekly["low"].iloc[start_x] * 0.94, marker="^", s=46, color="#0b8f3a", zorder=5)
        if peak_x is not None:
            ax_price.scatter(peak_x, weekly["high"].iloc[peak_x] * 1.035, marker="o", s=36, color="#f28e2b", zorder=5)
        if end_x is not None:
            ax_price.scatter(end_x, weekly["low"].iloc[end_x] * 0.90, marker="v", s=46, color="#c1121f", zorder=5)

    dd20 = drawdowns[drawdowns["threshold"] == 0.2] if not drawdowns.empty else pd.DataFrame()
    for row in dd20.tail(10).itertuples(index=False):
        trough_x = nearest_x(dates, row.trough_date)
        if trough_x is not None:
            ax_price.scatter(trough_x, weekly["low"].iloc[trough_x] * 0.86, marker="x", s=52, color="#5a189a", zorder=6)

    title = f"{name}（{code}）均衡周期K线图：{summary['start']} 至 {summary['end']}"
    subtitle = (
        f"总收益 {pct(summary['total_return'])} | 年化 {pct(summary['annual_return'])} | "
        f"最大回撤 {pct(summary['max_drawdown'])} | 均衡周期 {summary['major_cycles']} 段 | 当前状态 {summary['current_state']}"
    )
    ax_price.set_title(title, loc="left", fontsize=16, fontweight="bold", pad=12)
    ax_price.text(0.0, 1.01, subtitle, transform=ax_price.transAxes, fontsize=10, color="#333333")
    ax_price.legend(loc="upper left", ncols=3, frameon=False, fontsize=9)
    ax_price.set_yscale("log")
    ax_price.yaxis.set_major_locator(mticker.LogLocator(base=10, subs=(1.0, 2.0, 5.0)))
    ax_price.yaxis.set_major_formatter(mticker.FuncFormatter(format_index_level))
    ax_price.yaxis.set_minor_formatter(mticker.NullFormatter())
    ax_price.grid(axis="y", which="major", alpha=0.24, linewidth=0.65)
    ax_price.grid(axis="y", which="minor", alpha=0.10, linewidth=0.45)
    ax_price.set_ylabel("指数点位（对数坐标）")
    ax_price.margins(x=0.01)

    peak = weekly["close"].cummax()
    dd = weekly["close"] / peak - 1.0
    ax_dd.fill_between(x, dd.values, 0, where=dd.values < 0, color="#c1121f", alpha=0.28, linewidth=0)
    ax_dd.plot(x, dd.values, color="#8b0000", linewidth=0.8)
    for level in [-0.2, -0.3, -0.4]:
        ax_dd.axhline(level, color="#666666", linestyle="--", linewidth=0.7, alpha=0.7)
    ax_dd.set_ylim(min(-0.9, float(dd.min()) * 1.05), 0.05)
    ax_dd.set_ylabel("回撤")
    ax_dd.yaxis.set_major_formatter(lambda value, _pos: pct(value, 0))
    ax_dd.grid(axis="y", alpha=0.2, linewidth=0.6)
    set_date_ticks(ax_dd, dates)
    plt.setp(ax_price.get_xticklabels(), visible=False)

    legend_text = "价格轴=对数坐标；空心绿菱形=急跌后见底；绿三角=筑底后的启动确认；浅黄区间=均衡周期主升段；浅红区间=周期衰退/回撤段；橙点=周期顶部；红三角=周期结束低点；紫色X=20%级别回撤低点"
    fig.text(0.012, 0.025, legend_text, fontsize=9, color="#444444")

    CHART_DIR.mkdir(parents=True, exist_ok=True)
    file_path = CHART_DIR / f"{code}_{safe_name(name)}_balanced_cycle_kline.png"
    fig.savefig(file_path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return file_path


def format_summary_table(summary: pd.DataFrame) -> pd.DataFrame:
    out = summary.copy()
    for col in ["total_return", "annual_return", "max_drawdown", "median_up_return", "max_up_return", "median_peak_to_end_drawdown"]:
        out[col] = out[col].map(pct)
    out["years"] = out["years"].map(lambda x: num(x, 1))
    out["median_cycle_weeks"] = out["median_cycle_weeks"].map(lambda x: num(x, 0))
    return out


def format_cycles_table(cycles: pd.DataFrame) -> pd.DataFrame:
    if cycles.empty:
        return cycles
    out = cycles.copy()
    for col in ["base_to_peak_return", "start_to_peak_return", "peak_to_end_drawdown", "start_to_end_return", "max_drawdown_in_cycle"]:
        out[col] = out[col].map(pct)
    return out[
        [
            "start_date",
            "base_low_date",
            "peak_date",
            "end_date",
            "base_weeks",
            "base_to_peak_weeks",
            "cycle_weeks",
            "base_to_peak_return",
            "start_to_peak_return",
            "peak_to_end_drawdown",
            "start_to_end_return",
        ]
    ].rename(
        columns={
            "start_date": "启动确认",
            "base_low_date": "见底",
            "peak_date": "高点",
            "end_date": "结束低点",
            "base_weeks": "筑底周数",
            "base_to_peak_weeks": "见底到高点周数",
            "cycle_weeks": "周数",
            "base_to_peak_return": "见底到顶涨幅",
            "start_to_peak_return": "确认到顶涨幅",
            "peak_to_end_drawdown": "顶到结束回撤",
            "start_to_end_return": "确认到结束涨跌",
        }
    )


def format_drawdown_table(drawdowns: pd.DataFrame) -> pd.DataFrame:
    if drawdowns.empty:
        return drawdowns
    out = drawdowns.copy()
    out["threshold"] = out["threshold"].map(pct)
    out["trough_drawdown"] = out["trough_drawdown"].map(pct)
    return out[
        [
            "threshold",
            "peak_date",
            "trough_date",
            "end_date",
            "trough_drawdown",
            "peak_to_trough_weeks",
            "recovered",
        ]
    ].rename(
        columns={
            "threshold": "级别",
            "peak_date": "前高",
            "trough_date": "低点",
            "end_date": "恢复/截至",
            "trough_drawdown": "最大回撤",
            "peak_to_trough_weeks": "下跌周数",
            "recovered": "是否收复前高",
        }
    )


def generate_report(summary: pd.DataFrame, cycles: pd.DataFrame, drawdowns: pd.DataFrame, bottoms: pd.DataFrame, manifest: list[dict], params: MajorCycleParams) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# 申万一级行业指数周期分析报告（均衡口径）")
    lines.append("")
    lines.append("生成日期：2026-07-18")
    lines.append("")
    lines.append("## 本版修正说明")
    lines.append("")
    lines.append("上一版短波段规则太碎，后一版大周期规则又过粗；均衡版虽然居中，但仍然会把急跌后的 V 形反弹直接算作新周期。本版继续保留周线均衡阈值，同时加入“筑底确认”：下跌见底后必须至少震荡一段时间，确认不再继续破底，之后的上涨才算新周期。")
    lines.append("")
    lines.append("## 均衡周期定义")
    lines.append("")
    lines.append(f"- 数据频率：日线重采样为周线 OHLC。")
    lines.append(f"- 启动确认：从阶段低点上涨至少 {pct(params.up_confirm, 0)}，该阶段低点作为周期启动锚点。")
    lines.append(f"- 结束确认：从阶段高点回撤至少 {pct(params.down_confirm, 0)}，该阶段高点作为周期顶部，回撤低点作为周期结束。")
    lines.append(f"- 筑底确认：下跌见底后至少等待 {params.bottom_confirm_weeks} 周；如果等待期间继续创新低，则重置见底时间。周期起点取“启动确认日”，不是急跌最低点。")
    lines.append(f"- 有效周期过滤：完整周期至少 {params.min_cycle_weeks} 周，见底到顶涨幅至少 {pct(params.min_up_return, 0)}；启动确认后还要至少上涨 {params.min_confirm_to_peak_weeks} 周、涨幅至少 {pct(params.min_confirm_to_peak_return, 0)}，避免把确认日附近的余波反弹误算为周期。")
    lines.append("- 合并逻辑：日线级别的小回踩不切段；周线级别、幅度足够的回撤才切成新阶段。")
    lines.append("- 这套定义的目标是观察板块中级到大级别轮动，不是生成精确买卖点。")
    lines.append("")
    lines.append("## 全市场总览")
    lines.append("")
    total_cycles = len(cycles)
    total_drawdowns = len(drawdowns)
    lines.append(f"本版覆盖 {summary['code'].nunique()} 个申万一级行业，样本区间从 {summary['start'].min()} 至 {summary['end'].max()}。共识别 {total_cycles} 段均衡周期、{total_drawdowns} 条 20%/30%/40% 级别回撤事件。")
    lines.append("")
    if not cycles.empty:
        lines.append("### 均衡周期总体统计")
        lines.append("")
        stats = pd.DataFrame(
            [
                {
                    "均衡周期数量": len(cycles),
                    "中位持续周数": num(cycles["cycle_weeks"].median(), 0),
                    "最长周数": num(cycles["cycle_weeks"].max(), 0),
                    "中位见底到顶涨幅": pct(cycles["base_to_peak_return"].median()),
                    "中位顶到结束回撤": pct(cycles["peak_to_end_drawdown"].median()),
                    "中位底到结束涨跌": pct(cycles["start_to_end_return"].median()),
                }
            ]
        )
        lines.append(md_table(stats))
        lines.append("")
        lines.append("### 周期长度分布")
        lines.append("")
        bucketed = cycles.copy()
        bucketed["duration_bucket"] = pd.cut(
            bucketed["cycle_weeks"],
            bins=[0, 52, 104, 156, 260, 10000],
            labels=["0-1年", "1-2年", "2-3年", "3-5年", "5年以上"],
            right=True,
        )
        dur = (
            bucketed.groupby("duration_bucket", observed=False)
            .agg(
                cycles=("code", "count"),
                median_weeks=("cycle_weeks", "median"),
                median_up=("base_to_peak_return", "median"),
                median_peak_to_end=("peak_to_end_drawdown", "median"),
            )
            .reset_index()
        )
        dur["median_weeks"] = dur["median_weeks"].map(lambda x: num(x, 0))
        dur["median_up"] = dur["median_up"].map(pct)
        dur["median_peak_to_end"] = dur["median_peak_to_end"].map(pct)
        lines.append(md_table(dur.rename(columns={"duration_bucket": "长度", "cycles": "周期数", "median_weeks": "中位周数", "median_up": "中位见底到顶", "median_peak_to_end": "中位顶到结束"})))
        lines.append("")
        lines.append(
            f"补充统计：下表按实际见底日 `base_low_date` 到周期高点 `peak_date` 计算“见底到高点周数”，用于衡量板块从底部区域走到阶段高点通常需要多长时间；如果只从“启动确认日”算到高点，全市场中位数为 {num(cycles['up_weeks'].median(), 0)} 周。"
        )
        lines.append("")
        rise_bucketed = cycles.copy()
        rise_bucketed["rise_bucket"] = pd.cut(
            rise_bucketed["base_to_peak_weeks"],
            bins=[0, 13, 26, 52, 104, 10000],
            labels=["13周以内（约3个月）", "14-26周（3-6个月）", "27-52周（6-12个月）", "53-104周（1-2年）", "104周以上（2年以上）"],
            right=True,
        )
        rise_dist = (
            rise_bucketed.groupby("rise_bucket", observed=False)
            .agg(
                cycles=("code", "count"),
                median_return=("base_to_peak_return", "median"),
                median_full_weeks=("cycle_weeks", "median"),
            )
            .reset_index()
        )
        rise_dist["pct"] = rise_dist["cycles"] / len(cycles)
        rise_dist["median_return"] = rise_dist["median_return"].map(pct)
        rise_dist["median_full_weeks"] = rise_dist["median_full_weeks"].map(lambda x: num(x, 0))
        rise_dist["pct"] = rise_dist["pct"].map(pct)
        lines.append(
            md_table(
                rise_dist.rename(
                    columns={
                        "rise_bucket": "见底到高点区间",
                        "cycles": "周期数",
                        "pct": "占比",
                        "median_return": "中位见底到顶涨幅",
                        "median_full_weeks": "对应完整周期中位周数",
                    }
                )[
                    ["见底到高点区间", "周期数", "占比", "中位见底到顶涨幅", "对应完整周期中位周数"]
                ]
            )
        )
        lines.append("")
    lines.append("### 行业摘要")
    lines.append("")
    summary_table = format_summary_table(summary.sort_values(["major_cycles", "max_up_return"], ascending=[False, False]))
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
                    "major_cycles": "周期数",
                    "median_cycle_weeks": "中位周数",
                    "max_up_return": "最大底到顶",
                    "drawdown_20_events": "20%回撤数",
                    "current_state": "当前状态",
                }
            ),
            ["代码", "行业", "起始", "截至", "总收益", "最大回撤", "周期数", "中位周数", "最大底到顶", "20%回撤数", "当前状态"],
        )
    )
    lines.append("")
    lines.append("## 分行业周期分析")
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
            f"{name}指数样本区间为 {row.start} 至 {row.end}，总收益 {pct(row.total_return)}，年化收益 {pct(row.annual_return)}，最大回撤 {pct(row.max_drawdown)}。本版识别出 {int(row.major_cycles)} 段均衡周期，中位周期长度 {num(row.median_cycle_weeks, 0)} 周，当前状态为“{row.current_state}”。"
        )
        lines.append("")
        sector_cycles = cycles[cycles["code"] == code].sort_values("start_date")
        lines.append("### 全部周期清单")
        lines.append("")
        lines.append(md_table(format_cycles_table(sector_cycles)))
        lines.append("")
        if not sector_cycles.empty:
            biggest = sector_cycles.sort_values("base_to_peak_return", ascending=False).head(3)
            lines.append("### 最大上涨周期")
            lines.append("")
            lines.append(md_table(format_cycles_table(biggest)))
            lines.append("")
            latest = sector_cycles.tail(1)
            lines.append("### 最近完成的周期")
            lines.append("")
            lines.append(md_table(format_cycles_table(latest)))
            lines.append("")
        sector_drawdowns = drawdowns[(drawdowns["code"] == code) & (drawdowns["threshold"] >= 0.2)].sort_values(["threshold", "peak_date"])
        lines.append("### 20%及以上回撤事件")
        lines.append("")
        lines.append(md_table(format_drawdown_table(sector_drawdowns)))
        lines.append("")
        sector_bottoms = bottoms[bottoms["code"] == code].copy()
        if not sector_bottoms.empty:
            bottom_table = sector_bottoms.copy()
            bottom_table["period_return"] = bottom_table["period_return"].map(pct)
            bottom_table["range_return"] = bottom_table["range_return"].map(pct)
            bottom_table = bottom_table.rename(columns={"start_date": "开始", "end_date": "结束", "weeks": "周数", "period_return": "区间涨跌", "range_return": "区间振幅"})
            lines.append("### 周期之间的筑底/休整区间")
            lines.append("")
            lines.append(md_table(bottom_table[["开始", "结束", "周数", "区间涨跌", "区间振幅"]]))
            lines.append("")
    lines.append("## 输出文件")
    lines.append("")
    lines.append(f"- 新版报告 Markdown：`{REPORT_PATH}`")
    lines.append(f"- 周线均衡周期 K 线图目录：`{CHART_DIR}`")
    lines.append(f"- 周期明细：`{OUTPUT_DIR / 'major_cycles.csv'}`")
    lines.append(f"- 回撤事件：`{OUTPUT_DIR / 'major_drawdown_events.csv'}`")
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    params = MajorCycleParams()
    setup_fonts()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    CHART_DIR.mkdir(parents=True, exist_ok=True)

    bars = load_bars()
    all_cycles = []
    all_drawdowns = []
    all_bottoms = []
    summaries = []
    manifest = []

    for code, daily in bars.groupby("code", sort=True):
        name = str(daily["name"].iloc[0])
        weekly = resample_weekly(daily)
        cycles, pivots = extract_major_cycles(code, name, weekly, params)
        drawdowns = detect_drawdowns(code, name, weekly)
        bottoms = extract_bottom_periods(code, name, weekly, cycles, params)
        summary = summarize_sector(code, name, weekly, cycles, drawdowns, bottoms, pivots)
        chart_path = render_chart(code, name, weekly, cycles, drawdowns, summary)
        manifest.append(
            {
                "code": code,
                "name": name,
                "file": str(chart_path),
                "caption": f"{name}（{code}）均衡周期K线图（对数坐标）：周K + 周期主升/回撤区间 + 20%回撤低点",
            }
        )
        summaries.append(summary)
        all_cycles.append(cycles)
        all_drawdowns.append(drawdowns)
        all_bottoms.append(bottoms)

    cycles_df = pd.concat([df for df in all_cycles if not df.empty], ignore_index=True) if any(not df.empty for df in all_cycles) else pd.DataFrame()
    drawdowns_df = pd.concat([df for df in all_drawdowns if not df.empty], ignore_index=True) if any(not df.empty for df in all_drawdowns) else pd.DataFrame()
    bottoms_df = pd.concat([df for df in all_bottoms if not df.empty], ignore_index=True) if any(not df.empty for df in all_bottoms) else pd.DataFrame()
    summary_df = pd.DataFrame(summaries)

    summary_df.to_csv(OUTPUT_DIR / "sector_major_cycle_summary.csv", index=False)
    cycles_df.to_csv(OUTPUT_DIR / "major_cycles.csv", index=False)
    drawdowns_df.to_csv(OUTPUT_DIR / "major_drawdown_events.csv", index=False)
    bottoms_df.to_csv(OUTPUT_DIR / "major_bottom_periods.csv", index=False)
    (CHART_DIR / "chart_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "summary.json").write_text(
        json.dumps(
            {
                "params": params.__dict__,
                "sector_count": int(summary_df["code"].nunique()),
                "major_cycles": int(len(cycles_df)),
                "drawdown_events": int(len(drawdowns_df)),
                "bottom_periods": int(len(bottoms_df)),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    generate_report(summary_df, cycles_df, drawdowns_df, bottoms_df, manifest, params)
    print(json.dumps(json.loads((OUTPUT_DIR / "summary.json").read_text(encoding="utf-8")), ensure_ascii=False, indent=2))
    print(REPORT_PATH)


if __name__ == "__main__":
    main()

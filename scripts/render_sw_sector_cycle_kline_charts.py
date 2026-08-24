#!/usr/bin/env python3
"""Render K-line cycle charts for SW first-level sector indices."""

from __future__ import annotations

import json
import re
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.font_manager as fm
import matplotlib.patches as patches
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


INPUT_DIR = Path("lab/backtests/sw_sector_cycle_analysis")
OUTPUT_DIR = INPUT_DIR / "kline_charts"
MANIFEST_PATH = OUTPUT_DIR / "chart_manifest.json"


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


def pct(value: float | None, digits: int = 1) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value * 100:.{digits}f}%"


def safe_name(text: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "_", text).strip("_")


def nearest_x(dates: pd.DatetimeIndex, date: str | pd.Timestamp) -> int | None:
    ts = pd.to_datetime(date)
    if len(dates) == 0:
        return None
    pos = int(np.searchsorted(dates.values, ts.to_datetime64()))
    if pos <= 0:
        return 0
    if pos >= len(dates):
        return len(dates) - 1
    before = dates[pos - 1]
    after = dates[pos]
    return pos - 1 if abs(ts - before) <= abs(after - ts) else pos


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


def draw_candles(ax: plt.Axes, weekly: pd.DataFrame) -> None:
    x = np.arange(len(weekly))
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
    year_positions = []
    year_labels = []
    for year in years:
        matches = np.where(dates.year == year)[0]
        if len(matches) and year % 2 == 0:
            year_positions.append(matches[0])
            year_labels.append(str(year))
    ax.set_xticks(year_positions)
    ax.set_xticklabels(year_labels, rotation=0, fontsize=8)


def render_chart(
    code: str,
    name: str,
    bars: pd.DataFrame,
    cycles: pd.DataFrame,
    drawdowns: pd.DataFrame,
    summary: pd.Series,
) -> Path:
    daily = bars[bars["code"] == code].copy()
    daily["date"] = pd.to_datetime(daily["date"])
    weekly = resample_weekly(daily)
    dates = weekly.index
    x = np.arange(len(weekly))

    sector_cycles = cycles[cycles["code"] == code].copy()
    sector_drawdowns = drawdowns[(drawdowns["code"] == code) & (drawdowns["threshold"] == 0.15)].copy()

    fig = plt.figure(figsize=(22, 10), dpi=150)
    gs = fig.add_gridspec(4, 1, height_ratios=[3.2, 0.08, 1.0, 0.2], hspace=0.05)
    ax_price = fig.add_subplot(gs[0, 0])
    ax_dd = fig.add_subplot(gs[2, 0], sharex=ax_price)

    for row in sector_cycles.itertuples(index=False):
        start_x = nearest_x(dates, row.start_date)
        end_x = nearest_x(dates, row.end_date)
        if start_x is not None and end_x is not None and end_x >= start_x:
            ax_price.axvspan(start_x, end_x, color="#f6c85f", alpha=0.11, linewidth=0)

    draw_candles(ax_price, weekly)

    for window, color, label in [(12, "#1f77b4", "MA12周"), (24, "#ff7f0e", "MA24周"), (52, "#6f42c1", "MA52周")]:
        ma = weekly["close"].rolling(window, min_periods=max(4, window // 3)).mean()
        ax_price.plot(x, ma, color=color, linewidth=1.05, label=label, alpha=0.9)

    for row in sector_cycles.tail(12).itertuples(index=False):
        start_x = nearest_x(dates, row.start_date)
        peak_x = nearest_x(dates, row.peak_date)
        end_x = nearest_x(dates, row.end_date)
        if start_x is not None:
            ax_price.scatter(start_x, weekly["low"].iloc[start_x] * 0.96, marker="^", s=34, color="#0b8f3a", zorder=5)
        if peak_x is not None:
            ax_price.scatter(peak_x, weekly["high"].iloc[peak_x] * 1.035, marker="o", s=24, color="#f28e2b", zorder=5)
        if end_x is not None:
            ax_price.scatter(end_x, weekly["high"].iloc[end_x] * 1.055, marker="v", s=34, color="#c1121f", zorder=5)

    for row in sector_drawdowns.tail(8).itertuples(index=False):
        trough_x = nearest_x(dates, row.trough_date)
        if trough_x is not None:
            ax_price.scatter(trough_x, weekly["low"].iloc[trough_x] * 0.91, marker="x", s=42, color="#5a189a", zorder=6)

    start_date = daily["date"].min().date().isoformat()
    end_date = daily["date"].max().date().isoformat()
    title = f"{name}（{code}）周期K线图：{start_date} 至 {end_date}"
    subtitle = (
        f"总收益 {pct(summary.get('total_return'))} | 年化 {pct(summary.get('annual_return'))} | "
        f"最大回撤 {pct(summary.get('max_drawdown'))} | 周期 {int(summary.get('cycles', 0))} 段 | "
        f"当前状态 {summary.get('current_state', 'NA')}"
    )
    ax_price.set_title(title, loc="left", fontsize=16, fontweight="bold", pad=12)
    ax_price.text(0.0, 1.01, subtitle, transform=ax_price.transAxes, fontsize=10, color="#333333")
    ax_price.legend(loc="upper left", ncols=3, frameon=False, fontsize=9)
    ax_price.grid(axis="y", alpha=0.22, linewidth=0.6)
    ax_price.set_ylabel("指数点位")
    ax_price.margins(x=0.01)

    peak = weekly["close"].cummax()
    dd = weekly["close"] / peak - 1.0
    ax_dd.fill_between(x, dd.values, 0, where=dd.values < 0, color="#c1121f", alpha=0.28, linewidth=0)
    ax_dd.plot(x, dd.values, color="#8b0000", linewidth=0.8)
    ax_dd.axhline(-0.1, color="#666666", linestyle="--", linewidth=0.7, alpha=0.7)
    ax_dd.axhline(-0.15, color="#666666", linestyle="--", linewidth=0.7, alpha=0.7)
    ax_dd.axhline(-0.2, color="#666666", linestyle="--", linewidth=0.7, alpha=0.7)
    ax_dd.set_ylim(min(-0.9, float(dd.min()) * 1.05), 0.05)
    ax_dd.set_ylabel("回撤")
    ax_dd.yaxis.set_major_formatter(lambda v, _pos: pct(v, 0))
    ax_dd.grid(axis="y", alpha=0.2, linewidth=0.6)
    set_date_ticks(ax_dd, dates)
    plt.setp(ax_price.get_xticklabels(), visible=False)

    legend_text = "浅黄区间=识别出的趋势周期；绿三角=周期启动；橙点=周期高点；红三角=周期结束；紫色X=15%级别回撤低点"
    fig.text(0.012, 0.025, legend_text, fontsize=9, color="#444444")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    file_path = OUTPUT_DIR / f"{code}_{safe_name(name)}_cycle_kline.png"
    fig.savefig(file_path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return file_path


def main() -> None:
    setup_fonts()
    bars = pd.read_csv(INPUT_DIR / "sw_first_level_daily_bars.csv", dtype={"code": str})
    bars["date"] = pd.to_datetime(bars["date"])
    cycles = pd.read_csv(INPUT_DIR / "cycles.csv", dtype={"code": str})
    drawdowns = pd.read_csv(INPUT_DIR / "drawdown_events.csv", dtype={"code": str})
    summary = pd.read_csv(INPUT_DIR / "sector_summary.csv", dtype={"code": str})

    manifest = []
    for row in summary.sort_values("code").itertuples(index=False):
        code = str(row.code)
        name = str(row.name)
        file_path = render_chart(
            code=code,
            name=name,
            bars=bars,
            cycles=cycles,
            drawdowns=drawdowns,
            summary=pd.Series(row._asdict()),
        )
        manifest.append(
            {
                "code": code,
                "name": name,
                "file": str(file_path),
                "caption": f"{name}（{code}）周期K线图：周K + 趋势周期 + 15%回撤低点",
            }
        )

    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"rendered {len(manifest)} charts")
    print(MANIFEST_PATH)


if __name__ == "__main__":
    main()

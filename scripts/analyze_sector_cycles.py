#!/usr/bin/env python3
"""Analyze sector ETF cycle states, drawdowns, and rebounds."""

from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.append(str(Path(__file__).resolve().parent))
from analyze_sector_etf_rotation import ETF_POOL, build_panels, month_end_dates  # noqa: E402


START = "20150101"
END = "20260717"
OUTPUT_DIR = Path("lab/backtests/sector_cycle_analysis")
REPORT_PATH = Path("docs/research/sector-cycle-analysis-report.md")
CACHE_DIR = Path("lab/backtests/sector_etf_rotation_2015_dynamic_top3/akshare_cache")
TRADING_DAYS_PER_YEAR = 252


@dataclass
class CycleParams:
    min_history: int = 252
    min_cycle_days: int = 20
    start_rank_pct: float = 0.30
    end_rank_pct: float = 0.60
    hard_drawdown: float = -0.25
    soft_drawdown: float = -0.15
    bottom_range_120: float = 0.35
    bottom_abs_ret_120: float = 0.15
    bottom_ma120_band: float = 0.10


def pct(value: float | None, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value * 100:.{digits}f}%"


def num(value: float | int | None, digits: int = 1) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value:.{digits}f}"


def load_sector_prices() -> pd.DataFrame:
    close, _amount, _universe = build_panels(START, END, CACHE_DIR, "dynamic")
    return close


def equal_weight_nav(close: pd.DataFrame) -> pd.Series:
    returns = close.pct_change(fill_method=None).mean(axis=1, skipna=True).fillna(0.0)
    return (1.0 + returns).cumprod()


def rank_pct_desc(panel: pd.DataFrame) -> pd.DataFrame:
    return panel.rank(axis=1, ascending=False, pct=True)


def linear_slope(series: pd.Series) -> float:
    y = np.log(series.dropna().to_numpy(dtype=float))
    if len(y) < 20 or np.any(~np.isfinite(y)):
        return np.nan
    x = np.arange(len(y), dtype=float)
    slope = np.polyfit(x, y, 1)[0]
    return float(math.exp(slope * TRADING_DAYS_PER_YEAR) - 1.0)


def build_indicators(close: pd.DataFrame) -> dict[str, pd.DataFrame | pd.Series]:
    eq_nav = equal_weight_nav(close)
    normalized_close = close / close.ffill().bfill().iloc[0]
    rel = normalized_close.div(eq_nav, axis=0)
    ret20 = close / close.shift(20) - 1.0
    ret60 = close / close.shift(60) - 1.0
    ret120 = close / close.shift(120) - 1.0
    ret252 = close / close.shift(252) - 1.0
    ma20 = close.rolling(20, min_periods=10).mean()
    ma60 = close.rolling(60, min_periods=30).mean()
    ma120 = close.rolling(120, min_periods=60).mean()
    high120 = close.rolling(120, min_periods=60).max()
    low120 = close.rolling(120, min_periods=60).min()
    range120 = high120 / low120 - 1.0
    rel_ma60 = rel.rolling(60, min_periods=30).mean()
    rel_high120 = rel.rolling(120, min_periods=60).max()
    vol60 = close.pct_change(fill_method=None).rolling(60, min_periods=30).std()
    slope60 = close.rolling(60, min_periods=40).apply(linear_slope, raw=False)
    rank20 = rank_pct_desc(ret20)
    rank60 = rank_pct_desc(ret60)
    return {
        "eq_nav": eq_nav,
        "rel": rel,
        "ret20": ret20,
        "ret60": ret60,
        "ret120": ret120,
        "ret252": ret252,
        "ma20": ma20,
        "ma60": ma60,
        "ma120": ma120,
        "high120": high120,
        "low120": low120,
        "range120": range120,
        "rel_ma60": rel_ma60,
        "rel_high120": rel_high120,
        "vol60": vol60,
        "slope60": slope60,
        "rank20": rank20,
        "rank60": rank60,
    }


def valid_start(code: str, date: pd.Timestamp, close: pd.DataFrame, ind: dict[str, pd.DataFrame | pd.Series], params: CycleParams) -> bool:
    price = close.at[date, code]
    if pd.isna(price):
        return False
    loc = close.index.get_loc(date)
    if not isinstance(loc, (int, np.integer)) or loc < params.min_history:
        return False
    ma60 = ind["ma60"].at[date, code]  # type: ignore[index]
    ma120 = ind["ma120"].at[date, code]  # type: ignore[index]
    rel = ind["rel"].at[date, code]  # type: ignore[index]
    rel_ma60 = ind["rel_ma60"].at[date, code]  # type: ignore[index]
    rel_high120 = ind["rel_high120"].at[date, code]  # type: ignore[index]
    ret60 = ind["ret60"].at[date, code]  # type: ignore[index]
    ret120 = ind["ret120"].at[date, code]  # type: ignore[index]
    rank20 = ind["rank20"].at[date, code]  # type: ignore[index]
    rank60 = ind["rank60"].at[date, code]  # type: ignore[index]
    if any(pd.isna(x) for x in [ma60, ma120, rel, rel_ma60, rel_high120, ret60, ret120, rank20, rank60]):
        return False
    absolute_trend = price > ma60 and price > ma120 and (ret60 > 0.08 or ret120 > 0.12)
    relative_trend = rel > rel_ma60 and rel >= rel_high120 * 0.98
    leadership = rank20 <= params.start_rank_pct or rank60 <= params.start_rank_pct
    return bool(absolute_trend and relative_trend and leadership)


def valid_end(
    code: str,
    date: pd.Timestamp,
    close: pd.DataFrame,
    ind: dict[str, pd.DataFrame | pd.Series],
    peak_price: float,
    days_in_cycle: int,
    params: CycleParams,
) -> bool:
    if days_in_cycle < params.min_cycle_days:
        return False
    price = close.at[date, code]
    if pd.isna(price):
        return False
    drawdown = price / peak_price - 1.0
    ma60 = ind["ma60"].at[date, code]  # type: ignore[index]
    rel = ind["rel"].at[date, code]  # type: ignore[index]
    rel_ma60 = ind["rel_ma60"].at[date, code]  # type: ignore[index]
    ret20 = ind["ret20"].at[date, code]  # type: ignore[index]
    rank20 = ind["rank20"].at[date, code]  # type: ignore[index]
    hard_break = drawdown <= params.hard_drawdown
    soft_break = drawdown <= params.soft_drawdown and pd.notna(rank20) and rank20 >= params.end_rank_pct
    trend_break = pd.notna(ma60) and pd.notna(rel_ma60) and pd.notna(ret20) and price < ma60 and rel < rel_ma60 and ret20 < 0
    return bool(hard_break or soft_break or trend_break)


def detect_cycles(close: pd.DataFrame, ind: dict[str, pd.DataFrame | pd.Series], params: CycleParams) -> pd.DataFrame:
    rows = []
    dates = close.index
    for code in close.columns:
        in_cycle = False
        start_date = None
        start_price = np.nan
        peak_date = None
        peak_price = -np.inf
        trough_price = np.inf
        trough_date = None
        pullback_10_count = 0
        pullback_15_count = 0
        last_pullback_10_active = False
        last_pullback_15_active = False
        for date in dates:
            price = close.at[date, code]
            if pd.isna(price):
                continue
            if not in_cycle:
                if valid_start(code, date, close, ind, params):
                    in_cycle = True
                    start_date = date
                    start_price = float(price)
                    peak_date = date
                    peak_price = float(price)
                    trough_price = float(price)
                    trough_date = date
                    pullback_10_count = 0
                    pullback_15_count = 0
                    last_pullback_10_active = False
                    last_pullback_15_active = False
                continue

            assert start_date is not None and peak_date is not None
            if price > peak_price:
                peak_price = float(price)
                peak_date = date
                last_pullback_10_active = False
                last_pullback_15_active = False
            drawdown = float(price / peak_price - 1.0)
            if price < trough_price:
                trough_price = float(price)
                trough_date = date
            if drawdown <= -0.10 and not last_pullback_10_active:
                pullback_10_count += 1
                last_pullback_10_active = True
            if drawdown <= -0.15 and not last_pullback_15_active:
                pullback_15_count += 1
                last_pullback_15_active = True
            if drawdown > -0.05:
                last_pullback_10_active = False
                last_pullback_15_active = False
            days_in_cycle = int((date - start_date).days)
            trading_days = int(close.index.get_loc(date) - close.index.get_loc(start_date))
            if valid_end(code, date, close, ind, peak_price, trading_days, params):
                rows.append(
                    {
                        "code": code,
                        "name": ETF_POOL[code]["name"],
                        "group": ETF_POOL[code]["group"],
                        "start_date": start_date.date().isoformat(),
                        "end_date": date.date().isoformat(),
                        "peak_date": peak_date.date().isoformat(),
                        "trough_date": trough_date.date().isoformat() if trough_date is not None else None,
                        "calendar_days": days_in_cycle,
                        "trading_days": trading_days,
                        "start_to_end_return": float(price / start_price - 1.0),
                        "start_to_peak_return": float(peak_price / start_price - 1.0),
                        "peak_to_end_drawdown": float(price / peak_price - 1.0),
                        "max_drawdown_in_cycle": float(trough_price / peak_price - 1.0),
                        "pullback_10_count": pullback_10_count,
                        "pullback_15_count": pullback_15_count,
                        "start_rank20": float(ind["rank20"].at[start_date, code]),  # type: ignore[index]
                        "start_rank60": float(ind["rank60"].at[start_date, code]),  # type: ignore[index]
                    }
                )
                in_cycle = False
        if in_cycle and start_date is not None and peak_date is not None:
            last_price = float(close[code].dropna().iloc[-1])
            last_date = close[code].dropna().index[-1]
            rows.append(
                {
                    "code": code,
                    "name": ETF_POOL[code]["name"],
                    "group": ETF_POOL[code]["group"],
                    "start_date": start_date.date().isoformat(),
                    "end_date": last_date.date().isoformat(),
                    "peak_date": peak_date.date().isoformat(),
                    "trough_date": trough_date.date().isoformat() if trough_date is not None else None,
                    "calendar_days": int((last_date - start_date).days),
                    "trading_days": int(close.index.get_loc(last_date) - close.index.get_loc(start_date)),
                    "start_to_end_return": float(last_price / start_price - 1.0),
                    "start_to_peak_return": float(peak_price / start_price - 1.0),
                    "peak_to_end_drawdown": float(last_price / peak_price - 1.0),
                    "max_drawdown_in_cycle": float(trough_price / peak_price - 1.0),
                    "pullback_10_count": pullback_10_count,
                    "pullback_15_count": pullback_15_count,
                    "start_rank20": float(ind["rank20"].at[start_date, code]),  # type: ignore[index]
                    "start_rank60": float(ind["rank60"].at[start_date, code]),  # type: ignore[index]
                    "open_cycle": True,
                }
            )
    cycles = pd.DataFrame(rows)
    if "open_cycle" not in cycles:
        cycles["open_cycle"] = False
    cycles["open_cycle"] = cycles["open_cycle"].fillna(False)
    return cycles


def detect_bottoms(close: pd.DataFrame, ind: dict[str, pd.DataFrame | pd.Series], params: CycleParams) -> pd.DataFrame:
    rows = []
    for code in close.columns:
        price = close[code]
        cond = (
            (ind["range120"][code] <= params.bottom_range_120)  # type: ignore[index]
            & (ind["ret120"][code].abs() <= params.bottom_abs_ret_120)  # type: ignore[index]
            & ((price / ind["ma120"][code] - 1.0).abs() <= params.bottom_ma120_band)  # type: ignore[index]
        )
        cond = cond.fillna(False)
        start = None
        for date, is_bottom in cond.items():
            if is_bottom and start is None:
                start = date
            if (not is_bottom) and start is not None:
                end = previous_date
                td = int(close.index.get_loc(end) - close.index.get_loc(start))
                if td >= 40:
                    end_pos = close.index.get_loc(end)
                    future_60 = np.nan
                    future_120 = np.nan
                    if end_pos + 60 < len(close.index) and pd.notna(price.iloc[end_pos + 60]) and pd.notna(price.loc[end]):
                        future_60 = float(price.iloc[end_pos + 60] / price.loc[end] - 1.0)
                    if end_pos + 120 < len(close.index) and pd.notna(price.iloc[end_pos + 120]) and pd.notna(price.loc[end]):
                        future_120 = float(price.iloc[end_pos + 120] / price.loc[end] - 1.0)
                    rows.append(
                        {
                            "code": code,
                            "name": ETF_POOL[code]["name"],
                            "group": ETF_POOL[code]["group"],
                            "start_date": start.date().isoformat(),
                            "end_date": end.date().isoformat(),
                            "trading_days": td,
                            "calendar_days": int((end - start).days),
                            "period_return": float(price.loc[end] / price.loc[start] - 1.0),
                            "range_return": float(price.loc[start:end].max() / price.loc[start:end].min() - 1.0),
                            "future_60d_return_after_end": future_60,
                            "future_120d_return_after_end": future_120,
                        }
                    )
                start = None
            previous_date = date
        if start is not None:
            end = cond.index[-1]
            td = int(close.index.get_loc(end) - close.index.get_loc(start))
            if td >= 40:
                rows.append(
                    {
                        "code": code,
                        "name": ETF_POOL[code]["name"],
                        "group": ETF_POOL[code]["group"],
                        "start_date": start.date().isoformat(),
                        "end_date": end.date().isoformat(),
                        "trading_days": td,
                        "calendar_days": int((end - start).days),
                        "period_return": float(price.loc[end] / price.loc[start] - 1.0),
                        "range_return": float(price.loc[start:end].max() / price.loc[start:end].min() - 1.0),
                        "future_60d_return_after_end": np.nan,
                        "future_120d_return_after_end": np.nan,
                        "open_bottom": True,
                    }
                )
    bottoms = pd.DataFrame(rows)
    if "open_bottom" not in bottoms:
        bottoms["open_bottom"] = False
    bottoms["open_bottom"] = bottoms["open_bottom"].fillna(False)
    return bottoms


def detect_drawdowns(close: pd.DataFrame, thresholds: list[float]) -> pd.DataFrame:
    rows = []
    for code in close.columns:
        series = close[code].dropna()
        for threshold in thresholds:
            peak_date = series.index[0]
            peak_price = float(series.iloc[0])
            in_event = False
            trigger_date = None
            trough_date = None
            trough_price = peak_price
            for date, price_value in series.items():
                price = float(price_value)
                if not in_event:
                    if price > peak_price:
                        peak_price = price
                        peak_date = date
                    drawdown = price / peak_price - 1.0
                    if drawdown <= -threshold:
                        in_event = True
                        trigger_date = date
                        trough_date = date
                        trough_price = price
                    continue
                if price < trough_price:
                    trough_price = price
                    trough_date = date
                recovered = price >= peak_price
                if recovered:
                    rows.append(drawdown_event_record(code, threshold, series, peak_date, peak_price, trigger_date, trough_date, trough_price, date, True))
                    in_event = False
                    peak_date = date
                    peak_price = price
                    trigger_date = None
                    trough_date = None
                    trough_price = price
            if in_event and trigger_date is not None and trough_date is not None:
                rows.append(drawdown_event_record(code, threshold, series, peak_date, peak_price, trigger_date, trough_date, trough_price, series.index[-1], False))
    return pd.DataFrame(rows)


def forward_return(series: pd.Series, date: pd.Timestamp, days: int) -> float:
    pos = series.index.get_loc(date)
    if not isinstance(pos, (int, np.integer)) or pos + days >= len(series):
        return np.nan
    return float(series.iloc[pos + days] / series.iloc[pos] - 1.0)


def max_runup(series: pd.Series, date: pd.Timestamp, days: int) -> float:
    pos = series.index.get_loc(date)
    if not isinstance(pos, (int, np.integer)) or pos + 1 >= len(series):
        return np.nan
    window = series.iloc[pos : min(pos + days + 1, len(series))]
    return float(window.max() / window.iloc[0] - 1.0)


def drawdown_event_record(
    code: str,
    threshold: float,
    series: pd.Series,
    peak_date: pd.Timestamp,
    peak_price: float,
    trigger_date: pd.Timestamp | None,
    trough_date: pd.Timestamp | None,
    trough_price: float,
    end_date: pd.Timestamp,
    recovered: bool,
) -> dict[str, object]:
    assert trigger_date is not None and trough_date is not None
    return {
        "code": code,
        "name": ETF_POOL[code]["name"],
        "group": ETF_POOL[code]["group"],
        "threshold": threshold,
        "peak_date": peak_date.date().isoformat(),
        "trigger_date": trigger_date.date().isoformat(),
        "trough_date": trough_date.date().isoformat(),
        "end_date": end_date.date().isoformat(),
        "peak_to_trigger_days": int((trigger_date - peak_date).days),
        "peak_to_trough_days": int((trough_date - peak_date).days),
        "trigger_to_trough_days": int((trough_date - trigger_date).days),
        "recovery_days_from_trough": int((end_date - trough_date).days) if recovered else np.nan,
        "event_calendar_days": int((end_date - peak_date).days),
        "trough_drawdown": float(trough_price / peak_price - 1.0),
        "recovered": recovered,
        "return_20d_after_trough": forward_return(series, trough_date, 20),
        "return_60d_after_trough": forward_return(series, trough_date, 60),
        "return_120d_after_trough": forward_return(series, trough_date, 120),
        "max_runup_60d_after_trough": max_runup(series, trough_date, 60),
        "max_runup_120d_after_trough": max_runup(series, trough_date, 120),
    }


def summarize_cycles(cycles: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    overall = pd.DataFrame(
        [
            {
                "cycles": len(cycles),
                "median_trading_days": cycles["trading_days"].median(),
                "min_trading_days": cycles["trading_days"].min(),
                "max_trading_days": cycles["trading_days"].max(),
                "median_start_to_peak_return": cycles["start_to_peak_return"].median(),
                "avg_start_to_peak_return": cycles["start_to_peak_return"].mean(),
                "median_start_to_end_return": cycles["start_to_end_return"].median(),
                "avg_start_to_end_return": cycles["start_to_end_return"].mean(),
                "median_max_drawdown": cycles["max_drawdown_in_cycle"].median(),
                "avg_max_drawdown": cycles["max_drawdown_in_cycle"].mean(),
                "cycle_positive_rate": (cycles["start_to_end_return"] > 0).mean(),
                "open_cycles": int(cycles["open_cycle"].sum()),
            }
        ]
    )
    by_sector = (
        cycles.groupby(["code", "name", "group"])
        .agg(
            cycles=("start_date", "count"),
            median_trading_days=("trading_days", "median"),
            max_trading_days=("trading_days", "max"),
            median_start_to_peak_return=("start_to_peak_return", "median"),
            max_start_to_peak_return=("start_to_peak_return", "max"),
            median_start_to_end_return=("start_to_end_return", "median"),
            median_max_drawdown=("max_drawdown_in_cycle", "median"),
            worst_max_drawdown=("max_drawdown_in_cycle", "min"),
            avg_pullback_10_count=("pullback_10_count", "mean"),
            avg_pullback_15_count=("pullback_15_count", "mean"),
        )
        .reset_index()
        .sort_values(["median_start_to_peak_return", "cycles"], ascending=False)
    )
    return overall, by_sector


def cycle_duration_buckets(cycles: pd.DataFrame) -> pd.DataFrame:
    bins = [-1, 21, 63, 126, 252, np.inf]
    labels = ["<=1个月", "1-3个月", "3-6个月", "6-12个月", ">12个月"]
    data = cycles.copy()
    data["duration_bucket"] = pd.cut(data["trading_days"], bins=bins, labels=labels)
    return (
        data.groupby("duration_bucket", observed=False)
        .agg(
            cycles=("start_date", "count"),
            median_trading_days=("trading_days", "median"),
            min_trading_days=("trading_days", "min"),
            max_trading_days=("trading_days", "max"),
            median_start_to_peak_return=("start_to_peak_return", "median"),
            median_start_to_end_return=("start_to_end_return", "median"),
            median_max_drawdown=("max_drawdown_in_cycle", "median"),
            positive_rate=("start_to_end_return", lambda x: float((x > 0).mean()) if len(x) else np.nan),
        )
        .reset_index()
    )


def summarize_drawdowns(drawdowns: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    by_threshold = (
        drawdowns.groupby("threshold")
        .agg(
            events=("code", "count"),
            sectors_touched=("code", "nunique"),
            median_trough_drawdown=("trough_drawdown", "median"),
            worst_trough_drawdown=("trough_drawdown", "min"),
            recovery_rate=("recovered", "mean"),
            median_recovery_days_from_trough=("recovery_days_from_trough", "median"),
            median_return_20d_after_trough=("return_20d_after_trough", "median"),
            median_return_60d_after_trough=("return_60d_after_trough", "median"),
            median_return_120d_after_trough=("return_120d_after_trough", "median"),
            median_max_runup_120d_after_trough=("max_runup_120d_after_trough", "median"),
            max_return_120d_after_trough=("return_120d_after_trough", "max"),
            max_runup_120d_after_trough=("max_runup_120d_after_trough", "max"),
        )
        .reset_index()
    )
    by_sector = (
        drawdowns.groupby(["code", "name", "group", "threshold"])
        .agg(
            events=("trigger_date", "count"),
            median_trough_drawdown=("trough_drawdown", "median"),
            worst_trough_drawdown=("trough_drawdown", "min"),
            recovery_rate=("recovered", "mean"),
            median_return_60d_after_trough=("return_60d_after_trough", "median"),
            median_max_runup_120d_after_trough=("max_runup_120d_after_trough", "median"),
        )
        .reset_index()
        .sort_values(["threshold", "events"], ascending=[True, False])
    )
    return by_threshold, by_sector


def markdown_table(df: pd.DataFrame, columns: list[str], max_rows: int | None = None) -> str:
    view = df.loc[:, columns].copy()
    if max_rows is not None:
        view = view.head(max_rows)
    return view.to_markdown(index=False)


def make_report(
    close: pd.DataFrame,
    cycles: pd.DataFrame,
    cycle_summary: pd.DataFrame,
    cycle_by_sector: pd.DataFrame,
    duration_summary: pd.DataFrame,
    drawdown_summary: pd.DataFrame,
    drawdown_by_sector: pd.DataFrame,
    bottoms: pd.DataFrame,
    bottom_summary: pd.DataFrame,
) -> str:
    strongest = cycle_by_sector.head(8).copy()
    weakest_dd = cycle_by_sector.sort_values("worst_max_drawdown").head(8).copy()
    dd_top_counts = (
        drawdown_by_sector[drawdown_by_sector["threshold"] == 0.15]
        .sort_values(["events", "worst_trough_drawdown"], ascending=[False, True])
        .head(10)
        .copy()
    )
    bottom_top = bottom_summary.sort_values("median_trading_days", ascending=False).head(10).copy()

    for df in [cycle_summary, cycle_by_sector, duration_summary, drawdown_summary, drawdown_by_sector, bottom_summary, strongest, weakest_dd, dd_top_counts, bottom_top]:
        for col in df.columns:
            if "return" in col or "drawdown" in col or "rate" in col or "runup" in col:
                df[col] = df[col].map(lambda x: pct(x) if pd.notna(x) else "NA")
            elif "days" in col or "count" in col or "cycles" in col or "events" in col or "sectors_touched" in col:
                df[col] = df[col].map(lambda x: num(x, 0) if pd.notna(x) else "NA")

    report = f"""# 板块指数周期深度分析报告

生成日期：2026-07-18

## 研究口径

本报告使用 19 个行业/主题 ETF 作为板块指数代理，样本区间为 2015-01-01 至 2026-07-17。ETF 数据来自 AKShare `fund_etf_hist_sina` 缓存，并沿用前序研究中的拆分跳点修正。

需要先明确：这里分析的是“可交易的板块价格周期”，不是严格的行业基本面周期。价格周期的重点是识别资金推动下的相对强弱阶段。

## 状态定义

本轮分析把视觉语言转成以下可计算规则：

- 筑底期：120 日振幅小于 35%，120 日收益在 -15% 到 +15% 之间，价格在 120 日均线上下 10% 内。
- 周期启动：价格站上 60 日和 120 日均线，60/120 日收益为正，板块相对 ETF 等权池站上 60 日相对强度均线且接近 120 日相对强度新高，20/60 日收益排名进入前 30%。
- 周期结束：至少运行 20 个交易日后，出现 25% 硬回撤，或 15% 回撤且排名跌出前 60%，或价格和相对强度同时跌破 60 日趋势。
- 独立回撤事件：从历史高点回撤达到 10%、15%、20% 后，统计最低点、是否修复、修复时间和低点后反弹。

## 样本概况

- ETF 数量：{close.shape[1]}。
- 日线样本：{close.index.min().date()} 至 {close.index.max().date()}。
- 识别趋势周期数：{len(cycles)}。
- 识别筑底区间数：{len(bottoms)}。

## 趋势周期总体统计

{markdown_table(cycle_summary, ["cycles", "median_trading_days", "min_trading_days", "max_trading_days", "median_start_to_peak_return", "avg_start_to_peak_return", "median_start_to_end_return", "median_max_drawdown", "cycle_positive_rate", "open_cycles"])}

解释：

- 中位周期长度代表“从确认启动到趋势失效”的典型持续时间。
- `start_to_peak_return` 是确认启动后到阶段高点的涨幅。
- `start_to_end_return` 是确认启动到退出信号的完整收益，通常低于峰值涨幅，因为退出不可能卖在最高点。
- `max_drawdown_in_cycle` 是周期内从峰值到低点的最大回撤。

## 各板块周期强度

## 周期长度分布

{markdown_table(duration_summary, ["duration_bucket", "cycles", "median_trading_days", "min_trading_days", "max_trading_days", "median_start_to_peak_return", "median_start_to_end_return", "median_max_drawdown", "positive_rate"])}

解释：

- 1-3 个月内结束的周期很多，说明大量板块行情是交易性波段，而不是产业大周期。
- 周期越长，理论上越可能对应真正主线，但也更容易包含多轮 10% 以上回撤。

## 各板块周期强度

按周期内中位峰值涨幅排序：

{markdown_table(strongest, ["code", "name", "group", "cycles", "median_trading_days", "median_start_to_peak_return", "max_start_to_peak_return", "median_start_to_end_return", "median_max_drawdown", "avg_pullback_10_count"], 8)}

周期内最严重回撤的板块：

{markdown_table(weakest_dd, ["code", "name", "group", "cycles", "median_trading_days", "median_start_to_peak_return", "worst_max_drawdown", "avg_pullback_10_count", "avg_pullback_15_count"], 8)}

## 10% / 15% / 20% 回撤事件

{markdown_table(drawdown_summary, ["threshold", "events", "sectors_touched", "median_trough_drawdown", "worst_trough_drawdown", "recovery_rate", "median_recovery_days_from_trough", "median_return_20d_after_trough", "median_return_60d_after_trough", "median_return_120d_after_trough", "median_max_runup_120d_after_trough", "max_runup_120d_after_trough"])}

解释：

- `events` 是达到该回撤阈值的独立事件数。
- `recovery_rate` 是回撤后重新回到前高的比例。
- `return_60d_after_trough` 是从最低点开始算 60 个交易日后的收益。
- `max_runup_120d_after_trough` 是低点后 120 个交易日内最大反弹幅度。

15% 回撤事件最多的板块：

{markdown_table(dd_top_counts, ["code", "name", "group", "threshold", "events", "median_trough_drawdown", "worst_trough_drawdown", "recovery_rate", "median_return_60d_after_trough", "median_max_runup_120d_after_trough"], 10)}

## 筑底区间统计

{markdown_table(bottom_top, ["code", "name", "group", "bottoms", "median_trading_days", "max_trading_days", "median_range_return", "median_future_60d_return_after_end", "median_future_120d_return_after_end"], 10)}

解释：

- 筑底不是买点，只是“趋势低活跃、波动收敛、价格横住”的状态。
- 筑底结束后的未来收益并不稳定，需要后续突破和相对强度确认。

## 主要发现

1. 板块周期不是固定 12 个月。多数可交易周期持续数月，少数产业趋势可以延伸到 1 年以上。用固定持有期理解板块轮动会过粗。

2. 周期的“启动点”不是最低点，而是趋势和相对强度被确认后的点。因此统计上的周期涨幅低于肉眼从最低点到最高点看到的涨幅，这是正常的。

3. 10% 回撤在板块 ETF 中很常见，不能自动视为周期结束。15% 回撤更接近趋势破坏的预警线，20% 回撤通常意味着周期已经进入深度调整或急跌。

4. 低点后的反弹存在，但不能直接做“跌够就买”。回撤后能否修复，取决于相对强度是否重新走强、是否重新站上均线、板块是否重新进入排名前列。

5. 筑底状态本身只说明“跌不动或波动收敛”，不说明新周期已经开始。新周期需要突破箱体和相对强度确认。

## 后续策略建议

下一版策略不应只用 6/12 个月动量排名，而应按状态机处理：

- 筑底期：记录观察，不急于买入。
- 启动期：用小仓位试探，要求价格突破和相对强度突破同时出现。
- 主升期：持有，允许 5%-10% 正常波动，不因小回撤频繁换仓。
- 衰退期：相对强度破坏或排名跌出前 50% 时降权。
- 急跌期：15%-20% 回撤后不直接抄底，等待再筑底和重新启动。

## 输出文件

- 周期明细：`lab/backtests/sector_cycle_analysis/cycles.csv`
- 周期汇总：`lab/backtests/sector_cycle_analysis/cycle_summary.csv`
- 分板块周期汇总：`lab/backtests/sector_cycle_analysis/cycle_by_sector.csv`
- 回撤事件明细：`lab/backtests/sector_cycle_analysis/drawdown_events.csv`
- 回撤汇总：`lab/backtests/sector_cycle_analysis/drawdown_summary.csv`
- 筑底区间明细：`lab/backtests/sector_cycle_analysis/bottom_periods.csv`
- 本报告：`docs/research/sector-cycle-analysis-report.md`
"""
    return report


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    params = CycleParams()
    close = load_sector_prices()
    ind = build_indicators(close)
    cycles = detect_cycles(close, ind, params)
    bottoms = detect_bottoms(close, ind, params)
    drawdowns = detect_drawdowns(close, [0.10, 0.15, 0.20])
    cycle_summary, cycle_by_sector = summarize_cycles(cycles)
    duration_summary = cycle_duration_buckets(cycles)
    drawdown_summary, drawdown_by_sector = summarize_drawdowns(drawdowns)
    bottom_summary = (
        bottoms.groupby(["code", "name", "group"])
        .agg(
            bottoms=("start_date", "count"),
            median_trading_days=("trading_days", "median"),
            max_trading_days=("trading_days", "max"),
            median_range_return=("range_return", "median"),
            median_future_60d_return_after_end=("future_60d_return_after_end", "median"),
            median_future_120d_return_after_end=("future_120d_return_after_end", "median"),
        )
        .reset_index()
    )

    cycles.to_csv(OUTPUT_DIR / "cycles.csv", index=False)
    cycle_summary.to_csv(OUTPUT_DIR / "cycle_summary.csv", index=False)
    cycle_by_sector.to_csv(OUTPUT_DIR / "cycle_by_sector.csv", index=False)
    duration_summary.to_csv(OUTPUT_DIR / "cycle_duration_summary.csv", index=False)
    drawdowns.to_csv(OUTPUT_DIR / "drawdown_events.csv", index=False)
    drawdown_summary.to_csv(OUTPUT_DIR / "drawdown_summary.csv", index=False)
    drawdown_by_sector.to_csv(OUTPUT_DIR / "drawdown_by_sector.csv", index=False)
    bottoms.to_csv(OUTPUT_DIR / "bottom_periods.csv", index=False)
    bottom_summary.to_csv(OUTPUT_DIR / "bottom_summary.csv", index=False)

    payload = {
        "data": {"start": START, "end": END, "sector_count": int(close.shape[1])},
        "params": params.__dict__,
        "cycle_summary": cycle_summary.to_dict("records"),
        "drawdown_summary": drawdown_summary.to_dict("records"),
        "outputs": {
            "cycles": str(OUTPUT_DIR / "cycles.csv"),
            "drawdowns": str(OUTPUT_DIR / "drawdown_events.csv"),
            "bottoms": str(OUTPUT_DIR / "bottom_periods.csv"),
            "report": str(REPORT_PATH),
        },
    }
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    report = make_report(close, cycles, cycle_summary, cycle_by_sector, duration_summary, drawdown_summary, drawdown_by_sector, bottoms, bottom_summary)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Detailed cycle analysis for SW first-level sector indices."""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from pathlib import Path

import akshare as ak
import numpy as np
import pandas as pd
import requests


START = "19991230"
END = "20260718"
OUTPUT_DIR = Path("lab/backtests/sw_sector_cycle_analysis")
CACHE_DIR = OUTPUT_DIR / "akshare_cache"
REPORT_PATH = Path("docs/research/sw-sector-index-cycle-analysis-report.md")
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


def disable_requests_env_proxy() -> None:
    original = requests.sessions.Session.merge_environment_settings

    def merge_without_proxy(self, url, proxies, stream, verify, cert):  # type: ignore[no-untyped-def]
        settings = original(self, url, proxies, stream, verify, cert)
        settings["proxies"] = {}
        return settings

    requests.sessions.Session.merge_environment_settings = merge_without_proxy


def pct(value: float | None, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value * 100:.{digits}f}%"


def num(value: float | int | None, digits: int = 1) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{value:.{digits}f}"


def load_sw_first_info() -> pd.DataFrame:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / "sw_first_info.csv"
    if cache_file.exists():
        return pd.read_csv(cache_file, dtype={"行业代码": str})
    info = ak.sw_index_first_info()
    info.to_csv(cache_file, index=False)
    return info


def normalize_sw_code(code: str) -> str:
    return str(code).split(".")[0]


def fetch_sw_index(code: str, name: str) -> pd.DataFrame:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    raw_code = normalize_sw_code(code)
    cache_file = CACHE_DIR / f"sw_{raw_code}_{START}_{END}.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file)
    else:
        raw = ak.index_hist_sw(symbol=raw_code, period="day")
        raw.to_csv(cache_file, index=False)
        time.sleep(0.2)
    df = raw.rename(columns={"日期": "date", "收盘": "close", "开盘": "open", "最高": "high", "最低": "low", "成交量": "volume", "成交额": "amount"})
    df["date"] = pd.to_datetime(df["date"])
    for col in ["open", "high", "low", "close", "volume", "amount"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df[(df["date"] >= pd.to_datetime(START)) & (df["date"] <= pd.to_datetime(END))]
    df = df.sort_values("date").dropna(subset=["close"])
    df["code"] = raw_code
    df["name"] = name
    return df[["date", "code", "name", "open", "high", "low", "close", "volume", "amount"]]


def load_sector_data() -> tuple[pd.DataFrame, pd.DataFrame]:
    info = load_sw_first_info()
    rows = []
    meta_rows = []
    for row in info.itertuples(index=False):
        code = normalize_sw_code(getattr(row, "行业代码"))
        name = getattr(row, "行业名称")
        try:
            df = fetch_sw_index(code, name)
            rows.append(df)
            meta_rows.append(
                {
                    "code": code,
                    "name": name,
                    "rows": len(df),
                    "start": df["date"].min().date().isoformat(),
                    "end": df["date"].max().date().isoformat(),
                    "status": "ok",
                }
            )
        except Exception as exc:  # noqa: BLE001
            meta_rows.append({"code": code, "name": name, "rows": 0, "start": None, "end": None, "status": f"{type(exc).__name__}: {exc}"})
    all_bars = pd.concat(rows, ignore_index=True)
    meta = pd.DataFrame(meta_rows)
    all_bars.to_csv(OUTPUT_DIR / "sw_first_level_daily_bars.csv", index=False)
    meta.to_csv(OUTPUT_DIR / "universe.csv", index=False)
    return all_bars, meta


def pivot_prices(bars: pd.DataFrame, field: str = "close") -> pd.DataFrame:
    return bars.pivot(index="date", columns="code", values=field).sort_index()


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
        "slope60": slope60,
        "rank20": rank20,
        "rank60": rank60,
    }


def get_meta(meta: pd.DataFrame) -> dict[str, dict[str, str]]:
    return {row.code: {"name": row.name} for row in meta.itertuples(index=False)}


def valid_start(code: str, date: pd.Timestamp, close: pd.DataFrame, ind: dict[str, pd.DataFrame | pd.Series], params: CycleParams) -> bool:
    price = close.at[date, code]
    if pd.isna(price):
        return False
    loc = close.index.get_loc(date)
    if not isinstance(loc, (int, np.integer)) or loc < params.min_history:
        return False
    values = [
        ind["ma60"].at[date, code],  # type: ignore[index]
        ind["ma120"].at[date, code],  # type: ignore[index]
        ind["rel"].at[date, code],  # type: ignore[index]
        ind["rel_ma60"].at[date, code],  # type: ignore[index]
        ind["rel_high120"].at[date, code],  # type: ignore[index]
        ind["ret60"].at[date, code],  # type: ignore[index]
        ind["ret120"].at[date, code],  # type: ignore[index]
        ind["rank20"].at[date, code],  # type: ignore[index]
        ind["rank60"].at[date, code],  # type: ignore[index]
    ]
    if any(pd.isna(x) for x in values):
        return False
    ma60, ma120, rel, rel_ma60, rel_high120, ret60, ret120, rank20, rank60 = values
    absolute_trend = price > ma60 and price > ma120 and (ret60 > 0.08 or ret120 > 0.12)
    relative_trend = rel > rel_ma60 and rel >= rel_high120 * 0.98
    leadership = rank20 <= params.start_rank_pct or rank60 <= params.start_rank_pct
    return bool(absolute_trend and relative_trend and leadership)


def end_reason(
    code: str,
    date: pd.Timestamp,
    close: pd.DataFrame,
    ind: dict[str, pd.DataFrame | pd.Series],
    peak_price: float,
    trading_days: int,
    params: CycleParams,
) -> str | None:
    if trading_days < params.min_cycle_days:
        return None
    price = close.at[date, code]
    if pd.isna(price):
        return None
    drawdown = price / peak_price - 1.0
    ma60 = ind["ma60"].at[date, code]  # type: ignore[index]
    rel = ind["rel"].at[date, code]  # type: ignore[index]
    rel_ma60 = ind["rel_ma60"].at[date, code]  # type: ignore[index]
    ret20 = ind["ret20"].at[date, code]  # type: ignore[index]
    rank20 = ind["rank20"].at[date, code]  # type: ignore[index]
    if drawdown <= params.hard_drawdown:
        return "25%硬回撤"
    if drawdown <= params.soft_drawdown and pd.notna(rank20) and rank20 >= params.end_rank_pct:
        return "15%回撤且排名转弱"
    if pd.notna(ma60) and pd.notna(rel_ma60) and pd.notna(ret20) and price < ma60 and rel < rel_ma60 and ret20 < 0:
        return "价格与相对强度跌破60日趋势"
    return None


def detect_cycles(close: pd.DataFrame, high: pd.DataFrame, low: pd.DataFrame, ind: dict[str, pd.DataFrame | pd.Series], meta_map: dict[str, dict[str, str]], params: CycleParams) -> pd.DataFrame:
    rows = []
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
        pullback_20_count = 0
        active_10 = False
        active_15 = False
        active_20 = False
        for date in close.index:
            price = close.at[date, code]
            if pd.isna(price):
                continue
            if not in_cycle:
                if valid_start(code, date, close, ind, params):
                    in_cycle = True
                    start_date = date
                    start_price = float(price)
                    peak_date = date
                    peak_price = float(high.at[date, code]) if pd.notna(high.at[date, code]) else float(price)
                    trough_price = float(low.at[date, code]) if pd.notna(low.at[date, code]) else float(price)
                    trough_date = date
                    pullback_10_count = pullback_15_count = pullback_20_count = 0
                    active_10 = active_15 = active_20 = False
                continue
            assert start_date is not None and peak_date is not None
            current_high = float(high.at[date, code]) if pd.notna(high.at[date, code]) else float(price)
            current_low = float(low.at[date, code]) if pd.notna(low.at[date, code]) else float(price)
            if current_high > peak_price:
                peak_price = current_high
                peak_date = date
                active_10 = active_15 = active_20 = False
            if current_low < trough_price:
                trough_price = current_low
                trough_date = date
            drawdown = float(current_low / peak_price - 1.0)
            if drawdown <= -0.10 and not active_10:
                pullback_10_count += 1
                active_10 = True
            if drawdown <= -0.15 and not active_15:
                pullback_15_count += 1
                active_15 = True
            if drawdown <= -0.20 and not active_20:
                pullback_20_count += 1
                active_20 = True
            if drawdown > -0.05:
                active_10 = active_15 = active_20 = False
            trading_days = int(close.index.get_loc(date) - close.index.get_loc(start_date))
            reason = end_reason(code, date, close, ind, peak_price, trading_days, params)
            if reason:
                rows.append(
                    {
                        "code": code,
                        "name": meta_map[code]["name"],
                        "start_date": start_date.date().isoformat(),
                        "end_date": date.date().isoformat(),
                        "peak_date": peak_date.date().isoformat(),
                        "trough_date": trough_date.date().isoformat() if trough_date is not None else None,
                        "trading_days": trading_days,
                        "calendar_days": int((date - start_date).days),
                        "start_price": start_price,
                        "end_price": float(price),
                        "peak_price": peak_price,
                        "trough_price": trough_price,
                        "start_to_peak_return": float(peak_price / start_price - 1.0),
                        "start_to_end_return": float(price / start_price - 1.0),
                        "max_drawdown_in_cycle": float(trough_price / peak_price - 1.0),
                        "peak_to_end_drawdown": float(price / peak_price - 1.0),
                        "pullback_10_count": pullback_10_count,
                        "pullback_15_count": pullback_15_count,
                        "pullback_20_count": pullback_20_count,
                        "end_reason": reason,
                        "open_cycle": False,
                    }
                )
                in_cycle = False
        if in_cycle and start_date is not None and peak_date is not None:
            last = close[code].dropna()
            last_date = last.index[-1]
            last_price = float(last.iloc[-1])
            rows.append(
                {
                    "code": code,
                    "name": meta_map[code]["name"],
                    "start_date": start_date.date().isoformat(),
                    "end_date": last_date.date().isoformat(),
                    "peak_date": peak_date.date().isoformat(),
                    "trough_date": trough_date.date().isoformat() if trough_date is not None else None,
                    "trading_days": int(close.index.get_loc(last_date) - close.index.get_loc(start_date)),
                    "calendar_days": int((last_date - start_date).days),
                    "start_price": start_price,
                    "end_price": last_price,
                    "peak_price": peak_price,
                    "trough_price": trough_price,
                    "start_to_peak_return": float(peak_price / start_price - 1.0),
                    "start_to_end_return": float(last_price / start_price - 1.0),
                    "max_drawdown_in_cycle": float(trough_price / peak_price - 1.0),
                    "peak_to_end_drawdown": float(last_price / peak_price - 1.0),
                    "pullback_10_count": pullback_10_count,
                    "pullback_15_count": pullback_15_count,
                    "pullback_20_count": pullback_20_count,
                    "end_reason": "未结束",
                    "open_cycle": True,
                }
            )
    return pd.DataFrame(rows)


def forward_return(series: pd.Series, date: pd.Timestamp, days: int) -> float:
    pos = series.index.get_loc(date)
    if not isinstance(pos, (int, np.integer)) or pos + days >= len(series):
        return np.nan
    return float(series.iloc[pos + days] / series.iloc[pos] - 1.0)


def max_runup(series: pd.Series, date: pd.Timestamp, days: int) -> float:
    pos = series.index.get_loc(date)
    if not isinstance(pos, (int, np.integer)):
        return np.nan
    window = series.iloc[pos : min(pos + days + 1, len(series))]
    return float(window.max() / window.iloc[0] - 1.0)


def detect_drawdowns(close: pd.DataFrame, meta_map: dict[str, dict[str, str]], thresholds: list[float]) -> pd.DataFrame:
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
                    if price / peak_price - 1.0 <= -threshold:
                        in_event = True
                        trigger_date = date
                        trough_date = date
                        trough_price = price
                    continue
                if price < trough_price:
                    trough_price = price
                    trough_date = date
                if price >= peak_price:
                    rows.append(drawdown_record(code, meta_map[code]["name"], threshold, series, peak_date, peak_price, trigger_date, trough_date, trough_price, date, True))
                    in_event = False
                    peak_date = date
                    peak_price = price
                    trigger_date = None
                    trough_date = None
                    trough_price = price
            if in_event and trigger_date is not None and trough_date is not None:
                rows.append(drawdown_record(code, meta_map[code]["name"], threshold, series, peak_date, peak_price, trigger_date, trough_date, trough_price, series.index[-1], False))
    return pd.DataFrame(rows)


def drawdown_record(
    code: str,
    name: str,
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
        "name": name,
        "threshold": threshold,
        "peak_date": peak_date.date().isoformat(),
        "trigger_date": trigger_date.date().isoformat(),
        "trough_date": trough_date.date().isoformat(),
        "end_date": end_date.date().isoformat(),
        "peak_price": peak_price,
        "trough_price": trough_price,
        "trough_drawdown": float(trough_price / peak_price - 1.0),
        "recovered": recovered,
        "peak_to_trough_days": int((trough_date - peak_date).days),
        "recovery_days_from_trough": int((end_date - trough_date).days) if recovered else np.nan,
        "return_20d_after_trough": forward_return(series, trough_date, 20),
        "return_60d_after_trough": forward_return(series, trough_date, 60),
        "return_120d_after_trough": forward_return(series, trough_date, 120),
        "max_runup_60d_after_trough": max_runup(series, trough_date, 60),
        "max_runup_120d_after_trough": max_runup(series, trough_date, 120),
    }


def detect_bottoms(close: pd.DataFrame, ind: dict[str, pd.DataFrame | pd.Series], meta_map: dict[str, dict[str, str]], params: CycleParams) -> pd.DataFrame:
    rows = []
    for code in close.columns:
        price = close[code]
        cond = (
            (ind["range120"][code] <= params.bottom_range_120)  # type: ignore[index]
            & (ind["ret120"][code].abs() <= params.bottom_abs_ret_120)  # type: ignore[index]
            & ((price / ind["ma120"][code] - 1.0).abs() <= params.bottom_ma120_band)  # type: ignore[index]
        ).fillna(False)
        start = None
        previous_date = None
        for date, is_bottom in cond.items():
            if is_bottom and start is None:
                start = date
            if (not is_bottom) and start is not None and previous_date is not None:
                end = previous_date
                td = int(close.index.get_loc(end) - close.index.get_loc(start))
                if td >= 40:
                    end_pos = close.index.get_loc(end)
                    rows.append(
                        {
                            "code": code,
                            "name": meta_map[code]["name"],
                            "start_date": start.date().isoformat(),
                            "end_date": end.date().isoformat(),
                            "trading_days": td,
                            "calendar_days": int((end - start).days),
                            "period_return": float(price.loc[end] / price.loc[start] - 1.0),
                            "range_return": float(price.loc[start:end].max() / price.loc[start:end].min() - 1.0),
                            "future_60d_return_after_end": float(price.iloc[end_pos + 60] / price.loc[end] - 1.0) if end_pos + 60 < len(price) and pd.notna(price.iloc[end_pos + 60]) else np.nan,
                            "future_120d_return_after_end": float(price.iloc[end_pos + 120] / price.loc[end] - 1.0) if end_pos + 120 < len(price) and pd.notna(price.iloc[end_pos + 120]) else np.nan,
                            "open_bottom": False,
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
                        "name": meta_map[code]["name"],
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
    return pd.DataFrame(rows)


def current_states(close: pd.DataFrame, ind: dict[str, pd.DataFrame | pd.Series], cycles: pd.DataFrame, bottoms: pd.DataFrame, meta_map: dict[str, dict[str, str]]) -> pd.DataFrame:
    rows = []
    date = close.index[-1]
    for code in close.columns:
        price = close.at[date, code]
        ma60 = ind["ma60"].at[date, code]  # type: ignore[index]
        ma120 = ind["ma120"].at[date, code]  # type: ignore[index]
        rel = ind["rel"].at[date, code]  # type: ignore[index]
        rel_ma60 = ind["rel_ma60"].at[date, code]  # type: ignore[index]
        rank20 = ind["rank20"].at[date, code]  # type: ignore[index]
        ret20 = ind["ret20"].at[date, code]  # type: ignore[index]
        ret60 = ind["ret60"].at[date, code]  # type: ignore[index]
        high120 = ind["high120"].at[date, code]  # type: ignore[index]
        drawdown_120 = price / high120 - 1.0 if pd.notna(high120) else np.nan
        is_open_cycle = False
        if not cycles.empty:
            sector_cycles = cycles[cycles["code"] == code]
            is_open_cycle = bool(len(sector_cycles) and bool(sector_cycles.iloc[-1].get("open_cycle", False)))
        sector_bottoms = bottoms[bottoms["code"] == code] if not bottoms.empty else pd.DataFrame()
        is_open_bottom = bool(len(sector_bottoms) and bool(sector_bottoms.iloc[-1].get("open_bottom", False)))
        if is_open_cycle and pd.notna(drawdown_120) and drawdown_120 <= -0.15:
            state = "衰退/回撤"
        elif is_open_cycle:
            state = "主升/强趋势"
        elif is_open_bottom:
            state = "筑底/横盘"
        elif pd.notna(ma60) and pd.notna(ma120) and pd.notna(rel_ma60) and price > ma60 and price > ma120 and rel > rel_ma60 and pd.notna(rank20) and rank20 <= 0.3:
            state = "启动观察"
        elif pd.notna(drawdown_120) and drawdown_120 <= -0.20 and pd.notna(ret20) and ret20 < 0:
            state = "急跌/深回撤"
        elif pd.notna(ma60) and price < ma60 and pd.notna(rel_ma60) and rel < rel_ma60:
            state = "弱势/衰退"
        else:
            state = "震荡/未确认"
        rows.append(
            {
                "code": code,
                "name": meta_map[code]["name"],
                "date": date.date().isoformat(),
                "state": state,
                "close": price,
                "ret20": ret20,
                "ret60": ret60,
                "rank20": rank20,
                "drawdown_from_120d_high": drawdown_120,
            }
        )
    return pd.DataFrame(rows)


def summarize(close: pd.DataFrame, cycles: pd.DataFrame, drawdowns: pd.DataFrame, bottoms: pd.DataFrame, states: pd.DataFrame, meta_map: dict[str, dict[str, str]]) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sector_rows = []
    for code in close.columns:
        s = close[code].dropna()
        nav = s / s.iloc[0]
        dd = nav / nav.cummax() - 1.0
        c = cycles[cycles["code"] == code]
        d = drawdowns[drawdowns["code"] == code]
        b = bottoms[bottoms["code"] == code]
        state = states.loc[states["code"] == code, "state"].iloc[0]
        sector_rows.append(
            {
                "code": code,
                "name": meta_map[code]["name"],
                "start": s.index[0].date().isoformat(),
                "end": s.index[-1].date().isoformat(),
                "years": (s.index[-1] - s.index[0]).days / 365.25,
                "total_return": float(s.iloc[-1] / s.iloc[0] - 1.0),
                "annual_return": float(nav.iloc[-1] ** (365.25 / max((s.index[-1] - s.index[0]).days, 1)) - 1.0),
                "max_drawdown": float(dd.min()),
                "cycles": len(c),
                "median_cycle_days": c["trading_days"].median() if len(c) else np.nan,
                "max_cycle_days": c["trading_days"].max() if len(c) else np.nan,
                "median_cycle_peak_return": c["start_to_peak_return"].median() if len(c) else np.nan,
                "max_cycle_peak_return": c["start_to_peak_return"].max() if len(c) else np.nan,
                "median_cycle_end_return": c["start_to_end_return"].median() if len(c) else np.nan,
                "median_cycle_drawdown": c["max_drawdown_in_cycle"].median() if len(c) else np.nan,
                "drawdown_10_events": len(d[d["threshold"] == 0.10]),
                "drawdown_15_events": len(d[d["threshold"] == 0.15]),
                "drawdown_20_events": len(d[d["threshold"] == 0.20]),
                "bottom_periods": len(b),
                "current_state": state,
            }
        )
    sector_summary = pd.DataFrame(sector_rows).sort_values("max_cycle_peak_return", ascending=False)
    cycle_summary = pd.DataFrame(
        [
            {
                "cycles": len(cycles),
                "median_trading_days": cycles["trading_days"].median(),
                "min_trading_days": cycles["trading_days"].min(),
                "max_trading_days": cycles["trading_days"].max(),
                "median_start_to_peak_return": cycles["start_to_peak_return"].median(),
                "median_start_to_end_return": cycles["start_to_end_return"].median(),
                "median_max_drawdown": cycles["max_drawdown_in_cycle"].median(),
                "positive_cycle_rate": (cycles["start_to_end_return"] > 0).mean(),
                "open_cycles": int(cycles["open_cycle"].sum()),
            }
        ]
    )
    dd_summary = (
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
        )
        .reset_index()
    )
    duration_summary = (
        cycles.assign(duration_bucket=pd.cut(cycles["trading_days"], [-1, 21, 63, 126, 252, 504, np.inf], labels=["<=1个月", "1-3个月", "3-6个月", "6-12个月", "1-2年", ">2年"]))
        .groupby("duration_bucket", observed=False)
        .agg(
            cycles=("code", "count"),
            median_trading_days=("trading_days", "median"),
            median_start_to_peak_return=("start_to_peak_return", "median"),
            median_start_to_end_return=("start_to_end_return", "median"),
            median_max_drawdown=("max_drawdown_in_cycle", "median"),
            positive_rate=("start_to_end_return", lambda x: float((x > 0).mean()) if len(x) else np.nan),
        )
        .reset_index()
    )
    return sector_summary, cycle_summary, dd_summary, duration_summary


def markdown_table(df: pd.DataFrame, columns: list[str], max_rows: int | None = None) -> str:
    view = df.loc[:, columns].copy()
    if max_rows is not None:
        view = view.head(max_rows)
    for col in view.columns:
        if "days" in col or "cycles" in col or "events" in col or "periods" in col or "touched" in col or col in {"pullback_10_count", "pullback_15_count", "pullback_20_count"}:
            view[col] = view[col].map(lambda x: num(x, 0) if pd.notna(x) else "NA")
        elif "return" in col or "drawdown" in col or "rate" in col or "runup" in col:
            view[col] = view[col].map(lambda x: pct(x) if pd.notna(x) else "NA")
    return view.to_markdown(index=False)


def make_sector_section(code: str, sector_summary: pd.DataFrame, cycles: pd.DataFrame, drawdowns: pd.DataFrame, bottoms: pd.DataFrame, states: pd.DataFrame) -> str:
    summary = sector_summary[sector_summary["code"] == code].iloc[0]
    sector_cycles = cycles[cycles["code"] == code].sort_values("start_date")
    sector_drawdowns = drawdowns[drawdowns["code"] == code]
    sector_bottoms = bottoms[bottoms["code"] == code].sort_values("start_date")
    state = states[states["code"] == code].iloc[0]
    dd_by_threshold = (
        sector_drawdowns.groupby("threshold")
        .agg(
            events=("trigger_date", "count"),
            median_trough_drawdown=("trough_drawdown", "median"),
            worst_trough_drawdown=("trough_drawdown", "min"),
            recovery_rate=("recovered", "mean"),
            median_return_60d_after_trough=("return_60d_after_trough", "median"),
            median_max_runup_120d_after_trough=("max_runup_120d_after_trough", "median"),
        )
        .reset_index()
    )
    recent_cycles = sector_cycles.tail(12)
    biggest_cycles = sector_cycles.sort_values("start_to_peak_return", ascending=False).head(5)
    worst_dd_events = sector_drawdowns.sort_values("trough_drawdown").head(5)
    section = f"""
## {summary['name']}（{code}）

### 板块概览

- 数据区间：{summary['start']} 至 {summary['end']}。
- 全历史总收益：{pct(summary['total_return'])}，年化收益：{pct(summary['annual_return'])}，全历史最大回撤：{pct(summary['max_drawdown'])}。
- 识别周期：{int(summary['cycles'])} 段；中位周期长度：{num(summary['median_cycle_days'], 0)} 个交易日；最长周期：{num(summary['max_cycle_days'], 0)} 个交易日。
- 中位周期峰值涨幅：{pct(summary['median_cycle_peak_return'])}；最大周期峰值涨幅：{pct(summary['max_cycle_peak_return'])}；中位周期最大回撤：{pct(summary['median_cycle_drawdown'])}。
- 当前状态：{state['state']}；20 日收益 {pct(state['ret20'])}，60 日收益 {pct(state['ret60'])}，距 120 日高点 {pct(state['drawdown_from_120d_high'])}。

### 最近周期区间

{markdown_table(recent_cycles, ["start_date", "end_date", "peak_date", "trough_date", "trading_days", "start_to_peak_return", "start_to_end_return", "max_drawdown_in_cycle", "pullback_10_count", "pullback_15_count", "pullback_20_count", "end_reason"], 12) if len(recent_cycles) else "无识别周期。"}

### 最大上涨周期

{markdown_table(biggest_cycles, ["start_date", "end_date", "peak_date", "trading_days", "start_to_peak_return", "start_to_end_return", "max_drawdown_in_cycle", "end_reason"], 5) if len(biggest_cycles) else "无识别周期。"}

### 回撤事件统计

{markdown_table(dd_by_threshold, ["threshold", "events", "median_trough_drawdown", "worst_trough_drawdown", "recovery_rate", "median_return_60d_after_trough", "median_max_runup_120d_after_trough"]) if len(dd_by_threshold) else "无独立回撤事件。"}

### 最大回撤事件

{markdown_table(worst_dd_events, ["threshold", "peak_date", "trigger_date", "trough_date", "end_date", "trough_drawdown", "recovered", "return_60d_after_trough", "max_runup_120d_after_trough"], 5) if len(worst_dd_events) else "无独立回撤事件。"}

### 筑底区间样本

{markdown_table(sector_bottoms.tail(8), ["start_date", "end_date", "trading_days", "period_return", "range_return", "future_60d_return_after_end", "future_120d_return_after_end", "open_bottom"], 8) if len(sector_bottoms) else "无满足本规则的筑底区间。"}
"""
    return section


def make_report(
    close: pd.DataFrame,
    meta: pd.DataFrame,
    sector_summary: pd.DataFrame,
    cycle_summary: pd.DataFrame,
    dd_summary: pd.DataFrame,
    duration_summary: pd.DataFrame,
    cycles: pd.DataFrame,
    drawdowns: pd.DataFrame,
    bottoms: pd.DataFrame,
    states: pd.DataFrame,
) -> str:
    lines = [
        "# 申万一级行业指数周期深度分析报告",
        "",
        "生成日期：2026-07-18",
        "",
        "## 数据源与口径",
        "",
        "本报告使用 AKShare 申万一级行业指数日线数据，覆盖 31 个一级行业。多数行业指数从 1999-12-30 起有历史记录，避免 ETF 上市时间导致的样本截断。",
        "",
        "周期定义沿用前序状态机：筑底、启动、主升、衰退/急跌、再筑底。这里的周期是可交易的价格周期，不是行业基本面周期。",
        "",
        "## 全市场总览",
        "",
        f"- 行业数量：{close.shape[1]}。",
        f"- 样本区间：{close.index.min().date()} 至 {close.index.max().date()}。",
        f"- 识别趋势周期：{len(cycles)} 段。",
        f"- 独立回撤事件：{len(drawdowns)} 条。",
        f"- 筑底区间：{len(bottoms)} 段。",
        "",
        "### 周期总体统计",
        "",
        markdown_table(cycle_summary, ["cycles", "median_trading_days", "min_trading_days", "max_trading_days", "median_start_to_peak_return", "median_start_to_end_return", "median_max_drawdown", "positive_cycle_rate", "open_cycles"]),
        "",
        "### 周期长度分布",
        "",
        markdown_table(duration_summary, ["duration_bucket", "cycles", "median_trading_days", "median_start_to_peak_return", "median_start_to_end_return", "median_max_drawdown", "positive_rate"]),
        "",
        "### 回撤事件总览",
        "",
        markdown_table(dd_summary, ["threshold", "events", "sectors_touched", "median_trough_drawdown", "worst_trough_drawdown", "recovery_rate", "median_recovery_days_from_trough", "median_return_20d_after_trough", "median_return_60d_after_trough", "median_return_120d_after_trough", "median_max_runup_120d_after_trough"]),
        "",
        "### 行业摘要排行",
        "",
        "按最大周期峰值涨幅排序：",
        "",
        markdown_table(sector_summary, ["code", "name", "start", "end", "total_return", "max_drawdown", "cycles", "max_cycle_peak_return", "median_cycle_peak_return", "drawdown_15_events", "current_state"], 31),
        "",
        "## 分行业分析",
        "",
    ]
    for code in meta["code"]:
        if code in close.columns:
            lines.append(make_sector_section(code, sector_summary, cycles, drawdowns, bottoms, states))
    lines.extend(
        [
            "",
            "## 输出文件",
            "",
            "- 日线数据：`lab/backtests/sw_sector_cycle_analysis/sw_first_level_daily_bars.csv`",
            "- 周期明细：`lab/backtests/sw_sector_cycle_analysis/cycles.csv`",
            "- 回撤事件：`lab/backtests/sw_sector_cycle_analysis/drawdown_events.csv`",
            "- 筑底区间：`lab/backtests/sw_sector_cycle_analysis/bottom_periods.csv`",
            "- 当前状态：`lab/backtests/sw_sector_cycle_analysis/current_states.csv`",
            "- 行业摘要：`lab/backtests/sw_sector_cycle_analysis/sector_summary.csv`",
            "- 本报告：`docs/research/sw-sector-index-cycle-analysis-report.md`",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    disable_requests_env_proxy()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    params = CycleParams()
    bars, meta = load_sector_data()
    meta["code"] = meta["code"].astype(str)
    meta_map = get_meta(meta)
    close = pivot_prices(bars, "close")
    high = pivot_prices(bars, "high").reindex(close.index)
    low = pivot_prices(bars, "low").reindex(close.index)
    ind = build_indicators(close)
    cycles = detect_cycles(close, high, low, ind, meta_map, params)
    drawdowns = detect_drawdowns(close, meta_map, [0.10, 0.15, 0.20])
    bottoms = detect_bottoms(close, ind, meta_map, params)
    states = current_states(close, ind, cycles, bottoms, meta_map)
    sector_summary, cycle_summary, dd_summary, duration_summary = summarize(close, cycles, drawdowns, bottoms, states, meta_map)

    cycles.to_csv(OUTPUT_DIR / "cycles.csv", index=False)
    drawdowns.to_csv(OUTPUT_DIR / "drawdown_events.csv", index=False)
    bottoms.to_csv(OUTPUT_DIR / "bottom_periods.csv", index=False)
    states.to_csv(OUTPUT_DIR / "current_states.csv", index=False)
    sector_summary.to_csv(OUTPUT_DIR / "sector_summary.csv", index=False)
    cycle_summary.to_csv(OUTPUT_DIR / "cycle_summary.csv", index=False)
    dd_summary.to_csv(OUTPUT_DIR / "drawdown_summary.csv", index=False)
    duration_summary.to_csv(OUTPUT_DIR / "cycle_duration_summary.csv", index=False)

    report = make_report(close, meta, sector_summary, cycle_summary, dd_summary, duration_summary, cycles, drawdowns, bottoms, states)
    REPORT_PATH.write_text(report, encoding="utf-8")
    payload = {
        "data": {
            "source": "AKShare index_hist_sw, sw_index_first_info",
            "start": str(close.index.min().date()),
            "end": str(close.index.max().date()),
            "sector_count": int(close.shape[1]),
        },
        "params": params.__dict__,
        "counts": {
            "cycles": int(len(cycles)),
            "drawdown_events": int(len(drawdowns)),
            "bottom_periods": int(len(bottoms)),
        },
        "outputs": {
            "report": str(REPORT_PATH),
            "sector_summary": str(OUTPUT_DIR / "sector_summary.csv"),
            "cycles": str(OUTPUT_DIR / "cycles.csv"),
            "drawdowns": str(OUTPUT_DIR / "drawdown_events.csv"),
            "bottoms": str(OUTPUT_DIR / "bottom_periods.csv"),
            "states": str(OUTPUT_DIR / "current_states.csv"),
        },
    }
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

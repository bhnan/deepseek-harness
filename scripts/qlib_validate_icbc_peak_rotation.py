#!/usr/bin/env python3
"""Validate the ICBC peak -> tech rotation idea with Qlib event backtests."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
QLIB_ROOT = Path("/Users/bhn/Desktop/funny_project/qlib")
QLIB_PYTHON = QLIB_ROOT / ".venv/bin/python"
QLIB_DUMP_SCRIPT = QLIB_ROOT / "scripts/dump_bin.py"

OUTPUT_DIR = ROOT / "lab/backtests/icbc_peak_semiconductor_rotation_qlib"
CSV_SOURCE_DIR = OUTPUT_DIR / "csv_source"
PROVIDER_DIR = OUTPUT_DIR / "provider"

ICBC_PATH = ROOT / "lab/backtests/two_layer_sector_stock/akshare_cache/stocks/sh601398_20150101_20260717_qfq.csv"
ETF_DIR = ROOT / "lab/backtests/two_layer_sector_stock/akshare_cache/etfs"

ACCOUNT = 1_000_000.0
CAPITAL_FRACTION = 0.95
TRADE_UNIT = 100
OPEN_COST = 0.0005
CLOSE_COST = 0.0015
MIN_COST = 5.0
HORIZONS = (5, 10, 20)


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
    start_date: str
    components: tuple[str, ...]


PEAK_PARAMS = PeakParams()
PROXIES = (
    ProxySpec("semi", "半导体ETF 512480", "2019-06-12", ("SH512480",)),
    ProxySpec("chip", "芯片ETF 159995", "2020-02-10", ("SZ159995",)),
    ProxySpec("tech_basket", "科技等权篮子", "2020-04-13", ("SH512480", "SZ159995", "SZ159998", "SH515050")),
)
VARIANT_LABELS = {
    "oracle_peak": "峰值当日入场(事后上限)",
    "confirmed_next": "确认后次日入场(可执行)",
}

RAW_DATA_PATHS = {
    "SH601398": ICBC_PATH,
    "SH512480": ETF_DIR / "etf_512480_20150101_20260717_sina.csv",
    "SZ159995": ETF_DIR / "etf_159995_20150101_20260717_sina.csv",
    "SZ159998": ETF_DIR / "etf_159998_20150101_20260717_sina.csv",
    "SH515050": ETF_DIR / "etf_515050_20150101_20260717_sina.csv",
}


def load_ohlcv(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path)
    frame["date"] = pd.to_datetime(frame["date"])
    keep = ["date", "open", "high", "low", "close", "volume", "amount"]
    frame = frame.loc[:, [col for col in keep if col in frame.columns]].copy()
    for column in frame.columns:
        if column != "date":
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if "amount" not in frame.columns:
        frame["amount"] = frame["close"] * frame["volume"]
    frame["factor"] = 1.0
    frame = frame.sort_values("date").drop_duplicates("date")
    return frame


def detect_confirmed_peaks(close: pd.Series, params: PeakParams) -> pd.DataFrame:
    values = close.to_numpy(dtype=float)
    dates = close.index
    rows: list[dict[str, object]] = []
    start = max(params.left_window, params.pre_window)
    end = len(close) - max(params.right_window, params.confirm_window)
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
        confirm_idx = idx + max(params.right_window, params.confirm_window)
        executable_idx = confirm_idx + 1
        rows.append(
            {
                "peak_index": idx,
                "date": dates[idx],
                "close": float(price),
                "pre_window_return": float(pre_ret),
                "future_min_date": dates[future_min_idx],
                "future_drawdown": float(future_drawdown),
                "confirm_date": dates[confirm_idx],
                "executable_entry_date": dates[executable_idx] if executable_idx < len(dates) else pd.NaT,
            }
        )

    if not rows:
        return pd.DataFrame()

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


def export_qlib_csv(symbol: str, frame: pd.DataFrame, output_dir: Path) -> None:
    target = output_dir / f"{symbol.lower()}.csv"
    export = frame.loc[:, ["date", "open", "high", "low", "close", "volume", "amount", "factor"]].copy()
    export["date"] = export["date"].dt.strftime("%Y-%m-%d")
    export.to_csv(target, index=False)


def rebuild_provider(frames: dict[str, pd.DataFrame]) -> None:
    shutil.rmtree(CSV_SOURCE_DIR, ignore_errors=True)
    shutil.rmtree(PROVIDER_DIR, ignore_errors=True)
    CSV_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for symbol, frame in frames.items():
        export_qlib_csv(symbol, frame, CSV_SOURCE_DIR)

    cmd = [
        str(QLIB_PYTHON),
        str(QLIB_DUMP_SCRIPT),
        "dump_all",
        "--data_path",
        str(CSV_SOURCE_DIR),
        "--qlib_dir",
        str(PROVIDER_DIR),
        "--include_fields",
        "open,high,low,close,volume,amount,factor",
        "--max_workers",
        "4",
    ]
    subprocess.run(cmd, cwd=ROOT, check=True)


def build_proxy_close_series(frames: dict[str, pd.DataFrame], proxy: ProxySpec) -> pd.Series:
    pieces = []
    for symbol in proxy.components:
        close = frames[symbol].set_index("date")["close"].rename(symbol)
        pieces.append(close)
    panel = pd.concat(pieces, axis=1).dropna()
    return panel.mean(axis=1)


def direct_portfolio_return(
    frames: dict[str, pd.DataFrame],
    components: tuple[str, ...],
    entry_date: pd.Timestamp,
    exit_date: pd.Timestamp,
) -> float | None:
    ratios = []
    for symbol in components:
        series = frames[symbol].set_index("date")["close"]
        if entry_date not in series.index or exit_date not in series.index:
            return None
        ratios.append(float(series.at[exit_date] / series.at[entry_date] - 1.0))
    return float(np.mean(ratios))


def approximate_net_return(gross_return: float) -> float:
    invested = CAPITAL_FRACTION
    buy_cost = invested * OPEN_COST
    sell_cost = invested * (1.0 + gross_return) * CLOSE_COST
    return invested * gross_return - buy_cost - sell_cost


def get_exit_date(series: pd.Series, entry_date: pd.Timestamp, horizon: int) -> pd.Timestamp | None:
    if entry_date not in series.index:
        return None
    loc = int(series.index.get_loc(entry_date))
    if loc + horizon >= len(series):
        return None
    return pd.Timestamp(series.index[loc + horizon])


def make_order_rows(
    frames: dict[str, pd.DataFrame],
    components: tuple[str, ...],
    entry_date: pd.Timestamp,
    exit_date: pd.Timestamp,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    weight = 1.0 / len(components)
    per_leg_cash = ACCOUNT * CAPITAL_FRACTION * weight
    for symbol in components:
        frame = frames[symbol].set_index("date")
        entry_close = float(frame.at[entry_date, "close"])
        shares = int(math.floor(per_leg_cash / entry_close / TRADE_UNIT) * TRADE_UNIT)
        if shares <= 0:
            raise ValueError(f"non-positive shares for {symbol} on {entry_date.date()}")
        rows.append(
            {
                "datetime": entry_date.strftime("%Y-%m-%d"),
                "instrument": symbol,
                "amount": shares,
                "direction": "buy",
            }
        )
        rows.append(
            {
                "datetime": exit_date.strftime("%Y-%m-%d"),
                "instrument": symbol,
                "amount": shares,
                "direction": "sell",
            }
        )
    return rows


def init_qlib():
    if str(QLIB_ROOT) not in sys.path:
        sys.path.insert(0, str(QLIB_ROOT))
    import qlib  # type: ignore
    from qlib.constant import REG_CN  # type: ignore

    qlib.init(provider_uri=str(PROVIDER_DIR), region=REG_CN)


def run_event_backtest(
    frames: dict[str, pd.DataFrame],
    components: tuple[str, ...],
    entry_date: pd.Timestamp,
    exit_date: pd.Timestamp,
) -> dict[str, float]:
    from qlib.backtest import backtest  # type: ignore

    order_df = pd.DataFrame(make_order_rows(frames, components, entry_date, exit_date))
    benchmark_calendar = frames[components[0]].set_index("date").loc[entry_date:exit_date].index
    benchmark_series = pd.Series(0.0, index=benchmark_calendar)
    strategy = {
        "class": "FileOrderStrategy",
        "module_path": "qlib.contrib.strategy.rule_strategy",
        "kwargs": {"file": order_df},
    }
    executor = {
        "class": "SimulatorExecutor",
        "module_path": "qlib.backtest.executor",
        "kwargs": {
            "time_per_step": "day",
            "generate_portfolio_metrics": True,
            "verbose": False,
            "indicator_config": {"show_indicator": False},
        },
    }
    report_dict, _indicator_dict = backtest(
        start_time=entry_date.strftime("%Y-%m-%d"),
        end_time=exit_date.strftime("%Y-%m-%d"),
        strategy=strategy,
        executor=executor,
        benchmark=benchmark_series,
        account=ACCOUNT,
        exchange_kwargs={
            "freq": "day",
            "limit_threshold": 0.095,
            "deal_price": "close",
            "open_cost": OPEN_COST,
            "close_cost": CLOSE_COST,
            "min_cost": MIN_COST,
            "codes": list(components),
            "trade_unit": TRADE_UNIT,
        },
    )
    report_df, _positions = next(iter(report_dict.values()))
    report_df = report_df.sort_index()
    final_account = float(report_df["account"].iloc[-1])
    total_cost = float(report_df["total_cost"].iloc[-1])
    max_drawdown = float((report_df["account"] / report_df["account"].cummax() - 1.0).min())
    return {
        "net_return": final_account / ACCOUNT - 1.0,
        "total_cost": total_cost,
        "max_drawdown": max_drawdown,
    }


def binomial_tail(successes: int, trials: int, p: float) -> float:
    if trials <= 0:
        return math.nan
    p = min(max(p, 0.0), 1.0)
    total = 0.0
    for hits in range(successes, trials + 1):
        total += math.comb(trials, hits) * (p**hits) * ((1.0 - p) ** (trials - hits))
    return total


def summarize_group(frame: pd.DataFrame, baseline_returns: pd.Series) -> dict[str, object]:
    event_returns = frame["qlib_net_return"].dropna()
    baseline_returns = baseline_returns.dropna()
    event_win_rate = float((event_returns > 0).mean()) if len(event_returns) else math.nan
    baseline_win_rate = float((baseline_returns > 0).mean()) if len(baseline_returns) else math.nan
    wins = int((event_returns > 0).sum()) if len(event_returns) else 0
    return {
        "sample_count": int(len(event_returns)),
        "baseline_sample_count": int(len(baseline_returns)),
        "event_win_rate": event_win_rate,
        "baseline_win_rate": baseline_win_rate,
        "win_rate_pvalue": binomial_tail(wins, len(event_returns), baseline_win_rate) if len(event_returns) else math.nan,
        "event_avg_net_return": float(event_returns.mean()) if len(event_returns) else math.nan,
        "baseline_avg_net_return": float(baseline_returns.mean()) if len(baseline_returns) else math.nan,
        "event_median_net_return": float(event_returns.median()) if len(event_returns) else math.nan,
        "baseline_median_net_return": float(baseline_returns.median()) if len(baseline_returns) else math.nan,
        "event_avg_max_drawdown": float(frame["qlib_max_drawdown"].mean()) if len(frame) else math.nan,
        "event_avg_cost": float(frame["qlib_total_cost"].mean()) if len(frame) else math.nan,
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    frames = {symbol: load_ohlcv(path) for symbol, path in RAW_DATA_PATHS.items()}
    icbc_close = frames["SH601398"].set_index("date")["close"]
    peaks = detect_confirmed_peaks(icbc_close, PEAK_PARAMS)
    if peaks.empty:
        raise SystemExit("No peaks detected; aborting.")

    rebuild_provider(frames)
    init_qlib()

    proxy_close_map = {proxy.key: build_proxy_close_series(frames, proxy) for proxy in PROXIES}
    rows: list[dict[str, object]] = []
    for proxy in PROXIES:
        proxy_close = proxy_close_map[proxy.key]
        start_date = pd.Timestamp(proxy.start_date)
        for _, peak in peaks.iterrows():
            peak_date = pd.Timestamp(peak["date"])
            if peak_date < start_date:
                continue
            variant_entries = {
                "oracle_peak": peak_date,
                "confirmed_next": pd.Timestamp(peak["executable_entry_date"]) if pd.notna(peak["executable_entry_date"]) else pd.NaT,
            }
            for variant_key, entry_date in variant_entries.items():
                if pd.isna(entry_date) or entry_date < start_date or entry_date not in proxy_close.index:
                    continue
                for horizon in HORIZONS:
                    exit_date = get_exit_date(proxy_close, entry_date, horizon)
                    if exit_date is None:
                        continue
                    gross_return = direct_portfolio_return(frames, proxy.components, entry_date, exit_date)
                    if gross_return is None:
                        continue
                    qlib_result = run_event_backtest(frames, proxy.components, entry_date, exit_date)
                    rows.append(
                        {
                            "proxy_key": proxy.key,
                            "proxy_label": proxy.label,
                            "variant": variant_key,
                            "variant_label": VARIANT_LABELS[variant_key],
                            "horizon_days": horizon,
                            "peak_date": peak_date.date().isoformat(),
                            "confirm_date": pd.Timestamp(peak["confirm_date"]).date().isoformat(),
                            "entry_date": entry_date.date().isoformat(),
                            "exit_date": exit_date.date().isoformat(),
                            "qlib_net_return": qlib_result["net_return"],
                            "qlib_total_cost": qlib_result["total_cost"],
                            "qlib_max_drawdown": qlib_result["max_drawdown"],
                            "direct_gross_return": gross_return,
                            "direct_approx_net_return": approximate_net_return(gross_return),
                        }
                    )

    events = pd.DataFrame(rows).sort_values(["proxy_key", "variant", "horizon_days", "entry_date"])
    if events.empty:
        raise SystemExit("No event backtests produced results.")

    summary_rows: list[dict[str, object]] = []
    for proxy in PROXIES:
        baseline_series = proxy_close_map[proxy.key].loc[pd.Timestamp(proxy.start_date) :]
        for horizon in HORIZONS:
            baseline_returns = (baseline_series.shift(-horizon) / baseline_series - 1.0).dropna().map(approximate_net_return)
            for variant_key in VARIANT_LABELS:
                group = events[
                    (events["proxy_key"] == proxy.key)
                    & (events["variant"] == variant_key)
                    & (events["horizon_days"] == horizon)
                ].copy()
                metrics = summarize_group(group, baseline_returns)
                summary_rows.append(
                    {
                        "proxy_key": proxy.key,
                        "proxy_label": proxy.label,
                        "variant": variant_key,
                        "variant_label": VARIANT_LABELS[variant_key],
                        "horizon_days": horizon,
                        **metrics,
                    }
                )

    summary = pd.DataFrame(summary_rows).sort_values(["proxy_key", "variant", "horizon_days"])
    peaks_out = peaks.copy()
    for col in ("date", "future_min_date", "confirm_date", "executable_entry_date"):
        peaks_out[col] = pd.to_datetime(peaks_out[col]).dt.date.astype(str)

    peaks_out.to_csv(OUTPUT_DIR / "confirmed_peaks.csv", index=False)
    events.to_csv(OUTPUT_DIR / "event_results.csv", index=False)
    summary.to_csv(OUTPUT_DIR / "summary.csv", index=False)
    (OUTPUT_DIR / "summary.json").write_text(
        json.dumps(
            {
                "generated_at": pd.Timestamp.now(tz="Asia/Shanghai").isoformat(),
                "peak_params": asdict(PEAK_PARAMS),
                "peak_count_total": int(len(peaks)),
                "proxies": [asdict(proxy) for proxy in PROXIES],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    preview = summary.loc[
        :,
        [
            "proxy_label",
            "variant_label",
            "horizon_days",
            "sample_count",
            "event_win_rate",
            "baseline_win_rate",
            "event_avg_net_return",
            "baseline_avg_net_return",
            "win_rate_pvalue",
        ],
    ]
    with pd.option_context("display.max_rows", None, "display.max_columns", None, "display.width", 200):
        print(preview.to_string(index=False))


if __name__ == "__main__":
    main()

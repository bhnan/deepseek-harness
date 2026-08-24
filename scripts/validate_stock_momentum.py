#!/usr/bin/env python3
"""Validate a first-pass A-share stock momentum factor with AKShare data."""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path

import akshare as ak
import numpy as np
import pandas as pd
import requests


DEFAULT_START = "20150101"
DEFAULT_END = "20260717"
DEFAULT_INDEX = "000905"
DEFAULT_BENCHMARK = "sh000905"
DEFAULT_LOOKBACK_DAYS = 252
DEFAULT_SKIP_DAYS = 20
DEFAULT_LABEL_DAYS = 20
DEFAULT_TOP_N = 30
DEFAULT_MIN_AVG_AMOUNT = 50_000_000
DEFAULT_COST_BPS = 20.0


@dataclass(frozen=True)
class BacktestResult:
    name: str
    returns: pd.Series
    weights: pd.DataFrame
    trades: pd.DataFrame


def disable_requests_env_proxy() -> None:
    original = requests.sessions.Session.merge_environment_settings

    def merge_without_proxy(self, url, proxies, stream, verify, cert):  # type: ignore[no-untyped-def]
        settings = original(self, url, proxies, stream, verify, cert)
        settings["proxies"] = {}
        return settings

    requests.sessions.Session.merge_environment_settings = merge_without_proxy


def market_symbol(code: str, exchange: str | None = None) -> str:
    if exchange and "上海" in exchange:
        return f"sh{code}"
    if exchange and "深圳" in exchange:
        return f"sz{code}"
    return f"sh{code}" if code.startswith(("5", "6", "9")) else f"sz{code}"


def load_constituents(index_symbol: str, cache_dir: Path) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"constituents_{index_symbol}.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file, dtype={"成分券代码": str, "品种代码": str})
    else:
        raw = ak.index_stock_cons_csindex(symbol=index_symbol)
        raw.to_csv(cache_file, index=False)

    if "成分券代码" in raw.columns:
        out = raw.rename(columns={"成分券代码": "code", "成分券名称": "name", "交易所": "exchange"})
    else:
        out = raw.rename(columns={"品种代码": "code", "品种名称": "name"})
        out["exchange"] = np.where(out["code"].astype(str).str.startswith("6"), "上海证券交易所", "深圳证券交易所")

    out["code"] = out["code"].astype(str).str.zfill(6)
    out["symbol"] = [market_symbol(code, exchange) for code, exchange in zip(out["code"], out["exchange"])]
    return out[["code", "symbol", "name", "exchange"]].drop_duplicates("code").sort_values("code")


def fetch_stock(symbol: str, start: str, end: str, cache_dir: Path, retries: int = 3) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{symbol}_{start}_{end}_qfq.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file)
    else:
        last_error = None
        raw = None
        for attempt in range(retries):
            try:
                raw = ak.stock_zh_a_daily(symbol=symbol, start_date=start, end_date=end, adjust="qfq")
                raw["source"] = "stock_zh_a_daily_sina_qfq"
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                time.sleep(0.8 * (attempt + 1))
        if raw is None:
            raise RuntimeError(f"failed to fetch {symbol}: {last_error}") from last_error
        raw.to_csv(cache_file, index=False)

    df = raw.rename(columns={"date": "date", "close": "close", "amount": "amount"})
    df["date"] = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["amount"] = pd.to_numeric(df.get("amount"), errors="coerce")
    df["source"] = df.get("source", "stock_zh_a_daily_sina_qfq")
    return df[["date", "close", "amount", "source"]].dropna(subset=["date", "close"])


def fetch_benchmark(symbol: str, start: str, end: str, cache_dir: Path) -> pd.Series:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"index_{symbol}_{start}_{end}.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file)
    else:
        raw = ak.stock_zh_index_daily(symbol=symbol)
        raw.to_csv(cache_file, index=False)

    raw["date"] = pd.to_datetime(raw["date"])
    raw["close"] = pd.to_numeric(raw["close"], errors="coerce")
    raw = raw[(raw["date"] >= pd.to_datetime(start)) & (raw["date"] <= pd.to_datetime(end))]
    return raw.set_index("date")["close"].sort_index().rename(symbol)


def build_panels(
    constituents: pd.DataFrame,
    start: str,
    end: str,
    cache_dir: Path,
    max_symbols: int | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    rows = constituents.head(max_symbols) if max_symbols else constituents
    closes = {}
    amounts = {}
    fetch_rows = []

    for idx, row in enumerate(rows.itertuples(index=False), start=1):
        try:
            df = fetch_stock(row.symbol, start, end, cache_dir / "stocks")
            closes[row.code] = df.set_index("date")["close"].sort_index()
            amounts[row.code] = df.set_index("date")["amount"].sort_index()
            fetch_rows.append(
                {
                    "code": row.code,
                    "symbol": row.symbol,
                    "name": row.name,
                    "rows": int(len(df)),
                    "start": df["date"].min().date().isoformat() if not df.empty else None,
                    "end": df["date"].max().date().isoformat() if not df.empty else None,
                    "status": "ok",
                }
            )
        except Exception as exc:  # noqa: BLE001
            fetch_rows.append(
                {
                    "code": row.code,
                    "symbol": row.symbol,
                    "name": row.name,
                    "rows": 0,
                    "start": None,
                    "end": None,
                    "status": f"error: {type(exc).__name__}: {exc}",
                }
            )
        if idx % 50 == 0:
            print(f"fetched {idx}/{len(rows)} symbols")

    close_panel = pd.DataFrame(closes).sort_index()
    amount_panel = pd.DataFrame(amounts).sort_index().reindex(close_panel.index)
    return close_panel, amount_panel, pd.DataFrame(fetch_rows)


def month_end_trading_dates(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.Series(index, index=index).groupby(index.to_period("M")).tail(1).values)


def spearman_by_rank(x: pd.Series, y: pd.Series) -> float:
    return float(x.rank().corr(y.rank()))


def factor_validation(
    close: pd.DataFrame,
    amount: pd.DataFrame,
    lookback_days: int,
    skip_days: int,
    label_days: int,
    min_avg_amount: float,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    rebalance_dates = month_end_trading_dates(close.index)
    close_ffill = close.ffill(limit=10)
    factor = close_ffill.shift(skip_days) / close_ffill.shift(lookback_days) - 1.0
    label = close_ffill.shift(-label_days) / close_ffill - 1.0
    avg_amount = amount.rolling(20, min_periods=10).mean()

    ic_rows = []
    layer_rows = []
    sample_rows = []

    for date in rebalance_dates:
        if date not in factor.index:
            continue
        valid = pd.DataFrame(
            {
                "factor": factor.loc[date],
                "label": label.loc[date],
                "amount": avg_amount.loc[date],
                "close": close.loc[date],
            }
        ).dropna()
        valid = valid[valid["amount"] >= min_avg_amount]
        if len(valid) < 50:
            continue

        rank_ic = spearman_by_rank(valid["factor"], valid["label"])
        ic_rows.append(
            {
                "date": date.date().isoformat(),
                "rank_ic": rank_ic,
                "sample_size": int(len(valid)),
                "top_factor": float(valid["factor"].max()),
                "bottom_factor": float(valid["factor"].min()),
            }
        )
        sample_rows.append({"date": date.date().isoformat(), "sample_size": int(len(valid))})

        ranks = valid["factor"].rank(method="first")
        valid["layer"] = pd.qcut(ranks, 5, labels=["Q1_low", "Q2", "Q3", "Q4", "Q5_high"])
        grouped = valid.groupby("layer", observed=False)["label"].mean()
        row = {"date": date.date().isoformat()}
        row.update({str(layer): float(value) for layer, value in grouped.items()})
        row["top_minus_bottom"] = float(grouped.get("Q5_high", np.nan) - grouped.get("Q1_low", np.nan))
        layer_rows.append(row)

    return pd.DataFrame(ic_rows), pd.DataFrame(layer_rows), pd.DataFrame(sample_rows)


def apply_costs(
    returns: pd.Series,
    targets: pd.DataFrame,
    rebalance_dates: pd.DatetimeIndex,
    cost_bps: float,
) -> tuple[pd.Series, pd.DataFrame]:
    net = returns.copy()
    cost_rate = cost_bps / 10_000.0
    previous = pd.Series(0.0, index=targets.columns)
    rows = []
    dates = list(targets.index)
    positions = {date: idx for idx, date in enumerate(dates)}

    for date in rebalance_dates:
        if date not in positions:
            continue
        idx = positions[date]
        if idx + 1 >= len(dates):
            continue
        effective = dates[idx + 1]
        target = targets.loc[date].fillna(0.0)
        turnover = float((target - previous).abs().sum())
        if turnover > 1e-12:
            cost = turnover * cost_rate
            net.loc[effective] -= cost
            rows.append(
                {
                    "signal_date": date.date().isoformat(),
                    "effective_date": effective.date().isoformat(),
                    "holding_count": int((target > 0).sum()),
                    "turnover": turnover,
                    "cost": cost,
                }
            )
        previous = target

    return net, pd.DataFrame(rows)


def topn_backtest(
    close: pd.DataFrame,
    amount: pd.DataFrame,
    lookback_days: int,
    skip_days: int,
    min_avg_amount: float,
    top_n: int,
    cost_bps: float,
) -> BacktestResult:
    close_ffill = close.ffill(limit=10)
    factor = close_ffill.shift(skip_days) / close_ffill.shift(lookback_days) - 1.0
    avg_amount = amount.rolling(20, min_periods=10).mean()
    rebalance_dates = month_end_trading_dates(close.index)
    targets = pd.DataFrame(np.nan, index=close.index, columns=close.columns)

    for date in rebalance_dates:
        valid = pd.DataFrame(
            {"factor": factor.loc[date], "amount": avg_amount.loc[date], "close": close.loc[date]}
        ).dropna()
        valid = valid[valid["amount"] >= min_avg_amount]
        chosen = valid["factor"].sort_values(ascending=False).head(top_n).index
        targets.loc[date, :] = 0.0
        if len(chosen) > 0:
            targets.loc[date, chosen] = 1.0 / len(chosen)

    weights = targets.ffill().fillna(0.0)
    daily_returns = close_ffill.pct_change(fill_method=None).fillna(0.0)
    gross = (weights.shift(1).fillna(0.0) * daily_returns).sum(axis=1)
    net, trades = apply_costs(gross, targets, rebalance_dates, cost_bps)
    return BacktestResult(f"CSI500 current constituents momentum Top{top_n}", net, weights, trades)


def buy_and_hold_index(index_close: pd.Series, cost_bps: float) -> BacktestResult:
    returns = index_close.pct_change(fill_method=None).fillna(0.0)
    returns.iloc[1] -= cost_bps / 10_000.0
    weights = pd.DataFrame({"benchmark": 1.0}, index=index_close.index)
    trades = pd.DataFrame(
        [{"signal_date": index_close.index[0].date().isoformat(), "effective_date": index_close.index[1].date().isoformat(), "holding_count": 1, "turnover": 1.0, "cost": cost_bps / 10_000.0}]
    )
    return BacktestResult("CSI500 index buy and hold", returns, weights, trades)


def performance_metrics(returns: pd.Series) -> dict[str, float | str | int]:
    returns = returns.dropna()
    nav = (1.0 + returns).cumprod()
    years = max((returns.index[-1] - returns.index[0]).days / 365.25, 1e-9)
    annual_return = nav.iloc[-1] ** (1.0 / years) - 1.0
    annual_vol = returns.std(ddof=0) * math.sqrt(252)
    drawdown = nav / nav.cummax() - 1.0
    return {
        "start": returns.index[0].date().isoformat(),
        "end": returns.index[-1].date().isoformat(),
        "trading_days": int(len(returns)),
        "total_return": float(nav.iloc[-1] - 1.0),
        "annual_return": float(annual_return),
        "annual_vol": float(annual_vol),
        "sharpe": float(annual_return / annual_vol) if annual_vol > 0 else np.nan,
        "max_drawdown": float(drawdown.min()),
        "positive_day_rate": float((returns > 0).mean()),
    }


def summarize_ic(ic: pd.DataFrame) -> dict[str, float | int]:
    if ic.empty:
        return {"periods": 0}
    std = ic["rank_ic"].std(ddof=1)
    return {
        "periods": int(len(ic)),
        "mean_rank_ic": float(ic["rank_ic"].mean()),
        "median_rank_ic": float(ic["rank_ic"].median()),
        "positive_rate": float((ic["rank_ic"] > 0).mean()),
        "ic_ir": float(ic["rank_ic"].mean() / std * math.sqrt(12)) if std and not math.isnan(std) else np.nan,
        "avg_sample_size": float(ic["sample_size"].mean()),
    }


def summarize_layers(layer_returns: pd.DataFrame) -> dict[str, float | int]:
    if layer_returns.empty:
        return {"periods": 0}
    cols = [col for col in ["Q1_low", "Q2", "Q3", "Q4", "Q5_high", "top_minus_bottom"] if col in layer_returns]
    return {f"mean_{col}": float(layer_returns[col].mean()) for col in cols} | {
        "periods": int(len(layer_returns)),
        "top_minus_bottom_positive_rate": float((layer_returns["top_minus_bottom"] > 0).mean()),
    }


def yearly_returns(returns: pd.Series) -> dict[str, float]:
    nav = (1.0 + returns).cumprod()
    year_end = nav.groupby(nav.index.year).tail(1)
    year_start = nav.groupby(nav.index.year).head(1)
    out = {}
    for year, end_value in year_end.groupby(year_end.index.year).last().items():
        start_value = year_start[year_start.index.year == year].iloc[0]
        out[str(year)] = float(end_value / start_value - 1.0)
    return out


def pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    parser.add_argument("--index", default=DEFAULT_INDEX)
    parser.add_argument("--benchmark", default=DEFAULT_BENCHMARK)
    parser.add_argument("--lookback-days", type=int, default=DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--skip-days", type=int, default=DEFAULT_SKIP_DAYS)
    parser.add_argument("--label-days", type=int, default=DEFAULT_LABEL_DAYS)
    parser.add_argument("--top-n", type=int, default=DEFAULT_TOP_N)
    parser.add_argument("--min-avg-amount", type=float, default=DEFAULT_MIN_AVG_AMOUNT)
    parser.add_argument("--cost-bps", type=float, default=DEFAULT_COST_BPS)
    parser.add_argument("--max-symbols", type=int, default=None)
    parser.add_argument("--output-dir", default="lab/backtests/stock_momentum_validation")
    parser.add_argument("--cache-dir", default=None)
    args = parser.parse_args()

    disable_requests_env_proxy()

    output_dir = Path(args.output_dir)
    cache_dir = Path(args.cache_dir) if args.cache_dir else output_dir / "akshare_cache"
    output_dir.mkdir(parents=True, exist_ok=True)

    constituents = load_constituents(args.index, cache_dir)
    close, amount, fetch_log = build_panels(constituents, args.start, args.end, cache_dir, args.max_symbols)
    fetch_log.to_csv(output_dir / "fetch_log.csv", index=False)
    constituents.to_csv(output_dir / "constituents.csv", index=False)

    benchmark_close = fetch_benchmark(args.benchmark, args.start, args.end, cache_dir)
    trading_index = benchmark_close.index
    close = close.reindex(trading_index)
    amount = amount.reindex(trading_index)
    close = close.dropna(axis=1, thresh=args.lookback_days + args.skip_days + args.label_days)
    amount = amount[close.columns]

    ic, layers, samples = factor_validation(
        close,
        amount,
        args.lookback_days,
        args.skip_days,
        args.label_days,
        args.min_avg_amount,
    )
    ic.to_csv(output_dir / "rank_ic.csv", index=False)
    layers.to_csv(output_dir / "layer_returns.csv", index=False)
    samples.to_csv(output_dir / "sample_sizes.csv", index=False)

    strategy = topn_backtest(
        close,
        amount,
        args.lookback_days,
        args.skip_days,
        args.min_avg_amount,
        args.top_n,
        args.cost_bps,
    )
    benchmark = buy_and_hold_index(benchmark_close.reindex(close.index).dropna(), args.cost_bps)
    results = [strategy, benchmark]

    metrics_rows = []
    for result in results:
        row = {"strategy": result.name}
        row.update(performance_metrics(result.returns))
        row["rebalance_count"] = int(len(result.trades))
        row["avg_turnover"] = float(result.trades["turnover"].mean()) if not result.trades.empty else 0.0
        metrics_rows.append(row)
        (1.0 + result.returns).cumprod().rename("nav").to_csv(
            output_dir / f"{result.name.replace(' ', '_')}_nav.csv"
        )
        result.trades.to_csv(output_dir / f"{result.name.replace(' ', '_')}_trades.csv", index=False)

    metrics = pd.DataFrame(metrics_rows)
    metrics.to_csv(output_dir / "metrics.csv", index=False)
    yearly = pd.DataFrame({result.name: yearly_returns(result.returns) for result in results}).sort_index()
    yearly.to_csv(output_dir / "yearly_returns.csv")

    summary = {
        "data_source": "AKShare index_stock_cons_csindex current constituents; stock_zh_a_daily Sina qfq; stock_zh_index_daily benchmark.",
        "as_of": args.end,
        "known_limitations": [
            "CSI500 constituents are current constituents, not point-in-time historical constituents; this introduces survivorship and membership bias.",
            "Historical ST flags, limit-up/limit-down execution blocking, and suspended sell blocking are not fully modeled in this first pass.",
            "Missing stock closes are forward-filled for up to 10 trading days to approximate suspension mark-to-market.",
        ],
        "config": vars(args),
        "symbols_requested": int(len(constituents.head(args.max_symbols) if args.max_symbols else constituents)),
        "symbols_loaded": int((fetch_log["status"] == "ok").sum()),
        "symbols_after_history_filter": int(len(close.columns)),
        "ic_summary": summarize_ic(ic),
        "layer_summary": summarize_layers(layers),
        "metrics": metrics_rows,
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    printable = metrics.copy()
    for col in ["total_return", "annual_return", "annual_vol", "max_drawdown", "positive_day_rate", "avg_turnover"]:
        printable[col] = printable[col].map(pct)
    printable["sharpe"] = printable["sharpe"].map(lambda value: f"{value:.2f}")

    print("IC summary")
    print(json.dumps(summary["ic_summary"], ensure_ascii=False, indent=2))
    print("\nLayer summary")
    print(json.dumps(summary["layer_summary"], ensure_ascii=False, indent=2))
    print("\nBacktest metrics")
    print(printable.to_string(index=False))
    print(f"\nArtifacts written to: {output_dir}")


if __name__ == "__main__":
    main()

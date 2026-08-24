#!/usr/bin/env python3
"""Validate low-frequency long-only momentum strategies with AKShare data."""

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


ETF_UNIVERSE = {
    "510300": "沪深300ETF",
    "510500": "中证500ETF",
    "159915": "创业板ETF",
    "510880": "红利ETF",
    "518880": "黄金ETF",
    "512100": "中证1000ETF",
}

DEFAULT_START = "20150101"
DEFAULT_END = "20260717"
DEFAULT_COST_BPS = 5.0


def disable_requests_env_proxy() -> None:
    """AKShare uses requests.get; avoid a broken system proxy from poisoning pulls."""
    original = requests.sessions.Session.merge_environment_settings

    def merge_without_proxy(self, url, proxies, stream, verify, cert):  # type: ignore[no-untyped-def]
        settings = original(self, url, proxies, stream, verify, cert)
        settings["proxies"] = {}
        return settings

    requests.sessions.Session.merge_environment_settings = merge_without_proxy


@dataclass(frozen=True)
class BacktestResult:
    name: str
    returns: pd.Series
    weights: pd.DataFrame
    trades: pd.DataFrame


def fetch_etf(symbol: str, start: str, end: str, cache_dir: Path) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"etf_{symbol}_{start}_{end}_qfq.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file)
    else:
        raw = None
        errors = []
        for attempt in range(3):
            try:
                raw = ak.fund_etf_hist_em(
                    symbol=symbol,
                    period="daily",
                    start_date=start,
                    end_date=end,
                    adjust="qfq",
                )
                raw["source"] = "fund_etf_hist_em_qfq"
                break
            except Exception as exc:  # noqa: BLE001 - provider fallback needs the original failure text
                errors.append(f"em attempt {attempt + 1}: {type(exc).__name__}: {exc}")
                time.sleep(0.5 * (attempt + 1))

        if raw is None:
            sina_symbol = f"sh{symbol}" if symbol.startswith("5") else f"sz{symbol}"
            try:
                raw = ak.fund_etf_hist_sina(symbol=sina_symbol)
                raw["source"] = "fund_etf_hist_sina_unadjusted"
                raw["fallback_reason"] = " | ".join(errors)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"failed to fetch {symbol}; {' | '.join(errors)}; sina: {exc}") from exc

        raw.to_csv(cache_file, index=False)

    df = raw.rename(columns={"日期": "date", "收盘": "close", "成交额": "amount"})
    df["date"] = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["amount"] = pd.to_numeric(df.get("amount"), errors="coerce")
    df["source"] = df.get("source", "unknown")
    df = df[(df["date"] >= pd.to_datetime(start)) & (df["date"] <= pd.to_datetime(end))]
    return df[["date", "close", "amount", "source"]].dropna(subset=["date", "close"])


def fetch_index(symbol: str, start: str, end: str, cache_dir: Path) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"index_{symbol}_{start}_{end}.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file)
    else:
        raw = ak.stock_zh_index_daily(symbol=symbol)
        raw["source"] = "stock_zh_index_daily"
        raw.to_csv(cache_file, index=False)

    df = raw.rename(columns={"date": "date", "close": "close", "volume": "amount"})
    df["date"] = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["amount"] = pd.to_numeric(df.get("amount"), errors="coerce")
    df["source"] = df.get("source", "stock_zh_index_daily")
    df = df[(df["date"] >= pd.to_datetime(start)) & (df["date"] <= pd.to_datetime(end))]
    return df[["date", "close", "amount", "source"]].dropna(subset=["date", "close"])


def build_single_price_panel(df: pd.DataFrame, symbol: str) -> tuple[pd.DataFrame, str]:
    source = str(df["source"].dropna().iloc[0]) if not df.empty else "empty"
    prices = df.set_index("date")["close"].sort_index().to_frame(symbol)
    return prices, source


def build_price_panel(
    symbols: dict[str, str],
    start: str,
    end: str,
    cache_dir: Path,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, str]]:
    closes = {}
    amounts = {}
    sources = {}
    for symbol in symbols:
        df = fetch_etf(symbol, start, end, cache_dir)
        closes[symbol] = df.set_index("date")["close"].sort_index()
        amounts[symbol] = df.set_index("date")["amount"].sort_index()
        sources[symbol] = str(df["source"].dropna().iloc[0]) if not df.empty else "empty"

    close_panel = pd.DataFrame(closes).sort_index()
    amount_panel = pd.DataFrame(amounts).sort_index()
    close_panel = close_panel.dropna(how="all")
    amount_panel = amount_panel.reindex(close_panel.index)
    return close_panel, amount_panel, sources


def month_end_trading_dates(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.Series(index, index=index).groupby(index.to_period("M")).tail(1).values)


def apply_costs(
    daily_returns: pd.Series,
    weights: pd.DataFrame,
    rebalance_dates: pd.DatetimeIndex,
    cost_bps: float,
) -> tuple[pd.Series, pd.DataFrame]:
    cost_rate = cost_bps / 10_000.0
    net = daily_returns.copy()
    previous = pd.Series(0.0, index=weights.columns)
    rows = []
    dates = list(weights.index)
    date_pos = {date: pos for pos, date in enumerate(dates)}

    for rebalance_date in rebalance_dates:
        if rebalance_date not in date_pos:
            continue
        pos = date_pos[rebalance_date]
        if pos + 1 >= len(dates):
            continue
        next_date = dates[pos + 1]
        target = weights.loc[rebalance_date].fillna(0.0)
        turnover = float((target - previous).abs().sum())
        cost = turnover * cost_rate
        net.loc[next_date] -= cost
        if turnover > 1e-12:
            rows.append(
                {
                    "signal_date": rebalance_date.date().isoformat(),
                    "effective_date": next_date.date().isoformat(),
                    "turnover": turnover,
                    "cost": cost,
                    "positions": json.dumps(
                        {symbol: round(weight, 4) for symbol, weight in target[target > 0].items()},
                        ensure_ascii=False,
                    ),
                }
            )
        previous = target

    return net, pd.DataFrame(rows)


def backtest_from_weights(
    name: str,
    prices: pd.DataFrame,
    weights: pd.DataFrame,
    rebalance_dates: pd.DatetimeIndex,
    cost_bps: float,
) -> BacktestResult:
    weights = weights.reindex(prices.index).ffill().fillna(0.0)
    asset_returns = prices.pct_change().fillna(0.0)
    gross = (weights.shift(1).fillna(0.0) * asset_returns).sum(axis=1)
    net, trades = apply_costs(gross, weights, rebalance_dates, cost_bps)
    return BacktestResult(name=name, returns=net, weights=weights, trades=trades)


def dual_momentum(prices: pd.DataFrame, cost_bps: float, top_n: int = 2) -> BacktestResult:
    rebalance_dates = month_end_trading_dates(prices.index)
    score = 0.5 * (prices / prices.shift(126) - 1.0) + 0.5 * (prices / prices.shift(252) - 1.0)
    weights = pd.DataFrame(np.nan, index=prices.index, columns=prices.columns)

    for date in rebalance_dates:
        row = score.loc[date].dropna()
        row = row[row > 0]
        if row.empty:
            weights.loc[date, :] = 0.0
            continue
        chosen = row.sort_values(ascending=False).head(top_n).index
        weights.loc[date, :] = 0.0
        weights.loc[date, chosen] = 1.0 / len(chosen)

    return backtest_from_weights("ETF双动量 Top2 月频", prices, weights, rebalance_dates, cost_bps)


def trend_following(prices: pd.DataFrame, symbol: str, cost_bps: float) -> BacktestResult:
    close = prices[[symbol]].dropna()
    monthly_close = close.groupby(close.index.to_period("M")).tail(1)
    monthly_ma10 = monthly_close[symbol].rolling(10).mean()
    rebalance_dates = pd.DatetimeIndex(monthly_close.index)
    weights = pd.DataFrame(np.nan, index=prices.index, columns=[symbol])

    for date in rebalance_dates:
        if math.isnan(monthly_ma10.loc[date]):
            weights.loc[date, symbol] = 0.0
            continue
        weights.loc[date, symbol] = 0.0
        if close.loc[date, symbol] > monthly_ma10.loc[date]:
            weights.loc[date, symbol] = 1.0

    return backtest_from_weights("沪深300ETF 10月均线过滤", close, weights, rebalance_dates, cost_bps)


def buy_and_hold(prices: pd.DataFrame, symbol: str, cost_bps: float) -> BacktestResult:
    close = prices[[symbol]].dropna()
    rebalance_dates = pd.DatetimeIndex([close.index[0]])
    weights = pd.DataFrame(1.0, index=close.index, columns=[symbol])
    return backtest_from_weights(f"{symbol} 买入持有", close, weights, rebalance_dates, cost_bps)


def metrics(returns: pd.Series) -> dict[str, float]:
    returns = returns.dropna()
    nav = (1.0 + returns).cumprod()
    years = max((returns.index[-1] - returns.index[0]).days / 365.25, 1e-9)
    annual_return = nav.iloc[-1] ** (1.0 / years) - 1.0
    annual_vol = returns.std(ddof=0) * math.sqrt(252)
    sharpe = annual_return / annual_vol if annual_vol > 0 else np.nan
    drawdown = nav / nav.cummax() - 1.0
    downside = returns[returns < 0].std(ddof=0) * math.sqrt(252)
    sortino = annual_return / downside if downside > 0 else np.nan
    return {
        "start": returns.index[0].date().isoformat(),
        "end": returns.index[-1].date().isoformat(),
        "trading_days": int(len(returns)),
        "total_return": float(nav.iloc[-1] - 1.0),
        "annual_return": float(annual_return),
        "annual_vol": float(annual_vol),
        "sharpe": float(sharpe),
        "sortino": float(sortino),
        "max_drawdown": float(drawdown.min()),
        "positive_day_rate": float((returns > 0).mean()),
    }


def exposure_rate(weights: pd.DataFrame) -> float:
    return float((weights.sum(axis=1) > 1e-9).mean())


def yearly_returns(returns: pd.Series) -> dict[str, float]:
    nav = (1.0 + returns).cumprod()
    year_end = nav.groupby(nav.index.year).tail(1)
    year_start = nav.groupby(nav.index.year).head(1)
    out = {}
    for year, end_value in year_end.groupby(year_end.index.year).last().items():
        start_value = year_start[year_start.index.year == year].iloc[0]
        out[str(year)] = float(end_value / start_value - 1.0)
    return out


def save_nav_chart(results: list[BacktestResult], output_path: Path) -> None:
    try:
        import matplotlib.pyplot as plt
    except ModuleNotFoundError:
        return

    fig, ax = plt.subplots(figsize=(12, 6))
    for result in results:
        nav = (1.0 + result.returns).cumprod()
        ax.plot(nav.index, nav.values, label=result.name)
    ax.set_title("Low-frequency long-only momentum validation")
    ax.set_ylabel("Net value")
    ax.grid(True, alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_path, dpi=160)
    plt.close(fig)


def pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    parser.add_argument("--cost-bps", type=float, default=DEFAULT_COST_BPS)
    parser.add_argument("--output-dir", default="lab/backtests/etf_rotation_validation")
    args = parser.parse_args()
    disable_requests_env_proxy()

    output_dir = Path(args.output_dir)
    cache_dir = output_dir / "akshare_cache"
    output_dir.mkdir(parents=True, exist_ok=True)

    prices, amounts, sources = build_price_panel(ETF_UNIVERSE, args.start, args.end, cache_dir)
    index_prices, index_source = build_single_price_panel(fetch_index("sh000300", args.start, args.end, cache_dir), "sh000300")
    full_prices = prices.dropna()

    dual = dual_momentum(full_prices, args.cost_bps, top_n=2)
    trend = trend_following(index_prices, "sh000300", args.cost_bps)
    trend = BacktestResult("沪深300指数 10月均线过滤", trend.returns, trend.weights, trend.trades)
    index_benchmark = buy_and_hold(index_prices, "sh000300", args.cost_bps)
    index_benchmark = BacktestResult("沪深300指数 买入持有", index_benchmark.returns, index_benchmark.weights, index_benchmark.trades)
    benchmark = buy_and_hold(prices, "510300", args.cost_bps)
    aligned_benchmark = buy_and_hold(full_prices, "510300", args.cost_bps)
    aligned_benchmark = BacktestResult(
        name="510300 买入持有(双动量同区间)",
        returns=aligned_benchmark.returns,
        weights=aligned_benchmark.weights,
        trades=aligned_benchmark.trades,
    )
    results = [dual, aligned_benchmark, trend, index_benchmark, benchmark]

    metrics_rows = []
    for result in results:
        row = {"strategy": result.name}
        row.update(metrics(result.returns))
        row["rebalance_count"] = int(len(result.trades))
        row["avg_turnover"] = float(result.trades["turnover"].mean()) if not result.trades.empty else 0.0
        row["annual_turnover"] = float(result.trades["turnover"].sum() / max((result.returns.index[-1] - result.returns.index[0]).days / 365.25, 1e-9))
        row["invested_day_rate"] = exposure_rate(result.weights)
        metrics_rows.append(row)

    metrics_df = pd.DataFrame(metrics_rows)
    metrics_df.to_csv(output_dir / "metrics.csv", index=False)

    yearly = pd.DataFrame({result.name: yearly_returns(result.returns) for result in results}).sort_index()
    yearly.to_csv(output_dir / "yearly_returns.csv")

    for result in results:
        nav = (1.0 + result.returns).cumprod().rename("nav")
        nav.to_csv(output_dir / f"{result.name.replace(' ', '_').replace('/', '_')}_nav.csv")
        result.trades.to_csv(output_dir / f"{result.name.replace(' ', '_').replace('/', '_')}_trades.csv", index=False)

    save_nav_chart(results, output_dir / "nav_chart.png")

    summary = {
        "data_source": "AKShare ETF daily bars; Eastmoney qfq preferred, Sina unadjusted fallback used when Eastmoney was unavailable.",
        "sources_by_symbol": sources,
        "index_source": {"sh000300": index_source},
        "akshare_version": getattr(ak, "__version__", "unknown"),
        "as_of": args.end,
        "start": args.start,
        "end": args.end,
        "cost_bps_per_turnover": args.cost_bps,
        "universe": ETF_UNIVERSE,
        "rules": {
            "dual_momentum": "Monthly rebalance; score = average of 126-trading-day and 252-trading-day total return; hold top 2 ETFs with score > 0, otherwise cash.",
            "trend_following": "Monthly rebalance; hold 510300 when month-end close is above its 10-month moving average, otherwise cash.",
            "execution": "Signals use month-end close and become effective on the next trading day; cash return is assumed to be 0.",
        },
        "metrics": metrics_rows,
        "yearly_returns": yearly.to_dict(),
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    printable = metrics_df.copy()
    for column in [
        "total_return",
        "annual_return",
        "annual_vol",
        "max_drawdown",
        "positive_day_rate",
        "avg_turnover",
        "annual_turnover",
        "invested_day_rate",
    ]:
        printable[column] = printable[column].map(pct)
    printable["sharpe"] = printable["sharpe"].map(lambda x: f"{x:.2f}")
    printable["sortino"] = printable["sortino"].map(lambda x: f"{x:.2f}")
    print(printable.to_string(index=False))
    print(f"\nArtifacts written to: {output_dir}")


if __name__ == "__main__":
    main()

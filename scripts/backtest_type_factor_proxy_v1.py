#!/usr/bin/env python3
"""Backtest the price-reconstructable proxy of the type-factor framework.

This deliberately does not claim to test the full current V1 score. Historical
valuation, earnings, and industry-space point-in-time observations are absent,
so the input panel only contains the price/liquidity/beta/drawdown/capital
proxy that can be reconstructed at each monthly decision date.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_PANEL = ROOT / "lab/backtests/type_factor_pools_v1/type_factor_historical_proxy_panel.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/type_factor_proxy_v0"
DEFAULT_START = "2018-01-01"
DEFAULT_END = "2026-07-17"
DEFAULT_MIN_AVG_AMOUNT = 20_000_000
DEFAULT_A_PERCENTILE = 0.80
DEFAULT_MIN_POOL_SIZE = 10
DEFAULT_COST_BPS = 20.0

POOL_FILE_KEYS = {
    "主线成长": "mainline_growth",
    "周期": "cyclical",
    "防守": "defensive",
    "修复": "repair",
    "金融": "financial",
}


@dataclass(frozen=True)
class PortfolioRun:
    """One monthly-rebalanced portfolio represented by daily close returns."""

    returns: pd.Series
    nav: pd.Series
    trades: pd.DataFrame
    effective_targets: pd.DataFrame


def zcode(value: object) -> str:
    return str(value).split(".")[0].zfill(6)


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def pct(value: object, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value) * 100:.{digits}f}%"


def num(value: object, digits: int = 3) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value):.{digits}f}"


def md_table(frame: pd.DataFrame, columns: list[str]) -> str:
    """Render a small deterministic Markdown table without an extra dependency."""

    if frame.empty:
        return "_No valid observations._"
    shown = frame.reindex(columns=[column for column in columns if column in frame.columns]).copy()
    if shown.empty:
        return "_No columns selected._"

    def text(value: object) -> str:
        if value is None or pd.isna(value):
            return "-"
        if isinstance(value, (float, np.floating)):
            return f"{float(value):.4f}"
        return str(value).replace("|", "\\|").replace("\n", " ")

    header = "| " + " | ".join(shown.columns) + " |"
    divider = "| " + " | ".join("---" for _ in shown.columns) + " |"
    rows = ["| " + " | ".join(text(value) for value in row) + " |" for row in shown.itertuples(index=False, name=None)]
    return "\n".join([header, divider, *rows])


def parse_cache_code(path: Path) -> str | None:
    prefix = path.name.split("_", 1)[0]
    match = re.search(r"(\d{6})", prefix)
    return match.group(1) if match else None


def read_stock_cache(
    candidate_codes: set[str], start: pd.Timestamp, end: pd.Timestamp
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load the longest locally cached AKShare series for each requested code."""

    best: dict[str, tuple[int, Path]] = {}
    for path in ROOT.glob("lab/backtests/*/akshare_cache/stocks/*.csv"):
        code = parse_cache_code(path)
        if code is None or code not in candidate_codes:
            continue
        try:
            rows = sum(1 for _ in path.open("r", encoding="utf-8", errors="ignore")) - 1
        except OSError:
            continue
        existing = best.get(code)
        if existing is None or rows > existing[0]:
            best[code] = (rows, path)

    closes: dict[str, pd.Series] = {}
    logs: list[dict[str, object]] = []
    for code, (_, path) in sorted(best.items()):
        try:
            frame = pd.read_csv(path)
        except (OSError, pd.errors.ParserError) as exc:
            logs.append({"stock_code": code, "cache_file": str(path.relative_to(ROOT)), "status": f"read_error:{type(exc).__name__}"})
            continue
        if not {"date", "close"}.issubset(frame.columns):
            logs.append({"stock_code": code, "cache_file": str(path.relative_to(ROOT)), "status": "missing_date_or_close"})
            continue

        frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
        frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
        frame = frame[(frame["date"] >= start) & (frame["date"] <= end)].dropna(subset=["date", "close"])
        frame = frame[frame["close"] > 0].drop_duplicates("date", keep="last").sort_values("date")
        if frame.empty:
            logs.append({"stock_code": code, "cache_file": str(path.relative_to(ROOT)), "status": "no_rows_in_range"})
            continue
        closes[code] = frame.set_index("date")["close"]
        logs.append(
            {
                "stock_code": code,
                "cache_file": str(path.relative_to(ROOT)),
                "status": "ok",
                "rows": int(len(frame)),
                "start": frame["date"].min().date().isoformat(),
                "end": frame["date"].max().date().isoformat(),
            }
        )

    close = pd.DataFrame(closes).sort_index()
    close.columns = close.columns.map(zcode)
    return close, pd.DataFrame(logs)


def eligible_snapshot(
    snapshot: pd.DataFrame,
    min_avg_amount: float,
    available_codes: set[str] | None = None,
) -> pd.DataFrame:
    """Filter one signal cross-section and assign the deterministic A rank."""

    required = {"stock_code", "historical_proxy_score", "avg_amount_20d_hist"}
    missing = required.difference(snapshot.columns)
    if missing:
        raise ValueError(f"snapshot missing columns: {sorted(missing)}")

    data = snapshot.copy()
    data["stock_code"] = data["stock_code"].map(zcode)
    data["historical_proxy_score"] = pd.to_numeric(data["historical_proxy_score"], errors="coerce")
    data["avg_amount_20d_hist"] = pd.to_numeric(data["avg_amount_20d_hist"], errors="coerce")
    data = data.dropna(subset=["historical_proxy_score", "avg_amount_20d_hist"])
    data = data[data["avg_amount_20d_hist"] >= min_avg_amount].copy()
    if available_codes is not None:
        data = data[data["stock_code"].isin(available_codes)].copy()
    data = data.sort_values(["historical_proxy_score", "stock_code"], kind="mergesort")
    data = data.drop_duplicates("stock_code", keep="last").copy()
    data["score_percentile"] = data["historical_proxy_score"].rank(method="first", pct=True)
    return data


def build_a_target(
    snapshot: pd.DataFrame,
    min_avg_amount: float = DEFAULT_MIN_AVG_AMOUNT,
    a_percentile: float = DEFAULT_A_PERCENTILE,
) -> pd.Series:
    """Return equal weights for the historical equivalent of the current A tier."""

    eligible = eligible_snapshot(snapshot, min_avg_amount=min_avg_amount)
    chosen = eligible[eligible["score_percentile"] >= a_percentile]
    if chosen.empty:
        return pd.Series(dtype=float)
    return pd.Series(1.0 / len(chosen), index=chosen["stock_code"].tolist(), dtype=float)


def build_pool_target(snapshot: pd.DataFrame, min_avg_amount: float = DEFAULT_MIN_AVG_AMOUNT) -> pd.Series:
    """Return equal weights for the full eligible same-pool benchmark universe."""

    eligible = eligible_snapshot(snapshot, min_avg_amount=min_avg_amount)
    if eligible.empty:
        return pd.Series(dtype=float)
    return pd.Series(1.0 / len(eligible), index=eligible["stock_code"].tolist(), dtype=float)


def price_dates_for_signal(index: pd.DatetimeIndex, signal_date: pd.Timestamp) -> tuple[pd.Timestamp, pd.Timestamp] | None:
    """Map an observed signal to the following available daily close."""

    pos = int(index.searchsorted(pd.Timestamp(signal_date), side="left"))
    if pos + 1 >= len(index):
        return None
    return index[pos], index[pos + 1]


def build_signal_targets(
    pool_panel: pd.DataFrame,
    close: pd.DataFrame,
    sleeve: str,
    min_avg_amount: float,
    a_percentile: float,
    min_pool_size: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Create sparse signal targets and stock-level selection audit rows."""

    if sleeve not in {"a_proxy", "pool_equal_weight"}:
        raise ValueError(f"unknown sleeve: {sleeve}")

    targets: dict[pd.Timestamp, pd.Series] = {}
    rows: list[dict[str, object]] = []
    columns = close.columns.tolist()
    all_codes = set(columns)

    for signal_date, raw_snapshot in pool_panel.groupby("date", sort=True):
        signal_date = pd.Timestamp(signal_date)
        dates = price_dates_for_signal(close.index, signal_date)
        if dates is None:
            continue
        observed_date, effective_date = dates
        tradable = set(
            close.columns[
                close.loc[observed_date].notna()
                & close.loc[effective_date].notna()
                & close.loc[observed_date].gt(0)
                & close.loc[effective_date].gt(0)
            ]
        )
        eligible = eligible_snapshot(
            raw_snapshot,
            min_avg_amount=min_avg_amount,
            available_codes=all_codes.intersection(tradable),
        )
        if len(eligible) < min_pool_size:
            continue

        if sleeve == "a_proxy":
            selected = eligible[eligible["score_percentile"] >= a_percentile].copy()
        else:
            selected = eligible.copy()
        if selected.empty:
            continue

        selected["target_weight"] = 1.0 / len(selected)
        target = pd.Series(0.0, index=columns, dtype=float)
        target.loc[selected["stock_code"].tolist()] = selected["target_weight"].to_numpy()
        targets[signal_date] = target

        for record in selected.to_dict(orient="records"):
            rows.append(
                {
                    "pool_type": str(record.get("pool_type", "")),
                    "sleeve": sleeve,
                    "signal_date": signal_date.date().isoformat(),
                    "observed_price_date": observed_date.date().isoformat(),
                    "effective_date": effective_date.date().isoformat(),
                    "stock_code": record["stock_code"],
                    "stock_name": record.get("stock_name", ""),
                    "sector_name": record.get("sector_name", ""),
                    "historical_proxy_score": float(record["historical_proxy_score"]),
                    "score_percentile": float(record["score_percentile"]),
                    "avg_amount_20d_hist": float(record["avg_amount_20d_hist"]),
                    "eligible_count": int(len(eligible)),
                    "selected_count": int(len(selected)),
                    "target_weight": float(record["target_weight"]),
                }
            )

    if not targets:
        return pd.DataFrame(columns=columns, dtype=float), pd.DataFrame(rows)
    signal_targets = pd.DataFrame.from_dict(targets, orient="index").reindex(columns=columns).sort_index()
    signal_targets.index = pd.to_datetime(signal_targets.index)
    return signal_targets, pd.DataFrame(rows)


def simulate_close_to_close_portfolio(
    close: pd.DataFrame, signal_targets: pd.DataFrame, cost_bps: float
) -> PortfolioRun:
    """Run close-to-close holding PnL with target execution at the next close.

    A target observed at T is executed at the close of T+1. It therefore does
    not earn the T-to-T+1 close return. The share quantities then drift until
    the next rebalance rather than silently rebalancing to equal weights daily.
    """

    if signal_targets.empty:
        raise ValueError("signal_targets is empty")
    price = close.copy().sort_index()
    price.index = pd.to_datetime(price.index)
    price.columns = price.columns.map(zcode)
    targets = signal_targets.copy()
    targets.columns = targets.columns.map(zcode)
    price = price.reindex(columns=targets.columns)
    price = price.apply(pd.to_numeric, errors="coerce")
    if price.empty:
        raise ValueError("close price panel is empty")

    events: dict[pd.Timestamp, tuple[pd.Timestamp, pd.Timestamp, pd.Series]] = {}
    for signal_date, target in targets.sort_index().iterrows():
        mapped = price_dates_for_signal(price.index, pd.Timestamp(signal_date))
        if mapped is None:
            continue
        observed_date, effective_date = mapped
        # Multiple non-trading signal dates may map to one execution day. Keep
        # the latest signal rather than applying two impossible same-close trades.
        events[effective_date] = (pd.Timestamp(signal_date), observed_date, target.astype(float))
    if not events:
        raise ValueError("no signal has a following price date for execution")

    first_observed = min(observed for _, observed, _ in events.values())
    calendar = price.index[price.index >= first_observed]
    mark_price = price.ffill()
    shares = pd.Series(0.0, index=price.columns, dtype=float)
    cash = 1.0
    previous_nav = 1.0
    return_rows: dict[pd.Timestamp, float] = {}
    nav_rows: dict[pd.Timestamp, float] = {}
    target_rows: dict[pd.Timestamp, pd.Series] = {}
    trade_rows: list[dict[str, object]] = []
    cost_rate = cost_bps / 10_000.0

    for date in calendar:
        prices = mark_price.loc[date]
        position_values = (shares * prices).fillna(0.0)
        pre_trade_nav = float(cash + position_values.sum())
        if pre_trade_nav <= 0:
            raise ValueError(f"non-positive portfolio value on {date.date().isoformat()}")

        post_trade_nav = pre_trade_nav
        if date in events:
            signal_date, observed_date, raw_target = events[date]
            valid_prices = prices.notna() & prices.gt(0)
            target = raw_target.reindex(price.columns).fillna(0.0).clip(lower=0.0)
            target = target.where(valid_prices, 0.0)
            if target.sum() > 0:
                target = target / target.sum()
            desired_cash_weight = float(max(0.0, 1.0 - target.sum()))
            current_stock_weights = position_values / pre_trade_nav
            current_cash_weight = cash / pre_trade_nav
            turnover = 0.5 * float(
                (target - current_stock_weights).abs().sum() + abs(desired_cash_weight - current_cash_weight)
            )
            transaction_cost = pre_trade_nav * turnover * cost_rate
            post_trade_nav = pre_trade_nav - transaction_cost
            if post_trade_nav <= 0:
                raise ValueError(f"transaction costs exhausted portfolio on {date.date().isoformat()}")
            shares = (target * post_trade_nav / prices.where(valid_prices, np.nan)).fillna(0.0)
            cash = desired_cash_weight * post_trade_nav
            target_rows[date] = target
            trade_rows.append(
                {
                    "signal_date": signal_date.date().isoformat(),
                    "observed_price_date": observed_date.date().isoformat(),
                    "effective_date": date.date().isoformat(),
                    "holding_count": int((target > 0).sum()),
                    "turnover": turnover,
                    "cost_fraction": transaction_cost / pre_trade_nav,
                    "transaction_cost_nav": transaction_cost,
                    "pre_trade_nav": pre_trade_nav,
                    "post_trade_nav": post_trade_nav,
                }
            )

        return_rows[date] = post_trade_nav / previous_nav - 1.0
        nav_rows[date] = post_trade_nav
        previous_nav = post_trade_nav

    first_effective = min(events)
    returns = pd.Series(return_rows, name="daily_return").loc[first_effective:]
    nav = (1.0 + returns).cumprod().rename("nav")
    effective_targets = pd.DataFrame.from_dict(target_rows, orient="index").reindex(columns=price.columns).sort_index()
    effective_targets.index.name = "effective_date"
    trades = pd.DataFrame(trade_rows)
    return PortfolioRun(returns=returns, nav=nav, trades=trades, effective_targets=effective_targets)


def performance_metrics(run: PortfolioRun) -> dict[str, object]:
    returns = run.returns.dropna()
    if returns.empty:
        return {"trading_days": 0}
    nav = (1.0 + returns).cumprod()
    annual_mean_return = float(returns.mean() * 252)
    annual_vol = float(returns.std(ddof=0) * math.sqrt(252))
    annual_return = float(nav.iloc[-1] ** (252.0 / len(returns)) - 1.0)
    drawdown = nav / nav.cummax() - 1.0
    trades = run.trades
    return {
        "start": returns.index.min().date().isoformat(),
        "end": returns.index.max().date().isoformat(),
        "trading_days": int(len(returns)),
        "total_return": float(nav.iloc[-1] - 1.0),
        "annual_return": annual_return,
        "annual_vol": annual_vol,
        "sharpe_zero_rf": float(annual_mean_return / annual_vol) if annual_vol > 0 else np.nan,
        "max_drawdown": float(drawdown.min()),
        "positive_day_rate": float((returns > 0).mean()),
        "rebalance_count": int(len(trades)),
        "avg_holding_count": float(trades["holding_count"].mean()) if not trades.empty else np.nan,
        "avg_one_way_turnover": float(trades["turnover"].mean()) if not trades.empty else 0.0,
        "total_one_way_turnover": float(trades["turnover"].sum()) if not trades.empty else 0.0,
        "sum_trade_cost_fraction": float(trades["cost_fraction"].sum()) if not trades.empty else 0.0,
    }


def yearly_returns(returns: pd.Series) -> pd.DataFrame:
    if returns.empty:
        return pd.DataFrame(columns=["year", "return"])
    grouped = (1.0 + returns).groupby(returns.index.year).prod() - 1.0
    return pd.DataFrame({"year": grouped.index.astype(int), "return": grouped.to_numpy()})


def comparison_metrics(strategy: PortfolioRun, benchmark: PortfolioRun) -> dict[str, float]:
    common = strategy.returns.index.intersection(benchmark.returns.index)
    if common.empty:
        return {"relative_total_return": np.nan, "relative_annual_return": np.nan}
    relative_nav = (1.0 + strategy.returns.loc[common]).cumprod() / (1.0 + benchmark.returns.loc[common]).cumprod()
    relative_total_return = float(relative_nav.iloc[-1] - 1.0)
    return {
        "relative_total_return": relative_total_return,
        "relative_annual_return": float(relative_nav.iloc[-1] ** (252.0 / len(common)) - 1.0),
    }


def report_metrics_table(metrics: pd.DataFrame) -> pd.DataFrame:
    shown = metrics.copy()
    for column in [
        "total_return",
        "annual_return",
        "annual_vol",
        "max_drawdown",
        "positive_day_rate",
        "avg_one_way_turnover",
        "sum_trade_cost_fraction",
    ]:
        if column in shown:
            shown[column] = shown[column].map(pct)
    for column in ["sharpe_zero_rf", "avg_holding_count", "total_one_way_turnover"]:
        if column in shown:
            shown[column] = shown[column].map(num)
    return shown


def build_report(
    config: dict[str, object],
    metrics: pd.DataFrame,
    comparisons: pd.DataFrame,
    cache_log: pd.DataFrame,
    panel: pd.DataFrame,
) -> str:
    display_comparisons = comparisons.copy()
    for column in ["relative_total_return", "relative_annual_return"]:
        if column in display_comparisons:
            display_comparisons[column] = display_comparisons[column].map(pct)
    loaded = int(cache_log["status"].eq("ok").sum()) if "status" in cache_log else 0
    return f"""# Type-Factor Price Proxy Backtest V0

## What This Tests

This is a **monthly, price-reconstructable proxy backtest**, not a full
point-in-time backtest of the current live type-factor score. It uses the
historical proxy score composed of price, liquidity, beta, drawdown, and
capital-migration inputs. Historical valuation, earnings, and industry-space
fields are unavailable and are deliberately excluded from the claim.

Each pool type is tested independently. There is no combined portfolio because
cross-type allocation has not yet been specified.

## Backtest Contract

- Signal dates: {panel['date'].min().date().isoformat()} through {panel['date'].max().date().isoformat()}, monthly historical panel.
- Selection: 20-day average turnover at least RMB {float(config['min_avg_amount']) / 1_000_000:.1f} million; A sleeve is score percentile >= {float(config['a_percentile']) * 100:.0f}% within the same type pool.
- Benchmark: equal-weight every eligible stock in the same type pool at the same signal date.
- Execution: observe T close, trade at next available close T+1, and begin earning the new holding from T+1 to T+2. This prevents the new selection from capturing T-to-T+1 returns.
- Costs: {float(config['cost_bps']):.1f} bp one-way cost on explicit turnover, including cash on entry/exit.
- Local price cache: {loaded} stocks loaded. Price missingness is marked to last available close for valuation; suspended/ST/limit-price execution blocking is not fully modelled.

## Portfolio Metrics

{md_table(report_metrics_table(metrics), ['pool_type', 'sleeve', 'start', 'end', 'trading_days', 'total_return', 'annual_return', 'annual_vol', 'sharpe_zero_rf', 'max_drawdown', 'rebalance_count', 'avg_holding_count', 'avg_one_way_turnover', 'sum_trade_cost_fraction'])}

## A Sleeve Versus Same-Pool Benchmark

`relative_total_return` is the terminal A-sleeve NAV divided by the same-pool
equal-weight benchmark NAV minus one. It is the relevant comparison for the
question "does the ranking add value after selecting the type pool?"

{md_table(display_comparisons, ['pool_type', 'relative_total_return', 'relative_annual_return'])}

## Interpretation Boundary

- Positive relative return is evidence for this historical price proxy only.
- Negative or unstable relative return means the corresponding type's live A
  ranking should not be treated as validated stock selection.
- Current-universe membership is applied backwards in time, so survivorship and
  membership bias remain. Results are a screening baseline, not production
  deployment evidence.
- This test does not settle type allocation, maximum position size, trade
  capacity, or event-driven risk controls.
"""


def write_outputs(
    output_dir: Path,
    config: dict[str, object],
    panel: pd.DataFrame,
    cache_log: pd.DataFrame,
    pool_runs: dict[tuple[str, str], PortfolioRun],
    selection_frames: list[pd.DataFrame],
) -> tuple[pd.DataFrame, pd.DataFrame, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[Path] = []
    cache_file = output_dir / "cache_log.csv"
    cache_log.to_csv(cache_file, index=False)
    artifacts.append(cache_file)

    metric_rows: list[dict[str, object]] = []
    yearly_rows: list[pd.DataFrame] = []
    for (pool_type, sleeve), run in pool_runs.items():
        key = POOL_FILE_KEYS.get(pool_type, re.sub(r"\W+", "_", pool_type))
        nav_file = output_dir / f"{key}_{sleeve}_nav.csv"
        pd.concat([run.returns, run.nav], axis=1).to_csv(nav_file, index_label="date")
        artifacts.append(nav_file)
        trades_file = output_dir / f"{key}_{sleeve}_trades.csv"
        run.trades.to_csv(trades_file, index=False)
        artifacts.append(trades_file)
        targets_file = output_dir / f"{key}_{sleeve}_effective_targets.csv"
        run.effective_targets.to_csv(targets_file, index=True)
        artifacts.append(targets_file)

        metric_rows.append({"pool_type": pool_type, "sleeve": sleeve, **performance_metrics(run)})
        yearly = yearly_returns(run.returns)
        yearly.insert(0, "sleeve", sleeve)
        yearly.insert(0, "pool_type", pool_type)
        yearly_rows.append(yearly)

    metrics = pd.DataFrame(metric_rows).sort_values(["pool_type", "sleeve"]).reset_index(drop=True)
    metrics_file = output_dir / "metrics.csv"
    metrics.to_csv(metrics_file, index=False)
    artifacts.append(metrics_file)
    yearly = pd.concat(yearly_rows, ignore_index=True) if yearly_rows else pd.DataFrame()
    yearly_file = output_dir / "yearly_returns.csv"
    yearly.to_csv(yearly_file, index=False)
    artifacts.append(yearly_file)

    comparison_rows: list[dict[str, object]] = []
    for pool_type in sorted({pool for pool, _ in pool_runs}):
        strategy = pool_runs.get((pool_type, "a_proxy"))
        benchmark = pool_runs.get((pool_type, "pool_equal_weight"))
        if strategy is not None and benchmark is not None:
            comparison_rows.append({"pool_type": pool_type, **comparison_metrics(strategy, benchmark)})
    comparisons = pd.DataFrame(comparison_rows).sort_values("pool_type").reset_index(drop=True)
    comparisons_file = output_dir / "a_proxy_vs_pool_benchmark.csv"
    comparisons.to_csv(comparisons_file, index=False)
    artifacts.append(comparisons_file)

    selections = pd.concat(selection_frames, ignore_index=True) if selection_frames else pd.DataFrame()
    selections_file = output_dir / "selections.csv"
    selections.to_csv(selections_file, index=False)
    artifacts.append(selections_file)

    report_file = output_dir / "type_factor_proxy_backtest_v0_report.md"
    report_file.write_text(build_report(config, metrics, comparisons, cache_log, panel), encoding="utf-8")
    artifacts.append(report_file)

    metadata = {
        "strategy_name": "type_factor_price_proxy_v0",
        "historical_panel": str(config["input_panel"]),
        "panel_date_start": panel["date"].min().date().isoformat(),
        "panel_date_end": panel["date"].max().date().isoformat(),
        "config": config,
        "price_cache": {
            "requested_codes": int(panel["stock_code"].nunique()),
            "loaded_codes": int(cache_log["status"].eq("ok").sum()) if "status" in cache_log else 0,
        },
        "limitations": [
            "This is a historical price proxy, not the complete current V1 factor with valuation, earnings, and industry-space fields.",
            "The current candidate universe and pool membership are applied historically, creating survivorship and membership bias.",
            "Suspension, ST, limit-price, corporate-action, and exact auction/VWAP execution constraints are not fully modelled.",
            "A T-close signal executes at the next available close; this is an end-of-day timing convention, not a claim of exact market-on-close fill availability.",
            "The five type-pool portfolios are separate; no cross-type allocation is tested.",
        ],
        "artifacts": [path.name for path in artifacts],
    }
    metadata_file = output_dir / "summary.json"
    metadata_file.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    artifacts.append(metadata_file)

    zip_file = output_dir / "type_factor_proxy_v0_outputs.zip"
    with zipfile.ZipFile(zip_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for artifact in artifacts:
            archive.write(artifact, arcname=artifact.name)
    return metrics, comparisons, zip_file


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-panel", default=str(DEFAULT_INPUT_PANEL))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    parser.add_argument("--min-avg-amount", type=float, default=DEFAULT_MIN_AVG_AMOUNT)
    parser.add_argument("--a-percentile", type=float, default=DEFAULT_A_PERCENTILE)
    parser.add_argument("--min-pool-size", type=int, default=DEFAULT_MIN_POOL_SIZE)
    parser.add_argument("--cost-bps", type=float, default=DEFAULT_COST_BPS)
    args = parser.parse_args()

    input_panel = output_path(args.input_panel)
    output_dir = output_path(args.output_dir)
    panel = pd.read_csv(input_panel, dtype={"stock_code": str})
    panel["stock_code"] = panel["stock_code"].map(zcode)
    panel["date"] = pd.to_datetime(panel["date"])
    panel = panel[(panel["date"] >= pd.Timestamp(args.start)) & (panel["date"] <= pd.Timestamp(args.end))].copy()
    if panel.empty:
        raise ValueError("historical proxy panel has no rows in requested date range")

    close, cache_log = read_stock_cache(
        set(panel["stock_code"]), start=pd.Timestamp(args.start), end=pd.Timestamp(args.end)
    )
    if close.empty:
        raise ValueError("no local stock cache data loaded")

    pool_runs: dict[tuple[str, str], PortfolioRun] = {}
    selection_frames: list[pd.DataFrame] = []
    for pool_type, pool_panel in panel.groupby("pool_type", sort=True):
        for sleeve in ["a_proxy", "pool_equal_weight"]:
            targets, selections = build_signal_targets(
                pool_panel,
                close,
                sleeve=sleeve,
                min_avg_amount=args.min_avg_amount,
                a_percentile=args.a_percentile,
                min_pool_size=args.min_pool_size,
            )
            if targets.empty:
                continue
            run = simulate_close_to_close_portfolio(close, targets, cost_bps=args.cost_bps)
            pool_runs[(str(pool_type), sleeve)] = run
            selection_frames.append(selections)

    if not pool_runs:
        raise ValueError("no pool produced executable targets")

    config = {
        "input_panel": str(input_panel.relative_to(ROOT)) if input_panel.is_relative_to(ROOT) else str(input_panel),
        "start": args.start,
        "end": args.end,
        "min_avg_amount": args.min_avg_amount,
        "a_percentile": args.a_percentile,
        "min_pool_size": args.min_pool_size,
        "cost_bps": args.cost_bps,
        "execution_convention": "signal at T close; target executed at next available T+1 close; new-position PnL starts T+1 to T+2",
    }
    metrics, comparisons, zip_file = write_outputs(
        output_dir=output_dir,
        config=config,
        panel=panel,
        cache_log=cache_log,
        pool_runs=pool_runs,
        selection_frames=selection_frames,
    )

    print("Backtest metrics")
    print(report_metrics_table(metrics).to_string(index=False))
    print("\nA proxy versus same-pool benchmark")
    print(comparisons.to_string(index=False))
    print(f"\nArtifacts written to: {output_dir}")
    print(f"ZIP: {zip_file}")


if __name__ == "__main__":
    main()

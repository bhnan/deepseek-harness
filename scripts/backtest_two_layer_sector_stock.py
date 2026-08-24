#!/usr/bin/env python3
"""Backtest sector selection plus within-sector stock momentum."""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import akshare as ak
import numpy as np
import pandas as pd
import requests


ETF_POOL = {
    "512880": {"name": "证券ETF", "group": "金融", "labels": ["gn_qszc"]},
    "512800": {"name": "银行ETF", "group": "金融", "labels": ["hangye_ZJ66"]},
    "512660": {"name": "军工ETF", "group": "制造", "labels": ["gn_gfjg"]},
    "512010": {"name": "医药ETF", "group": "医药", "labels": ["hangye_ZC27"]},
    "512170": {"name": "医疗ETF", "group": "医药", "labels": ["new_ylqx"]},
    "159928": {"name": "消费ETF", "group": "消费", "labels": ["hangye_ZC13", "hangye_ZC14"]},
    "512690": {"name": "酒ETF", "group": "消费", "labels": ["new_ljhy"]},
    "512480": {"name": "半导体ETF", "group": "科技", "labels": ["new_dzqj"]},
    "159995": {"name": "芯片ETF", "group": "科技", "labels": ["new_dzqj"]},
    "515030": {"name": "新能源车ETF", "group": "新能源", "labels": ["hangye_ZC36"]},
    "515790": {"name": "光伏ETF", "group": "新能源", "labels": ["gn_gf"]},
    "512400": {"name": "有色ETF", "group": "周期", "labels": ["new_ysjs"]},
    "515220": {"name": "煤炭ETF", "group": "周期", "labels": ["hangye_ZB06"]},
    "512980": {"name": "传媒ETF", "group": "TMT", "labels": ["new_cmyl"]},
    "512200": {"name": "房地产ETF", "group": "地产", "labels": ["new_fdc"]},
    "159998": {"name": "计算机ETF", "group": "科技", "labels": ["hangye_ZC39"]},
    "515050": {"name": "5GETF", "group": "科技", "labels": ["gn_5Ggn"]},
    "518880": {"name": "黄金ETF", "group": "避险", "labels": []},
    "510880": {"name": "红利ETF", "group": "红利", "labels": []},
}

BASE_ETFS = ["518880", "515220", "510880"]
ACTIVE_ETFS = [code for code in ETF_POOL if code not in BASE_ETFS]
DEFAULT_START = "20150101"
DEFAULT_END = "20260717"
SPLIT_JUMP_THRESHOLD = 0.35


def disable_requests_env_proxy() -> None:
    original = requests.sessions.Session.merge_environment_settings

    def merge_without_proxy(self, url, proxies, stream, verify, cert):  # type: ignore[no-untyped-def]
        settings = original(self, url, proxies, stream, verify, cert)
        settings["proxies"] = {}
        return settings

    requests.sessions.Session.merge_environment_settings = merge_without_proxy


def market_symbol(code: str) -> str:
    return f"sh{code}" if code.startswith(("5", "6", "9")) else f"sz{code}"


def sina_etf_symbol(code: str) -> str:
    return f"sh{code}" if code.startswith("5") else f"sz{code}"


def split_adjusted_close(close: pd.Series) -> pd.Series:
    adjusted = close.astype(float).copy()
    raw = close.astype(float).reset_index(drop=True)
    for idx in range(1, len(raw)):
        previous = raw.iloc[idx - 1]
        current = raw.iloc[idx]
        if not previous or pd.isna(previous) or pd.isna(current):
            continue
        ratio = current / previous
        if ratio < 1 - SPLIT_JUMP_THRESHOLD or ratio > 1 + SPLIT_JUMP_THRESHOLD:
            adjusted.iloc[:idx] *= ratio
    return adjusted


def fetch_etf(code: str, start: str, end: str, cache_dir: Path) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"etf_{code}_{start}_{end}_sina.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file)
    else:
        raw = ak.fund_etf_hist_sina(symbol=sina_etf_symbol(code))
        raw.to_csv(cache_file, index=False)
        time.sleep(0.1)
    df = raw.rename(columns={"date": "date", "close": "close", "amount": "amount"})
    df["date"] = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["amount"] = pd.to_numeric(df.get("amount"), errors="coerce")
    df = df[(df["date"] >= pd.to_datetime(start)) & (df["date"] <= pd.to_datetime(end))]
    df = df.sort_values("date").reset_index(drop=True)
    df["close"] = split_adjusted_close(df["close"])
    return df[["date", "close", "amount"]].dropna(subset=["date", "close"])


def build_etf_panel(start: str, end: str, cache_dir: Path) -> pd.DataFrame:
    closes = {}
    for code in ETF_POOL:
        df = fetch_etf(code, start, end, cache_dir / "etfs")
        closes[code] = df.set_index("date")["close"].sort_index()
    return pd.DataFrame(closes).sort_index().dropna(how="all")


def fetch_sector_constituents(label: str, cache_dir: Path) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"sector_{label}.csv"
    if cache_file.exists():
        return pd.read_csv(cache_file, dtype={"code": str})
    raw = ak.stock_sector_detail(sector=label)
    raw.to_csv(cache_file, index=False)
    return pd.read_csv(cache_file, dtype={"code": str})


def build_sector_pools(cache_dir: Path) -> tuple[dict[str, pd.DataFrame], pd.DataFrame]:
    pools = {}
    rows = []
    for etf, meta in ETF_POOL.items():
        frames = []
        for label in meta["labels"]:
            try:
                df = fetch_sector_constituents(label, cache_dir / "sectors")
                frames.append(df)
                rows.append({"etf": etf, "etf_name": meta["name"], "label": label, "rows": len(df), "status": "ok"})
            except Exception as exc:  # noqa: BLE001
                rows.append({"etf": etf, "etf_name": meta["name"], "label": label, "rows": 0, "status": f"{type(exc).__name__}: {exc}"})
        if frames:
            pool = pd.concat(frames, ignore_index=True)
            pool["code"] = pool["code"].astype(str).str.zfill(6)
            pool = pool[pool["symbol"].astype(str).str.startswith(("sh", "sz"))]
            pool = pool[~pool["name"].astype(str).str.contains("ST|退", regex=True)]
            pool = pool.drop_duplicates("code")
        else:
            pool = pd.DataFrame(columns=["symbol", "code", "name"])
        pools[etf] = pool[["symbol", "code", "name"]] if not pool.empty else pool
    return pools, pd.DataFrame(rows)


def fetch_stock(symbol: str, start: str, end: str, cache_dirs: list[Path]) -> pd.DataFrame:
    file_name = f"{symbol}_{start}_{end}_qfq.csv"
    for cache_dir in cache_dirs:
        cache_file = cache_dir / file_name
        if cache_file.exists():
            raw = pd.read_csv(cache_file)
            break
    else:
        cache_dir = cache_dirs[0]
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / file_name
        raw = ak.stock_zh_a_daily(symbol=symbol, start_date=start, end_date=end, adjust="qfq")
        raw.to_csv(cache_file, index=False)
        time.sleep(0.05)

    raw = raw.rename(columns={"date": "date", "close": "close", "amount": "amount"})
    raw["date"] = pd.to_datetime(raw["date"])
    raw["close"] = pd.to_numeric(raw["close"], errors="coerce")
    raw["amount"] = pd.to_numeric(raw.get("amount"), errors="coerce")
    return raw[["date", "close", "amount"]].dropna(subset=["date", "close"])


def build_stock_panels(
    pools: dict[str, pd.DataFrame],
    selected_etfs: set[str],
    start: str,
    end: str,
    cache_dir: Path,
    external_cache: Path | None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    securities = []
    for etf in selected_etfs:
        pool = pools.get(etf, pd.DataFrame())
        if not pool.empty:
            for row in pool.itertuples(index=False):
                securities.append({"code": row.code, "symbol": row.symbol, "name": row.name})
    sec_df = pd.DataFrame(securities).drop_duplicates("code") if securities else pd.DataFrame(columns=["code", "symbol", "name"])

    closes = {}
    amounts = {}
    rows = []
    cache_dirs = [cache_dir / "stocks"]
    if external_cache:
        cache_dirs.append(external_cache)
    for idx, row in enumerate(sec_df.itertuples(index=False), start=1):
        try:
            df = fetch_stock(row.symbol, start, end, cache_dirs)
            closes[row.code] = df.set_index("date")["close"].sort_index()
            amounts[row.code] = df.set_index("date")["amount"].sort_index()
            rows.append({"code": row.code, "symbol": row.symbol, "name": row.name, "rows": len(df), "status": "ok"})
        except Exception as exc:  # noqa: BLE001
            rows.append({"code": row.code, "symbol": row.symbol, "name": row.name, "rows": 0, "status": f"{type(exc).__name__}: {exc}"})
        if idx % 100 == 0:
            print(f"fetched stocks {idx}/{len(sec_df)}")
    close = pd.DataFrame(closes).sort_index().dropna(how="all")
    amount = pd.DataFrame(amounts).sort_index().reindex(close.index)
    return close, amount, pd.DataFrame(rows)


def month_end_dates(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.Series(index, index=index).groupby(index.to_period("M")).tail(1).values)


def momentum_scores(close: pd.DataFrame, lookback: int = 252, skip: int = 20) -> pd.DataFrame:
    return close.shift(skip) / close.shift(lookback) - 1.0


def etf_scores(close: pd.DataFrame) -> pd.DataFrame:
    return 0.5 * (close / close.shift(126) - 1.0) + 0.5 * (close / close.shift(252) - 1.0)


def first_layer_selection(etf_close: pd.DataFrame, top_n: int) -> pd.DataFrame:
    scores = etf_scores(etf_close)
    rows = []
    for date in month_end_dates(etf_close.index):
        ranked = scores.loc[date, ACTIVE_ETFS].dropna()
        ranked = ranked[ranked > 0].sort_values(ascending=False).head(top_n)
        rows.append(
            {
                "date": date,
                "selected_etfs": list(ranked.index),
                "selected_names": [ETF_POOL[code]["name"] for code in ranked.index],
            }
        )
    return pd.DataFrame(rows).set_index("date")


def build_stock_strategy_weights(
    trading_index: pd.DatetimeIndex,
    selections: pd.DataFrame,
    pools: dict[str, pd.DataFrame],
    stock_close: pd.DataFrame,
    stock_amount: pd.DataFrame,
    etf_close: pd.DataFrame,
    active_weight: float,
    base_weight: float,
    top_stock_n: int,
    min_avg_amount: float,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    instruments = list(stock_close.columns) + BASE_ETFS
    weights = pd.DataFrame(np.nan, index=trading_index, columns=instruments)
    etf_weights = pd.DataFrame(np.nan, index=trading_index, columns=list(ETF_POOL))
    stock_scores = momentum_scores(stock_close)
    avg_amount = stock_amount.rolling(20, min_periods=10).mean()
    logs = []

    for date, row in selections.iterrows():
        if date not in weights.index:
            continue
        selected = row["selected_etfs"]
        weights.loc[date, :] = 0.0
        etf_weights.loc[date, :] = 0.0

        for base in BASE_ETFS:
            if date in etf_close.index and pd.notna(etf_close.loc[date, base]):
                weights.loc[date, base] = base_weight
                etf_weights.loc[date, base] = base_weight

        sector_weight = active_weight / len(selected) if selected else 0.0
        for etf in selected:
            etf_weights.loc[date, etf] = etf_weights.loc[date, etf] + sector_weight
            pool = pools.get(etf, pd.DataFrame())
            stock_codes = [code for code in pool.get("code", []) if code in stock_close.columns]
            sample = pd.DataFrame(
                {
                    "score": stock_scores.loc[date, stock_codes] if stock_codes else pd.Series(dtype=float),
                    "amount": avg_amount.loc[date, stock_codes] if stock_codes else pd.Series(dtype=float),
                }
            ).dropna()
            sample = sample[sample["amount"] >= min_avg_amount]
            chosen = sample["score"].sort_values(ascending=False).head(top_stock_n).index.tolist()
            if chosen:
                for code in chosen:
                    weights.loc[date, code] = weights.loc[date, code] + sector_weight / len(chosen)
            else:
                weights.loc[date, etf] = weights.loc[date, etf] + sector_weight
            logs.append(
                {
                    "date": date.date().isoformat(),
                    "etf": etf,
                    "etf_name": ETF_POOL[etf]["name"],
                    "candidate_count": len(stock_codes),
                    "valid_count": len(sample),
                    "chosen_count": len(chosen),
                    "chosen_codes": ",".join(chosen),
                }
            )

    return weights.ffill().fillna(0.0), etf_weights.ffill().fillna(0.0), pd.DataFrame(logs)


def portfolio_returns(price_panel: pd.DataFrame, weights: pd.DataFrame, cost_bps: float) -> tuple[pd.Series, pd.DataFrame]:
    price_panel = price_panel.reindex(weights.index)
    asset_returns = price_panel.pct_change(fill_method=None).fillna(0.0)
    gross = (weights.shift(1).fillna(0.0) * asset_returns).sum(axis=1)
    net = gross.copy()
    trades = []
    previous = pd.Series(0.0, index=weights.columns)
    cost_rate = cost_bps / 10_000.0
    dates = list(weights.index)
    pos = {date: idx for idx, date in enumerate(dates)}
    for date in month_end_dates(weights.index):
        if date not in pos or pos[date] + 1 >= len(dates):
            continue
        target = weights.loc[date].fillna(0.0)
        turnover = float((target - previous).abs().sum())
        effective = dates[pos[date] + 1]
        net.loc[effective] -= turnover * cost_rate
        trades.append(
            {
                "signal_date": date.date().isoformat(),
                "effective_date": effective.date().isoformat(),
                "holding_count": int((target > 0).sum()),
                "turnover": turnover,
                "cost": turnover * cost_rate,
            }
        )
        previous = target
    return net, pd.DataFrame(trades)


def metrics(returns: pd.Series) -> dict[str, float | str | int]:
    returns = returns.dropna()
    nav = (1.0 + returns).cumprod()
    years = max((returns.index[-1] - returns.index[0]).days / 365.25, 1e-9)
    annual_return = nav.iloc[-1] ** (1.0 / years) - 1.0
    annual_vol = returns.std(ddof=0) * math.sqrt(252)
    dd = nav / nav.cummax() - 1.0
    return {
        "start": returns.index[0].date().isoformat(),
        "end": returns.index[-1].date().isoformat(),
        "trading_days": int(len(returns)),
        "total_return": float(nav.iloc[-1] - 1.0),
        "annual_return": float(annual_return),
        "annual_vol": float(annual_vol),
        "sharpe": float(annual_return / annual_vol) if annual_vol > 0 else np.nan,
        "max_drawdown": float(dd.min()),
        "positive_day_rate": float((returns > 0).mean()),
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
    parser.add_argument("--top-sector-n", type=int, default=3)
    parser.add_argument("--top-stock-n", type=int, default=5)
    parser.add_argument("--active-weight", type=float, default=0.70)
    parser.add_argument("--base-weight", type=float, default=0.10)
    parser.add_argument("--min-avg-amount", type=float, default=30_000_000)
    parser.add_argument("--cost-bps", type=float, default=20.0)
    parser.add_argument("--output-dir", default="lab/backtests/two_layer_sector_stock")
    parser.add_argument("--external-stock-cache", default="lab/backtests/stock_momentum_validation/akshare_cache/stocks")
    args = parser.parse_args()

    disable_requests_env_proxy()
    output_dir = Path(args.output_dir)
    cache_dir = output_dir / "akshare_cache"
    output_dir.mkdir(parents=True, exist_ok=True)

    etf_close = build_etf_panel(args.start, args.end, cache_dir)
    selections = first_layer_selection(etf_close, args.top_sector_n)
    selected_etfs = set(code for values in selections["selected_etfs"] for code in values)
    pools, mapping_log = build_sector_pools(cache_dir)
    stock_close, stock_amount, stock_log = build_stock_panels(
        pools,
        selected_etfs,
        args.start,
        args.end,
        cache_dir,
        Path(args.external_stock_cache) if args.external_stock_cache else None,
    )

    trading_index = etf_close.index
    stock_close = stock_close.reindex(trading_index)
    stock_amount = stock_amount.reindex(trading_index)
    weights, etf_weights, selection_log = build_stock_strategy_weights(
        trading_index,
        selections,
        pools,
        stock_close,
        stock_amount,
        etf_close,
        args.active_weight,
        args.base_weight,
        args.top_stock_n,
        args.min_avg_amount,
    )

    combined_prices = pd.concat([stock_close, etf_close[BASE_ETFS]], axis=1)
    strategy_ret, strategy_trades = portfolio_returns(combined_prices, weights, args.cost_bps)
    etf_prices = etf_close.reindex(trading_index)
    etf_ret, etf_trades = portfolio_returns(etf_prices, etf_weights, args.cost_bps)

    equal_weight_ret = etf_close.pct_change(fill_method=None).mean(axis=1, skipna=True).fillna(0.0)
    results = {
        "two_layer_top5_stock": strategy_ret,
        "same_layer_etf_proxy": etf_ret,
        "dynamic_etf_equal_weight": equal_weight_ret,
    }
    metrics_df = pd.DataFrame([{"strategy": name, **metrics(ret)} for name, ret in results.items()])
    yearly = pd.DataFrame({name: yearly_returns(ret) for name, ret in results.items()}).sort_index()

    mapping_log.to_csv(output_dir / "sector_mapping_log.csv", index=False)
    stock_log.to_csv(output_dir / "stock_fetch_log.csv", index=False)
    selections.assign(
        selected_etfs=selections["selected_etfs"].map(lambda xs: ",".join(xs)),
        selected_names=selections["selected_names"].map(lambda xs: ",".join(xs)),
    ).to_csv(output_dir / "first_layer_selections.csv")
    selection_log.to_csv(output_dir / "stock_selection_log.csv", index=False)
    weights.to_csv(output_dir / "weights.csv")
    etf_weights.to_csv(output_dir / "etf_proxy_weights.csv")
    metrics_df.to_csv(output_dir / "metrics.csv", index=False)
    yearly.to_csv(output_dir / "yearly_returns.csv")
    strategy_trades.to_csv(output_dir / "strategy_trades.csv", index=False)
    etf_trades.to_csv(output_dir / "etf_proxy_trades.csv", index=False)
    for name, ret in results.items():
        (1.0 + ret).cumprod().rename("nav").to_csv(output_dir / f"{name}_nav.csv")

    summary = {
        "data_source": "AKShare fund_etf_hist_sina ETF bars; stock_sector_detail current sector constituents; stock_zh_a_daily Sina qfq stock bars.",
        "as_of": args.end,
        "config": vars(args),
        "rules": {
            "first_layer": "Monthly select Top3 non-defensive sector ETFs by 0.5*126d return + 0.5*252d return, positive scores only.",
            "base_sleeve": "Always allocate 10% each to gold ETF 518880, coal ETF 515220, and dividend ETF 510880 when data is available.",
            "second_layer": "For each selected sector, allocate its active sleeve to Top5 current constituent stocks by 252d momentum skipping recent 20 trading days; fallback to ETF if no valid stocks.",
            "weights": "70% active sector-stock sleeve plus 30% defensive ETF base sleeve.",
        },
        "known_limitations": [
            "Sector stock pools use current Sina board constituents, not point-in-time historical constituents; this introduces look-ahead and survivorship bias.",
            "Sector-to-ETF mapping is approximate for several themes, especially broad consumption, semiconductor/chip, and securities.",
            "Historical ST flags, limit-up/limit-down execution blocking, and full suspension handling are not modeled.",
            "Gold is held through ETF base sleeve; no gold-stock selection is attempted in this first pass.",
        ],
        "selected_sector_count": int(len(selected_etfs)),
        "stocks_loaded": int((stock_log["status"] == "ok").sum()) if not stock_log.empty else 0,
        "stock_fetch_failures": int((stock_log["status"] != "ok").sum()) if not stock_log.empty else 0,
        "metrics": metrics_df.to_dict("records"),
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    printable = metrics_df.copy()
    for col in ["total_return", "annual_return", "annual_vol", "max_drawdown", "positive_day_rate"]:
        printable[col] = printable[col].map(pct)
    printable["sharpe"] = printable["sharpe"].map(lambda x: f"{x:.2f}")
    print(printable.to_string(index=False))
    print(f"\nArtifacts written to: {output_dir}")


if __name__ == "__main__":
    main()

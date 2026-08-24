#!/usr/bin/env python3
"""First-stage sector ETF rotation analysis using AKShare data."""

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
    "512880": {"name": "证券ETF", "group": "金融"},
    "512800": {"name": "银行ETF", "group": "金融"},
    "512660": {"name": "军工ETF", "group": "制造"},
    "512010": {"name": "医药ETF", "group": "医药"},
    "512170": {"name": "医疗ETF", "group": "医药"},
    "159928": {"name": "消费ETF", "group": "消费"},
    "512690": {"name": "酒ETF", "group": "消费"},
    "512480": {"name": "半导体ETF", "group": "科技"},
    "159995": {"name": "芯片ETF", "group": "科技"},
    "515030": {"name": "新能源车ETF", "group": "新能源"},
    "515790": {"name": "光伏ETF", "group": "新能源"},
    "512400": {"name": "有色ETF", "group": "周期"},
    "515220": {"name": "煤炭ETF", "group": "周期"},
    "512980": {"name": "传媒ETF", "group": "TMT"},
    "512200": {"name": "房地产ETF", "group": "地产"},
    "159998": {"name": "计算机ETF", "group": "科技"},
    "515050": {"name": "5GETF", "group": "科技"},
    "518880": {"name": "黄金ETF", "group": "避险"},
    "510880": {"name": "红利ETF", "group": "红利"},
}

DEFAULT_START = "20210101"
DEFAULT_END = "20260717"
DEFAULT_COST_BPS = 5.0
SPLIT_JUMP_THRESHOLD = 0.35


def disable_requests_env_proxy() -> None:
    original = requests.sessions.Session.merge_environment_settings

    def merge_without_proxy(self, url, proxies, stream, verify, cert):  # type: ignore[no-untyped-def]
        settings = original(self, url, proxies, stream, verify, cert)
        settings["proxies"] = {}
        return settings

    requests.sessions.Session.merge_environment_settings = merge_without_proxy


def sina_symbol(code: str) -> str:
    return f"sh{code}" if code.startswith("5") else f"sz{code}"


def fetch_etf(code: str, start: str, end: str, cache_dir: Path) -> pd.DataFrame:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"etf_{code}_{start}_{end}_sina.csv"
    if cache_file.exists():
        raw = pd.read_csv(cache_file)
    else:
        raw = ak.fund_etf_hist_sina(symbol=sina_symbol(code))
        raw["source"] = "fund_etf_hist_sina_unadjusted"
        raw.to_csv(cache_file, index=False)
        time.sleep(0.1)

    df = raw.rename(columns={"date": "date", "close": "close", "amount": "amount"})
    df["date"] = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["amount"] = pd.to_numeric(df.get("amount"), errors="coerce")
    df = df[(df["date"] >= pd.to_datetime(start)) & (df["date"] <= pd.to_datetime(end))]
    df = df.sort_values("date").reset_index(drop=True)
    df["raw_close"] = df["close"]
    df["close"] = split_adjusted_close(df["close"])
    return df[["date", "close", "amount"]].dropna(subset=["date", "close"])


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


def build_panels(
    start: str,
    end: str,
    cache_dir: Path,
    universe_mode: str,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    closes = {}
    amounts = {}
    rows = []
    for code, meta in ETF_POOL.items():
        try:
            df = fetch_etf(code, start, end, cache_dir)
            closes[code] = df.set_index("date")["close"].sort_index()
            amounts[code] = df.set_index("date")["amount"].sort_index()
            rows.append(
                {
                    "code": code,
                    "name": meta["name"],
                    "group": meta["group"],
                    "rows": len(df),
                    "start": df["date"].min().date().isoformat(),
                    "end": df["date"].max().date().isoformat(),
                    "avg_amount_20d": float(df.tail(20)["amount"].mean()),
                    "status": "ok",
                }
            )
        except Exception as exc:  # noqa: BLE001
            rows.append(
                {
                    "code": code,
                    "name": meta["name"],
                    "group": meta["group"],
                    "rows": 0,
                    "start": None,
                    "end": None,
                    "avg_amount_20d": np.nan,
                    "status": f"error: {type(exc).__name__}: {exc}",
                }
            )
    close = pd.DataFrame(closes).sort_index()
    if universe_mode == "common":
        close = close.dropna()
    else:
        close = close.dropna(how="all")
    amount = pd.DataFrame(amounts).reindex(close.index)
    return close, amount, pd.DataFrame(rows)


def month_end_dates(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.Series(index, index=index).groupby(index.to_period("M")).tail(1).values)


def make_scores(close: pd.DataFrame) -> pd.DataFrame:
    return 0.5 * (close / close.shift(126) - 1.0) + 0.5 * (close / close.shift(252) - 1.0)


def rank_ic_analysis(close: pd.DataFrame, scores: pd.DataFrame) -> pd.DataFrame:
    rows = []
    forward_1m = close.shift(-20) / close - 1.0
    forward_3m = close.shift(-60) / close - 1.0
    for date in month_end_dates(close.index):
        sample = pd.DataFrame({"score": scores.loc[date], "fwd_1m": forward_1m.loc[date], "fwd_3m": forward_3m.loc[date]}).dropna()
        if len(sample) < 8:
            continue
        rows.append(
            {
                "date": date.date().isoformat(),
                "sample_size": len(sample),
                "rank_ic_1m": float(sample["score"].rank().corr(sample["fwd_1m"].rank())),
                "rank_ic_3m": float(sample["score"].rank().corr(sample["fwd_3m"].rank())),
            }
        )
    return pd.DataFrame(rows)


def layer_analysis(close: pd.DataFrame, scores: pd.DataFrame) -> pd.DataFrame:
    rows = []
    forward_1m = close.shift(-20) / close - 1.0
    for date in month_end_dates(close.index):
        sample = pd.DataFrame({"score": scores.loc[date], "fwd": forward_1m.loc[date]}).dropna()
        if len(sample) < 12:
            continue
        sample["layer"] = pd.qcut(sample["score"].rank(method="first"), 3, labels=["low", "mid", "high"])
        grouped = sample.groupby("layer", observed=False)["fwd"].mean()
        rows.append(
            {
                "date": date.date().isoformat(),
                "low": float(grouped.get("low", np.nan)),
                "mid": float(grouped.get("mid", np.nan)),
                "high": float(grouped.get("high", np.nan)),
                "high_minus_low": float(grouped.get("high", np.nan) - grouped.get("low", np.nan)),
            }
        )
    return pd.DataFrame(rows)


def strategy_weights(close: pd.DataFrame, scores: pd.DataFrame, top_n: int) -> pd.DataFrame:
    weights = pd.DataFrame(np.nan, index=close.index, columns=close.columns)
    for date in month_end_dates(close.index):
        row = scores.loc[date].dropna()
        row = row[row > 0]
        selected = row.sort_values(ascending=False).head(top_n).index
        weights.loc[date, :] = 0.0
        if len(selected) > 0:
            weights.loc[date, selected] = 1.0 / len(selected)
    return weights.ffill().fillna(0.0)


def strategy_returns(close: pd.DataFrame, weights: pd.DataFrame, cost_bps: float) -> tuple[pd.Series, pd.DataFrame]:
    asset_returns = close.pct_change(fill_method=None)
    gross = (weights.shift(1).fillna(0.0) * asset_returns.fillna(0.0)).sum(axis=1)
    net = gross.copy()
    trades = []
    rebalance_dates = month_end_dates(close.index)
    previous = pd.Series(0.0, index=weights.columns)
    cost_rate = cost_bps / 10_000.0
    dates = list(close.index)
    pos = {date: idx for idx, date in enumerate(dates)}
    equal_weight = asset_returns.mean(axis=1, skipna=True).fillna(0.0)

    for signal_date in rebalance_dates:
        if signal_date not in pos or pos[signal_date] + 1 >= len(dates):
            continue
        effective_date = dates[pos[signal_date] + 1]
        next_signal_candidates = [date for date in rebalance_dates if date > signal_date]
        end_date = next_signal_candidates[0] if next_signal_candidates else dates[-1]
        target = weights.loc[signal_date].fillna(0.0)
        turnover = float((target - previous).abs().sum())
        if turnover > 1e-12:
            net.loc[effective_date] -= turnover * cost_rate
        period_returns = close.loc[end_date] / close.loc[effective_date] - 1.0
        pool_return = float(equal_weight.loc[effective_date:end_date].add(1.0).prod() - 1.0)
        selected = target[target > 0].index.tolist()
        selected_return = float(period_returns[selected].mean()) if selected else 0.0
        trades.append(
            {
                "signal_date": signal_date.date().isoformat(),
                "effective_date": effective_date.date().isoformat(),
                "end_date": end_date.date().isoformat(),
                "selected": ",".join(selected),
                "selected_names": ",".join(ETF_POOL[code]["name"] for code in selected),
                "holding_count": len(selected),
                "turnover": turnover,
                "cost": turnover * cost_rate,
                "period_return": selected_return,
                "equal_weight_return": pool_return,
                "absolute_effective": bool(selected_return > 0),
                "relative_effective": bool(selected_return > pool_return),
            }
        )
        previous = target
    return net, pd.DataFrame(trades)


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


def holding_streaks(weights: pd.DataFrame) -> pd.DataFrame:
    rows = []
    monthly = weights.loc[month_end_dates(weights.index)]
    for code in weights.columns:
        in_pos = monthly[code] > 0
        start = None
        length = 0
        for date, held in in_pos.items():
            if held and start is None:
                start = date
                length = 1
            elif held:
                length += 1
            elif start is not None:
                rows.append({"code": code, "name": ETF_POOL[code]["name"], "start": start.date().isoformat(), "end": prev.date().isoformat(), "months": length})
                start = None
                length = 0
            prev = date
        if start is not None:
            rows.append({"code": code, "name": ETF_POOL[code]["name"], "start": start.date().isoformat(), "end": prev.date().isoformat(), "months": length})
    return pd.DataFrame(rows)


def rotation_diagnostics(close: pd.DataFrame, scores: pd.DataFrame, weights: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, float | int]]:
    rebalance_dates = month_end_dates(close.index)
    rows = []
    for date in rebalance_dates:
        score = scores.loc[date].dropna().sort_values(ascending=False)
        if score.empty:
            continue
        selected = set(weights.loc[date][weights.loc[date] > 0].index)
        rows.append(
            {
                "date": date.date().isoformat(),
                "top1": score.index[0],
                "top1_name": ETF_POOL[score.index[0]]["name"],
                "top3": ",".join(score.head(3).index),
                "selected": ",".join(sorted(selected)),
                "selected_count": len(selected),
                "selected_contains_top1": score.index[0] in selected,
                "top3_overlap_selected": len(set(score.head(3).index) & selected),
            }
        )
    leader = pd.DataFrame(rows)
    if leader.empty:
        return leader, pd.DataFrame(), {}
    transitions = pd.crosstab(leader["top1_name"].shift(1), leader["top1_name"], normalize="index").fillna(0.0)
    stats = {
        "months": int(len(leader)),
        "top1_repeat_rate": float((leader["top1"] == leader["top1"].shift(1)).mean()),
        "avg_selected_count": float(leader["selected_count"].mean()),
        "selected_contains_top1_rate": float(leader["selected_contains_top1"].mean()),
        "avg_top3_overlap_selected": float(leader["top3_overlap_selected"].mean()),
    }
    return leader, transitions, stats


def monthly_availability(close: pd.DataFrame, scores: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for date in month_end_dates(close.index):
        rows.append(
            {
                "date": date.date().isoformat(),
                "listed_count": int(close.loc[date].dropna().shape[0]),
                "scored_count": int(scores.loc[date].dropna().shape[0]),
                "positive_score_count": int((scores.loc[date].dropna() > 0).sum()),
            }
        )
    return pd.DataFrame(rows)


def correlation_summary(close: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, float | list[dict[str, float | str]]]]:
    corr = close.pct_change(fill_method=None).dropna().corr()
    pairs = []
    cols = list(corr.columns)
    for i, left in enumerate(cols):
        for right in cols[i + 1 :]:
            pairs.append(
                {
                    "left": left,
                    "left_name": ETF_POOL[left]["name"],
                    "right": right,
                    "right_name": ETF_POOL[right]["name"],
                    "corr": float(corr.loc[left, right]),
                }
            )
    pair_df = pd.DataFrame(pairs)
    return corr, {
        "avg_pairwise_corr": float(pair_df["corr"].mean()),
        "median_pairwise_corr": float(pair_df["corr"].median()),
        "highest_corr_pairs": pair_df.sort_values("corr", ascending=False).head(8).to_dict("records"),
        "lowest_corr_pairs": pair_df.sort_values("corr").head(8).to_dict("records"),
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


def summarize_trades(trades: pd.DataFrame) -> dict[str, float | int]:
    if trades.empty:
        return {}
    active = trades[trades["holding_count"] > 0]
    changed = active[active["turnover"] > 1e-12]
    denominator = max(len(active), 1)
    return {
        "rebalance_count": int(len(trades)),
        "active_holding_periods": int(len(active)),
        "trade_count_with_turnover": int(len(changed)),
        "avg_turnover": float(active["turnover"].mean()) if not active.empty else 0.0,
        "annualized_turnover": float(active["turnover"].sum() / max(len(active) / 12, 1e-9)) if not active.empty else 0.0,
        "absolute_effective_count": int(active["absolute_effective"].sum()),
        "absolute_effective_rate": float(active["absolute_effective"].sum() / denominator),
        "relative_effective_count": int(active["relative_effective"].sum()),
        "relative_effective_rate": float(active["relative_effective"].sum() / denominator),
        "avg_period_return": float(active["period_return"].mean()) if not active.empty else 0.0,
        "avg_equal_weight_return": float(active["equal_weight_return"].mean()) if not active.empty else 0.0,
    }


def pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default=DEFAULT_START)
    parser.add_argument("--end", default=DEFAULT_END)
    parser.add_argument("--top-n", type=int, default=3)
    parser.add_argument("--cost-bps", type=float, default=DEFAULT_COST_BPS)
    parser.add_argument("--universe-mode", choices=["common", "dynamic"], default="common")
    parser.add_argument("--output-dir", default="lab/backtests/sector_etf_rotation_analysis")
    args = parser.parse_args()

    disable_requests_env_proxy()
    output_dir = Path(args.output_dir)
    cache_dir = output_dir / "akshare_cache"
    output_dir.mkdir(parents=True, exist_ok=True)

    close, amount, universe = build_panels(args.start, args.end, cache_dir, args.universe_mode)
    scores = make_scores(close)
    weights = strategy_weights(close, scores, args.top_n)
    strategy_ret, trades = strategy_returns(close, weights, args.cost_bps)
    equal_weight_ret = close.pct_change(fill_method=None).mean(axis=1, skipna=True).fillna(0.0)

    ic = rank_ic_analysis(close, scores)
    layers = layer_analysis(close, scores)
    streaks = holding_streaks(weights)
    leader, transitions, rotation_stats = rotation_diagnostics(close, scores, weights)
    corr, corr_stats = correlation_summary(close)
    availability = monthly_availability(close, scores)

    metrics = pd.DataFrame(
        [
            {"strategy": f"sector ETF momentum Top{args.top_n}", **performance_metrics(strategy_ret)},
            {"strategy": "sector ETF equal weight", **performance_metrics(equal_weight_ret)},
        ]
    )

    universe.to_csv(output_dir / "universe.csv", index=False)
    ic.to_csv(output_dir / "rank_ic.csv", index=False)
    layers.to_csv(output_dir / "layer_returns.csv", index=False)
    weights.to_csv(output_dir / "weights.csv")
    trades.to_csv(output_dir / "trades.csv", index=False)
    streaks.to_csv(output_dir / "holding_streaks.csv", index=False)
    leader.to_csv(output_dir / "leader_monthly.csv", index=False)
    availability.to_csv(output_dir / "monthly_availability.csv", index=False)
    transitions.to_csv(output_dir / "leader_transition_matrix.csv")
    corr.rename(index={c: ETF_POOL[c]["name"] for c in corr.index}, columns={c: ETF_POOL[c]["name"] for c in corr.columns}).to_csv(output_dir / "correlation_matrix.csv")
    metrics.to_csv(output_dir / "metrics.csv", index=False)
    pd.DataFrame(
        {
            "sector ETF momentum Top3": yearly_returns(strategy_ret),
            "sector ETF equal weight": yearly_returns(equal_weight_ret),
        }
    ).sort_index().to_csv(output_dir / "yearly_returns.csv")

    ic_summary = {
        "periods": int(len(ic)),
        "mean_rank_ic_1m": float(ic["rank_ic_1m"].mean()),
        "median_rank_ic_1m": float(ic["rank_ic_1m"].median()),
        "positive_rate_1m": float((ic["rank_ic_1m"] > 0).mean()),
        "mean_rank_ic_3m": float(ic["rank_ic_3m"].mean()),
        "positive_rate_3m": float((ic["rank_ic_3m"] > 0).mean()),
    }
    layer_summary = {
        "periods": int(len(layers)),
        "mean_low": float(layers["low"].mean()),
        "mean_mid": float(layers["mid"].mean()),
        "mean_high": float(layers["high"].mean()),
        "mean_high_minus_low": float(layers["high_minus_low"].mean()),
        "high_minus_low_positive_rate": float((layers["high_minus_low"] > 0).mean()),
    }
    streak_summary = {
        "streak_count": int(len(streaks)),
        "avg_months": float(streaks["months"].mean()) if not streaks.empty else 0.0,
        "median_months": float(streaks["months"].median()) if not streaks.empty else 0.0,
        "max_months": int(streaks["months"].max()) if not streaks.empty else 0,
        "longest_streaks": streaks.sort_values("months", ascending=False).head(10).to_dict("records") if not streaks.empty else [],
    }
    summary = {
        "data_source": "AKShare fund_etf_hist_sina unadjusted ETF daily bars.",
        "as_of": args.end,
        "config": vars(args),
        "universe_count": int(len(close.columns)),
        "availability_summary": {
            "months": int(len(availability)),
            "avg_listed_count": float(availability["listed_count"].mean()),
            "avg_scored_count": float(availability["scored_count"].mean()),
            "avg_positive_score_count": float(availability["positive_score_count"].mean()),
            "first_scored_month": str(availability[availability["scored_count"] > 0]["date"].iloc[0])
            if (availability["scored_count"] > 0).any()
            else None,
            "latest_scored_count": int(availability["scored_count"].iloc[-1]) if not availability.empty else 0,
        },
        "universe": ETF_POOL,
        "rules": {
            "score": "0.5 * 126-trading-day return + 0.5 * 252-trading-day return.",
            "selection": f"At month end select Top{args.top_n} ETFs with positive score; equal weight; otherwise cash.",
            "execution": "Month-end signal, next trading day effective; cash return assumed 0.",
            "effective_trade": "A holding leg is absolute-effective if next holding-period return > 0; relative-effective if it outperforms the ETF pool equal-weight return.",
        },
        "metrics": metrics.to_dict("records"),
        "ic_summary": ic_summary,
        "layer_summary": layer_summary,
        "trade_summary": summarize_trades(trades),
        "rotation_stats": rotation_stats,
        "streak_summary": streak_summary,
        "correlation_summary": corr_stats,
        "known_limitations": [
            "ETF price series are Sina unadjusted prices; ETF distributions can introduce small distortions.",
            "Industry ETF launch dates differ; common mode starts only after all ETFs have data, while dynamic mode admits ETFs after they have enough history.",
            "This is a sector-layer analysis only; no individual stock selection is included.",
        ],
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    printable = metrics.copy()
    for col in ["total_return", "annual_return", "annual_vol", "max_drawdown", "positive_day_rate"]:
        printable[col] = printable[col].map(pct)
    printable["sharpe"] = printable["sharpe"].map(lambda x: f"{x:.2f}")
    print("Metrics")
    print(printable.to_string(index=False))
    print("\nIC summary")
    print(json.dumps(ic_summary, ensure_ascii=False, indent=2))
    print("\nLayer summary")
    print(json.dumps(layer_summary, ensure_ascii=False, indent=2))
    print("\nTrade summary")
    print(json.dumps(summary["trade_summary"], ensure_ascii=False, indent=2))
    print("\nRotation stats")
    print(json.dumps(rotation_stats, ensure_ascii=False, indent=2))
    print(f"\nArtifacts written to: {output_dir}")


if __name__ == "__main__":
    main()

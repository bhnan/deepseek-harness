#!/usr/bin/env python3
"""Validate the historical price-reconstructable part of multifactor V2.

V2 fixes the beta factor by scoring beta differently for mainline, defensive,
and repair candidates.
"""

from __future__ import annotations

import json
import math
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / "lab/backtests/multifactor_v1_supplement"
OUTPUT_DIR = ROOT / "lab/backtests/multifactor_v2_type_beta_validation"
SECTOR_BARS = ROOT / "lab/backtests/recent_sector_trend/sw_first_level_daily_bars_latest.csv"
REPORT_PATH = OUTPUT_DIR / "multifactor_v2_type_beta_validation_report.md"
MARKET_INDEX_CANDIDATES = [
    ROOT / "lab/backtests/stock_momentum_validation/akshare_cache/index_sh000905_20150101_20260717.csv",
    ROOT / "lab/backtests/etf_rotation_validation/akshare_cache/index_sh000300_20150101_20260717.csv",
]

START_DATE = "2017-01-01"
END_DATE = "2026-07-17"
MIN_AVG_AMOUNT = 20_000_000
MIN_SAMPLE = 80
REBALANCE = "M"
HORIZONS = {"20d": 20, "60d": 60}


def zcode(value: object) -> str:
    return str(value).split(".")[0].zfill(6)


def pct(x: float | int | None, digits: int = 2) -> str:
    if x is None or pd.isna(x):
        return "-"
    return f"{float(x) * 100:.{digits}f}%"


def num(x: float | int | None, digits: int = 3) -> str:
    if x is None or pd.isna(x):
        return "-"
    return f"{float(x):.{digits}f}"


def read_stock_cache(candidate_codes: set[str]) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    best: dict[str, tuple[int, Path]] = {}
    for path in ROOT.glob("lab/backtests/*/akshare_cache/stocks/*.csv"):
        code = path.name.split("_", 1)[0][2:]
        if code not in candidate_codes:
            continue
        try:
            rows = sum(1 for _ in path.open("r", encoding="utf-8", errors="ignore")) - 1
        except OSError:
            continue
        old = best.get(code)
        if old is None or rows > old[0]:
            best[code] = (rows, path)

    closes: dict[str, pd.Series] = {}
    amounts: dict[str, pd.Series] = {}
    log_rows = []
    for code, (_, path) in sorted(best.items()):
        df = pd.read_csv(path)
        if not {"date", "close", "amount"}.issubset(df.columns):
            continue
        df["date"] = pd.to_datetime(df["date"])
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
        df = df[(df["date"] >= START_DATE) & (df["date"] <= END_DATE)].dropna(subset=["date", "close"])
        if df.empty:
            continue
        closes[code] = df.set_index("date")["close"].sort_index()
        amounts[code] = df.set_index("date")["amount"].sort_index()
        log_rows.append(
            {
                "stock_code": code,
                "cache_file": str(path.relative_to(ROOT)),
                "rows": int(len(df)),
                "start": df["date"].min().date().isoformat(),
                "end": df["date"].max().date().isoformat(),
            }
        )

    close = pd.DataFrame(closes).sort_index()
    amount = pd.DataFrame(amounts).sort_index().reindex(close.index)
    return close, amount, pd.DataFrame(log_rows)


def month_end_dates(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    grouped = pd.Series(index, index=index).groupby(index.to_period(REBALANCE)).tail(1)
    return pd.DatetimeIndex(grouped.values)


def percentile_rank(df: pd.DataFrame, ascending: bool = True) -> pd.DataFrame:
    return df.rank(axis=1, pct=True, ascending=ascending)


def rolling_beta_pair(y: pd.Series, x: pd.Series, window: int, min_periods: int) -> tuple[pd.Series, pd.Series]:
    cov = y.rolling(window, min_periods=min_periods).cov(x)
    var = x.rolling(window, min_periods=min_periods).var()
    beta = cov / var.replace(0, np.nan)
    corr = y.rolling(window, min_periods=min_periods).corr(x)
    return beta, corr.pow(2)


def rolling_conditional_beta(y: pd.Series, x: pd.Series, window: int, direction: str) -> pd.Series:
    if direction == "up":
        mask = x > 0
    elif direction == "down":
        mask = x < 0
    else:
        raise ValueError(f"unknown direction: {direction}")
    yy = y.where(mask)
    xx = x.where(mask)
    min_periods = min(30, max(12, int(window * 0.25)))
    cov = yy.rolling(window, min_periods=min_periods).cov(xx)
    var = xx.rolling(window, min_periods=min_periods).var()
    return cov / var.replace(0, np.nan)


def rolling_beta_bundle(
    stock_returns: pd.DataFrame,
    benchmark_returns: pd.DataFrame,
    stock_to_sector: dict[str, str],
    window: int = 120,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    betas: dict[str, pd.Series] = {}
    r2s: dict[str, pd.Series] = {}
    up_betas: dict[str, pd.Series] = {}
    down_betas: dict[str, pd.Series] = {}
    for code, sector_code in stock_to_sector.items():
        if code not in stock_returns or sector_code not in benchmark_returns:
            continue
        x = benchmark_returns[sector_code]
        y = stock_returns[code]
        beta, r2 = rolling_beta_pair(y, x, window=window, min_periods=min(80, max(30, int(window * 0.67))))
        betas[code] = beta
        r2s[code] = r2
        up_betas[code] = rolling_conditional_beta(y, x, window=window, direction="up")
        down_betas[code] = rolling_conditional_beta(y, x, window=window, direction="down")
    return pd.DataFrame(betas), pd.DataFrame(r2s), pd.DataFrame(up_betas), pd.DataFrame(down_betas)


def rolling_market_beta_bundle(
    stock_returns: pd.DataFrame,
    market_return: pd.Series,
    window: int = 120,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    betas: dict[str, pd.Series] = {}
    r2s: dict[str, pd.Series] = {}
    up_betas: dict[str, pd.Series] = {}
    down_betas: dict[str, pd.Series] = {}
    for code in stock_returns.columns:
        y = stock_returns[code]
        beta, r2 = rolling_beta_pair(y, market_return, window=window, min_periods=80)
        betas[code] = beta
        r2s[code] = r2
        up_betas[code] = rolling_conditional_beta(y, market_return, window=window, direction="up")
        down_betas[code] = rolling_conditional_beta(y, market_return, window=window, direction="down")
    return pd.DataFrame(betas), pd.DataFrame(r2s), pd.DataFrame(up_betas), pd.DataFrame(down_betas)


def load_market_close() -> tuple[pd.Series, str]:
    for path in MARKET_INDEX_CANDIDATES:
        if not path.exists():
            continue
        df = pd.read_csv(path)
        if not {"date", "close"}.issubset(df.columns):
            continue
        df["date"] = pd.to_datetime(df["date"])
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        df = df[(df["date"] >= START_DATE) & (df["date"] <= END_DATE)].dropna(subset=["date", "close"])
        if not df.empty:
            return df.set_index("date")["close"].sort_index(), path.name
    raise FileNotFoundError("no local market index cache found")


def type_beta_method(source_group: str) -> str:
    if "主线" in source_group:
        return "主线：行业上涨弹性"
    if "防守" in source_group:
        return "防守：大盘下跌防御"
    if "修复" in source_group:
        return "修复：Beta结构改善"
    return "通用：行业代表性"


def make_factor_panel(
    signal_dates: pd.DatetimeIndex | None = None,
    horizons: dict[str, int] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Build price-only factor rows for monthly defaults or supplied signal dates."""

    current = pd.read_csv(INPUT_DIR / "multifactor_v1_stock_sector_scores.csv", dtype={"stock_code": str, "sector_code": str})
    current["stock_code"] = current["stock_code"].map(zcode)
    current["sector_code"] = current["sector_code"].astype(str)
    candidates = current[["stock_code", "stock_name", "sector_code", "sector_name", "source_group"]].copy()
    candidates = candidates.sort_values(["source_group", "sector_code", "stock_code"]).reset_index(drop=True)
    universe = candidates.drop_duplicates("stock_code").copy()

    stock_close, stock_amount, cache_log = read_stock_cache(set(universe["stock_code"]))
    candidates = candidates[candidates["stock_code"].isin(stock_close.columns)].copy()
    universe = universe[universe["stock_code"].isin(stock_close.columns)].copy()
    stock_close = stock_close.reindex(columns=universe["stock_code"]).ffill(limit=10)
    stock_amount = stock_amount.reindex(index=stock_close.index, columns=stock_close.columns)

    sectors = pd.read_csv(SECTOR_BARS, dtype={"code": str})
    sectors["date"] = pd.to_datetime(sectors["date"])
    sectors["close"] = pd.to_numeric(sectors["close"], errors="coerce")
    sectors = sectors[(sectors["date"] >= START_DATE) & (sectors["date"] <= END_DATE)]
    sector_close = sectors.pivot_table(index="date", columns="code", values="close", aggfunc="last").sort_index().ffill()
    common_index = stock_close.index.union(sector_close.index).sort_values()
    stock_close = stock_close.reindex(common_index).ffill(limit=10)
    stock_amount = stock_amount.reindex(common_index)
    sector_close = sector_close.reindex(common_index).ffill()
    market_close, market_source = load_market_close()
    market_close = market_close.reindex(common_index).ffill()

    sector_raw = (
        0.25 * (sector_close / sector_close.shift(252) - 1.0)
        + 0.35 * (sector_close / sector_close.shift(126) - 1.0)
        + 0.25 * (sector_close / sector_close.shift(63) - 1.0)
        + 0.15 * (sector_close / sector_close.shift(20) - 1.0)
    )
    sector_trend_score = percentile_rank(sector_raw)

    stock_raw_mom = (
        0.25 * (stock_close.shift(20) / stock_close.shift(252) - 1.0)
        + 0.35 * (stock_close / stock_close.shift(126) - 1.0)
        + 0.25 * (stock_close / stock_close.shift(63) - 1.0)
        + 0.15 * (stock_close / stock_close.shift(20) - 1.0)
    )
    stock_momentum_score = percentile_rank(stock_raw_mom)

    avg_amount_20 = stock_amount.rolling(20, min_periods=10).mean()
    liquidity_score = percentile_rank(np.log1p(avg_amount_20))

    from_high_252 = stock_close / stock_close.rolling(252, min_periods=126).max() - 1.0
    drawdown_score = percentile_rank(from_high_252)

    stock_ret = stock_close.pct_change(fill_method=None)
    sector_ret = sector_close.pct_change(fill_method=None)
    stock_to_sector = dict(zip(universe["stock_code"], universe["sector_code"], strict=False))
    beta120, r2_120, up_beta120, down_beta120 = rolling_beta_bundle(stock_ret, sector_ret, stock_to_sector, window=120)
    beta60, r2_60, up_beta60, down_beta60 = rolling_beta_bundle(stock_ret, sector_ret, stock_to_sector, window=60)
    market_ret = market_close.pct_change(fill_method=None)
    market_beta120, market_r2_120, _, market_down_beta120 = rolling_market_beta_bundle(stock_ret, market_ret, window=120)
    stock_vol120 = stock_ret.rolling(120, min_periods=80).std()

    beta_quality_raw = beta120.clip(lower=0, upper=2.5) * np.sqrt(r2_120)
    industry_beta_score = percentile_rank(beta_quality_raw)

    mainline_beta_score = (
        0.45 * percentile_rank(up_beta120)
        + 0.25 * percentile_rank(up_beta120 - down_beta120)
        + 0.20 * percentile_rank(r2_120)
        + 0.10 * percentile_rank(beta120)
    )
    defensive_beta_score = (
        0.40 * percentile_rank(market_down_beta120, ascending=False)
        + 0.25 * percentile_rank(market_beta120, ascending=False)
        + 0.20 * percentile_rank(stock_vol120, ascending=False)
        + 0.15 * percentile_rank(market_r2_120, ascending=False)
    )
    repair_beta_score = (
        0.35 * percentile_rank(up_beta60 - up_beta120)
        + 0.30 * percentile_rank(down_beta120 - down_beta60)
        + 0.20 * percentile_rank(r2_60 - r2_120)
        + 0.15 * percentile_rank(up_beta60)
    )

    factor_rows = []
    label_horizons = horizons or HORIZONS
    labels = {
        horizon: stock_close.shift(-days) / stock_close - 1.0
        for horizon, days in label_horizons.items()
    }
    if signal_dates is None:
        rebal_dates = month_end_dates(stock_close.index)
    else:
        rebal_dates = pd.DatetimeIndex(pd.to_datetime(signal_dates)).unique().intersection(stock_close.index).sort_values()
    for date in rebal_dates:
        if date < pd.Timestamp("2018-01-01"):
            continue
        for row in candidates.itertuples(index=False):
            code = row.stock_code
            sector_code = row.sector_code
            source_group = row.source_group
            if "主线" in source_group:
                type_beta_score = mainline_beta_score.at[date, code] if code in mainline_beta_score else np.nan
            elif "防守" in source_group:
                type_beta_score = defensive_beta_score.at[date, code] if code in defensive_beta_score else np.nan
            elif "修复" in source_group:
                type_beta_score = repair_beta_score.at[date, code] if code in repair_beta_score else np.nan
            else:
                type_beta_score = industry_beta_score.at[date, code] if code in industry_beta_score else np.nan
            rec = {
                "date": date.date().isoformat(),
                "stock_code": code,
                "stock_name": row.stock_name,
                "sector_code": sector_code,
                "sector_name": row.sector_name,
                "source_group": source_group,
                "beta_score_method": type_beta_method(source_group),
                "industry_trend_score_hist": sector_trend_score.at[date, sector_code] if sector_code in sector_trend_score else np.nan,
                "stock_momentum_score_hist": stock_momentum_score.at[date, code],
                "industry_beta_score_hist": industry_beta_score.at[date, code] if code in industry_beta_score else np.nan,
                "type_beta_score_hist": type_beta_score,
                "liquidity_score_hist": liquidity_score.at[date, code],
                "drawdown_score_hist": drawdown_score.at[date, code],
                "sector_beta120_hist": beta120.at[date, code] if code in beta120 else np.nan,
                "sector_beta120_r2_hist": r2_120.at[date, code] if code in r2_120 else np.nan,
                "sector_up_beta120_hist": up_beta120.at[date, code] if code in up_beta120 else np.nan,
                "sector_down_beta120_hist": down_beta120.at[date, code] if code in down_beta120 else np.nan,
                "sector_up_beta60_hist": up_beta60.at[date, code] if code in up_beta60 else np.nan,
                "sector_down_beta60_hist": down_beta60.at[date, code] if code in down_beta60 else np.nan,
                "market_beta120_hist": market_beta120.at[date, code] if code in market_beta120 else np.nan,
                "market_down_beta120_hist": market_down_beta120.at[date, code] if code in market_down_beta120 else np.nan,
                "market_beta120_r2_hist": market_r2_120.at[date, code] if code in market_r2_120 else np.nan,
                "avg_amount_20d_hist": avg_amount_20.at[date, code],
                "market_index_source": market_source,
            }
            for horizon, label_panel in labels.items():
                rec[f"future_return_{horizon}"] = label_panel.at[date, code]
            factor_rows.append(rec)

    factors = pd.DataFrame(factor_rows)
    factors["price_proxy_score"] = (
        0.30 * factors["industry_trend_score_hist"]
        + 0.30 * factors["stock_momentum_score_hist"]
        + 0.15 * factors["industry_beta_score_hist"]
        + 0.15 * factors["liquidity_score_hist"]
        + 0.10 * factors["drawdown_score_hist"]
    )
    factors["price_proxy_score_v2"] = (
        0.30 * factors["industry_trend_score_hist"]
        + 0.30 * factors["stock_momentum_score_hist"]
        + 0.15 * factors["type_beta_score_hist"]
        + 0.15 * factors["liquidity_score_hist"]
        + 0.10 * factors["drawdown_score_hist"]
    )
    return factors, candidates, cache_log, current


def validate_factors(factors: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    factor_cols = [
        "industry_trend_score_hist",
        "stock_momentum_score_hist",
        "industry_beta_score_hist",
        "type_beta_score_hist",
        "liquidity_score_hist",
        "drawdown_score_hist",
        "price_proxy_score",
        "price_proxy_score_v2",
    ]
    score_models = {
        "V1统一行业Beta": "price_proxy_score",
        "V2类型化Beta": "price_proxy_score_v2",
    }
    ic_rows = []
    layer_rows = []
    topn_rows = []
    for horizon in HORIZONS:
        label = f"future_return_{horizon}"
        last_valid_date = factors.loc[factors[label].notna(), "date"].max()
        sample = factors[
            (factors["date"] <= last_valid_date)
            & (factors["avg_amount_20d_hist"] >= MIN_AVG_AMOUNT)
            & factors[label].notna()
        ].copy()
        for date, group in sample.groupby("date"):
            group = group.dropna(subset=[label, *factor_cols])
            if len(group) < MIN_SAMPLE:
                continue
            for col in factor_cols:
                ic_rows.append(
                    {
                        "horizon": horizon,
                        "date": date,
                        "factor": col,
                        "rank_ic": group[col].rank().corr(group[label].rank()),
                        "sample_size": int(len(group)),
                    }
                )
            for model_name, score_col in score_models.items():
                ranked = group.assign(layer=pd.qcut(group[score_col].rank(method="first"), 5, labels=False) + 1)
                for layer, layer_group in ranked.groupby("layer"):
                    layer_rows.append(
                        {
                            "horizon": horizon,
                            "date": date,
                            "score_model": model_name,
                            "layer": int(layer),
                            "mean_forward_return": float(layer_group[label].mean()),
                            "sample_size": int(len(layer_group)),
                        }
                    )
            base_ret = group[label].mean()
            for model_name, score_col in score_models.items():
                for n in [20, 30, 50]:
                    top = group.nlargest(n, score_col)
                    bottom = group.nsmallest(n, score_col)
                    if len(top) < n or len(bottom) < n:
                        continue
                    topn_rows.append(
                        {
                            "horizon": horizon,
                            "date": date,
                            "score_model": model_name,
                            "top_n": n,
                            "top_return": float(top[label].mean()),
                            "bottom_return": float(bottom[label].mean()),
                            "universe_return": float(base_ret),
                            "top_excess_vs_universe": float(top[label].mean() - base_ret),
                            "top_minus_bottom": float(top[label].mean() - bottom[label].mean()),
                        }
                    )
    ic = pd.DataFrame(ic_rows)
    layers = pd.DataFrame(layer_rows)
    topn = pd.DataFrame(topn_rows)
    return ic, layers, topn


def summarize_ic(ic: pd.DataFrame) -> pd.DataFrame:
    if ic.empty:
        return pd.DataFrame()
    out = (
        ic.groupby(["horizon", "factor"])
        .agg(
            periods=("rank_ic", "count"),
            mean_rank_ic=("rank_ic", "mean"),
            median_rank_ic=("rank_ic", "median"),
            positive_ratio=("rank_ic", lambda x: float((x > 0).mean())),
            ic_ir=("rank_ic", lambda x: float(x.mean() / x.std(ddof=1)) if x.std(ddof=1) > 0 else np.nan),
            avg_sample_size=("sample_size", "mean"),
        )
        .reset_index()
    )
    return out.sort_values(["horizon", "mean_rank_ic"], ascending=[True, False])


def summarize_layers(layers: pd.DataFrame) -> pd.DataFrame:
    if layers.empty:
        return pd.DataFrame()
    pivot = layers.pivot_table(index=["horizon", "score_model", "date"], columns="layer", values="mean_forward_return")
    out_rows = []
    for (horizon, score_model), group in pivot.groupby(level=[0, 1]):
        g = group.droplevel([0, 1])
        out_rows.append(
            {
                "horizon": horizon,
                "score_model": score_model,
                "periods": int(len(g)),
                "layer1_low_mean": float(g[1].mean()),
                "layer2_mean": float(g[2].mean()),
                "layer3_mean": float(g[3].mean()),
                "layer4_mean": float(g[4].mean()),
                "layer5_high_mean": float(g[5].mean()),
                "high_minus_low_mean": float((g[5] - g[1]).mean()),
                "high_beats_low_ratio": float((g[5] > g[1]).mean()),
            }
        )
    return pd.DataFrame(out_rows)


def summarize_topn(topn: pd.DataFrame) -> pd.DataFrame:
    if topn.empty:
        return pd.DataFrame()
    return (
        topn.groupby(["horizon", "score_model", "top_n"])
        .agg(
            periods=("top_return", "count"),
            top_return_mean=("top_return", "mean"),
            universe_return_mean=("universe_return", "mean"),
            excess_mean=("top_excess_vs_universe", "mean"),
            top_minus_bottom_mean=("top_minus_bottom", "mean"),
            excess_positive_ratio=("top_excess_vs_universe", lambda x: float((x > 0).mean())),
        )
        .reset_index()
    )


def current_tables(current: pd.DataFrame, factors: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    current = current.copy()
    current["stock_code"] = current["stock_code"].map(zcode)
    latest_date = factors["date"].max()
    latest_factor = factors[factors["date"] == latest_date][
        [
            "stock_code",
            "sector_code",
            "source_group",
            "beta_score_method",
            "type_beta_score_hist",
            "sector_beta120_hist",
            "sector_beta120_r2_hist",
            "sector_up_beta120_hist",
            "sector_down_beta120_hist",
            "sector_up_beta60_hist",
            "sector_down_beta60_hist",
            "market_beta120_hist",
            "market_down_beta120_hist",
            "market_beta120_r2_hist",
        ]
    ].copy()
    latest_factor = latest_factor.rename(columns={"type_beta_score_hist": "type_beta_score"})
    current = current.merge(
        latest_factor,
        on=["stock_code", "sector_code", "source_group"],
        how="left",
        validate="many_to_one",
    )
    current["type_beta_score"] = current["type_beta_score"].fillna(current["industry_beta_score"])
    current["multifactor_score_v2"] = (
        0.20 * current["industry_trend_score"]
        + 0.20 * current["momentum_score"]
        + 0.15 * current["type_beta_score"]
        + 0.15 * current["valuation_score"]
        + 0.15 * current["earnings_score"]
        + 0.10 * current["liquidity_score"]
        + 0.05 * current["drawdown_score"]
    )
    current["score_delta_v2_minus_v1"] = current["multifactor_score_v2"] - current["multifactor_score_v1"]
    current["quality_flag"] = np.select(
        [
            (current["20d_return"] < -0.08) & (current["1y_from_high"] < -0.25),
            current["avg_amount_20d"] < MIN_AVG_AMOUNT,
            current["sector_beta120_r2_hist"] < 0.20,
        ],
        ["短期转弱且离高点远", "流动性不足", "行业Beta解释弱"],
        default="观察",
    )
    cols = [
        "source_group",
        "sector_name",
        "stock_code",
        "stock_name",
        "multifactor_score_v2",
        "multifactor_score_v1",
        "score_delta_v2_minus_v1",
        "industry_trend_score",
        "momentum_score",
        "type_beta_score",
        "industry_beta_score",
        "beta_score_method",
        "valuation_score",
        "earnings_score",
        "liquidity_score",
        "drawdown_score",
        "1y_return",
        "6m_return",
        "3m_return",
        "20d_return",
        "1y_from_high",
        "avg_amount_20d",
        "quality_flag",
    ]
    main = current.sort_values("multifactor_score_v2", ascending=False).head(50)[cols]
    by_group = current.sort_values("multifactor_score_v2", ascending=False).groupby("source_group").head(20)[cols]
    warning = current[current["quality_flag"] != "观察"].sort_values("multifactor_score_v2", ascending=False).head(50)[cols]
    return main, by_group, warning


def write_markdown(
    ic_summary: pd.DataFrame,
    layer_summary: pd.DataFrame,
    topn_summary: pd.DataFrame,
    current_top: pd.DataFrame,
    by_group: pd.DataFrame,
    warnings: pd.DataFrame,
    universe: pd.DataFrame,
    cache_log: pd.DataFrame,
) -> None:
    def md_table(df: pd.DataFrame, columns: list[str], rows: int = 20) -> str:
        if df.empty:
            return "无可用数据。\n"
        view = df[columns].head(rows).copy()
        for col in view.columns:
            if "return" in col or "ratio" in col or "drawdown" in col or "from_high" in col or "excess" in col or "mean" in col:
                if pd.api.types.is_numeric_dtype(view[col]):
                    view[col] = view[col].map(lambda x: pct(x) if pd.notna(x) else "-")
            elif "score" in col or "ic" in col or col.endswith("_r2"):
                if pd.api.types.is_numeric_dtype(view[col]):
                    view[col] = view[col].map(lambda x: num(x) if pd.notna(x) else "-")
            elif "amount" in col:
                if pd.api.types.is_numeric_dtype(view[col]):
                    view[col] = view[col].map(lambda x: f"{x / 1e8:.2f}亿" if pd.notna(x) else "-")
        return view.to_markdown(index=False) + "\n"

    price_score = ic_summary[ic_summary["factor"] == "price_proxy_score_v2"] if not ic_summary.empty else pd.DataFrame()
    conclusion = []
    for row in price_score.itertuples(index=False):
        strength = "偏弱"
        if row.mean_rank_ic > 0.03 and row.positive_ratio > 0.55:
            strength = "有一定正向"
        if row.mean_rank_ic > 0.06 and row.positive_ratio > 0.60:
            strength = "较强"
        conclusion.append(f"{row.horizon} V2 类型化 Beta 综合价格代理因子：平均 Rank IC {row.mean_rank_ic:.3f}，正 IC 占比 {row.positive_ratio:.1%}，判断为{strength}。")
    if not conclusion:
        conclusion.append("历史验证样本不足，不能判断 V2 类型化 Beta 综合价格代理因子的稳定性。")

    text = f"""# 多因子 V2：类型化 Beta 修复验证报告

数据口径：AKShare/本地缓存，最新价格日 `{END_DATE}`；候选池来自上一版主线、修复、防守板块股票，共 `{len(universe)}` 条候选记录。

## 先给结论

{chr(10).join(f'- {item}' for item in conclusion)}
- 本次修复只替换 Beta 维度：V1 是所有类型都奖励高行业 Beta；V2 改为主线、防守、修复三套 Beta 评分。
- 历史验证仍只使用能按历史价格重建的 5 个因子；估值位置、盈利修复目前只在 `{END_DATE}` 当前截面使用，不拿当前数据回填历史。
- 当前 V2 七因子仍是“观察名单排序器”，不是已验证交易策略；正式进入策略前还需要交易成本、持仓、调仓和风控规则。

## V2 七因子逻辑

总分权重仍保持不变，只修复 Beta 的内部定义：

`20% 行业趋势 + 20% 个股动量 + 15% 行业Beta + 15% 估值位置 + 15% 盈利修复 + 10% 流动性 + 5% 回撤约束`

Beta 维度改为：

- 主线板块：奖励行业上涨日的个股上行弹性、行业代表性，以及上涨 Beta 高于下跌 Beta。
- 防守板块：奖励相对大盘的低下跌 Beta、低总 Beta、低波动和低大盘相关性。
- 修复板块：奖励最近 60 日相对 120 日的上行 Beta 抬升、下跌 Beta 降低和行业解释度改善。

## 历史 Rank IC

Rank IC 看的是“高分股票未来收益排名是否也靠前”。0 附近表示排序能力弱，长期稳定正数才有继续做策略的价值。

{md_table(ic_summary, ["horizon", "factor", "periods", "mean_rank_ic", "median_rank_ic", "positive_ratio", "ic_ir", "avg_sample_size"], 20)}

## 综合价格代理因子分层收益

按综合价格代理分数分 5 层，Layer 5 是最高分，Layer 1 是最低分。表中并列展示 V1 统一 Beta 与 V2 类型化 Beta。

{md_table(layer_summary, ["horizon", "score_model", "periods", "layer1_low_mean", "layer2_mean", "layer3_mean", "layer4_mean", "layer5_high_mean", "high_minus_low_mean", "high_beats_low_ratio"], 20)}

## TopN 观察组合的前瞻收益

这不是完整回测，只是每个月把分数最高的 N 只股票等权，观察未来 20/60 日平均收益是否超过候选池均值。

{md_table(topn_summary, ["horizon", "score_model", "top_n", "periods", "top_return_mean", "universe_return_mean", "excess_mean", "top_minus_bottom_mean", "excess_positive_ratio"], 20)}

## 当前 V2 全市场候选 Top 50

{md_table(current_top, ["source_group", "sector_name", "stock_code", "stock_name", "multifactor_score_v2", "score_delta_v2_minus_v1", "type_beta_score", "beta_score_method", "1y_return", "6m_return", "3m_return", "20d_return", "1y_from_high", "avg_amount_20d", "quality_flag"], 50)}

## 当前分组 Top 20

{md_table(by_group, ["source_group", "sector_name", "stock_code", "stock_name", "multifactor_score_v2", "score_delta_v2_minus_v1", "type_beta_score", "beta_score_method", "1y_return", "6m_return", "3m_return", "20d_return", "1y_from_high", "avg_amount_20d", "quality_flag"], 60)}

## 当前高分但需警惕

这些不是排除名单，而是说明“原始分高但某些质量约束不舒服”，后续应人工复核。

{md_table(warnings, ["source_group", "sector_name", "stock_code", "stock_name", "multifactor_score_v2", "score_delta_v2_minus_v1", "type_beta_score", "beta_score_method", "1y_return", "6m_return", "3m_return", "20d_return", "1y_from_high", "avg_amount_20d", "quality_flag"], 50)}

## 数据限制

- 候选池来自当前行业/板块观察，不是完整全 A 历史成分池，有幸存者偏差。
- 估值和盈利修复缺少严格点位历史，本次没有把它们纳入历史 IC/分层收益。
- TopN 表只是因子检验，不含真实调仓成本、涨跌停、停牌、容量、冲击成本，不等于正式回测。

## 输出文件

- `historical_factor_panel.csv`：月频历史因子与未来收益标签。
- `rank_ic_by_month.csv` / `rank_ic_summary.csv`：因子 IC 明细与汇总。
- `layer_returns_by_month.csv` / `layer_returns_summary.csv`：综合因子分层收益。
- `topn_forward_returns.csv` / `topn_forward_summary.csv`：TopN 前瞻收益观察。
- `current_v2_top50.csv` / `current_v2_by_group_top20.csv` / `current_v2_warning_top50.csv`：当前七因子观察名单。
- `multifactor_v2_type_beta_validation_outputs.zip`：本次数据包。
"""
    REPORT_PATH.write_text(text, encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    factors, universe, cache_log, current = make_factor_panel()
    ic, layers, topn = validate_factors(factors)
    ic_summary = summarize_ic(ic)
    layer_summary = summarize_layers(layers)
    topn_summary = summarize_topn(topn)
    current_top, by_group, warnings = current_tables(current, factors)

    outputs = {
        "historical_factor_panel.csv": factors,
        "stock_price_cache_log.csv": cache_log,
        "validated_universe.csv": universe,
        "rank_ic_by_month.csv": ic,
        "rank_ic_summary.csv": ic_summary,
        "layer_returns_by_month.csv": layers,
        "layer_returns_summary.csv": layer_summary,
        "topn_forward_returns.csv": topn,
        "topn_forward_summary.csv": topn_summary,
        "current_v2_top50.csv": current_top,
        "current_v2_by_group_top20.csv": by_group,
        "current_v2_warning_top50.csv": warnings,
    }
    for name, df in outputs.items():
        df.to_csv(OUTPUT_DIR / name, index=False)

    write_markdown(ic_summary, layer_summary, topn_summary, current_top, by_group, warnings, universe, cache_log)

    summary = {
        "latest_price_date": END_DATE,
        "validated_candidate_rows": int(len(universe)),
        "validated_unique_stocks": int(universe["stock_code"].nunique()),
        "stock_price_cache_files": int(len(cache_log)),
        "historical_factor_rows": int(len(factors)),
        "rank_ic_rows": int(len(ic)),
        "layer_rows": int(len(layers)),
        "topn_rows": int(len(topn)),
        "limitations": [
            "valuation and earnings factors are current cross-sectional only in this run",
            "candidate universe is based on current selected sectors and has survivorship bias",
            "duplicate stocks can appear in multiple source groups because beta is type-specific",
            "topn_forward_returns is factor validation, not a full cost-aware backtest",
        ],
    }
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    zip_path = OUTPUT_DIR / "multifactor_v2_type_beta_validation_outputs.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(OUTPUT_DIR.glob("*")):
            if path == zip_path:
                continue
            zf.write(path, arcname=path.name)

    print(json.dumps(summary | {"report": str(REPORT_PATH), "zip": str(zip_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Validate a capital-migration factor using cached AKShare price/amount data."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / "lab/backtests/multifactor_v1_supplement"
OUTPUT_DIR = ROOT / "lab/backtests/capital_migration_factor_validation"
SECTOR_BARS = ROOT / "lab/backtests/recent_sector_trend/sw_first_level_daily_bars_latest.csv"
MARKET_INDEX = ROOT / "lab/backtests/stock_momentum_validation/akshare_cache/index_sh000905_20150101_20260717.csv"
REPORT_PATH = OUTPUT_DIR / "capital_migration_factor_validation_report.md"

START_DATE = "2017-01-01"
END_DATE = "2026-07-17"
MIN_AVG_AMOUNT = 20_000_000
MIN_SAMPLE = 80
HORIZONS = {"20d": 20, "60d": 60}


def zcode(value: object) -> str:
    return str(value).split(".")[0].zfill(6)


def pct(value: float | int | None, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value) * 100:.{digits}f}%"


def num(value: float | int | None, digits: int = 3) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value):.{digits}f}"


def percentile_rank(df: pd.DataFrame, ascending: bool = True) -> pd.DataFrame:
    return df.rank(axis=1, pct=True, ascending=ascending)


def month_end_dates(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.Series(index, index=index).groupby(index.to_period("M")).tail(1).values)


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


def load_market_close() -> pd.Series:
    df = pd.read_csv(MARKET_INDEX)
    df["date"] = pd.to_datetime(df["date"])
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df = df[(df["date"] >= START_DATE) & (df["date"] <= END_DATE)].dropna(subset=["date", "close"])
    return df.set_index("date")["close"].sort_index()


def load_inputs() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.Series, pd.DataFrame]:
    current = pd.read_csv(INPUT_DIR / "multifactor_v1_stock_sector_scores.csv", dtype={"stock_code": str, "sector_code": str})
    current["stock_code"] = current["stock_code"].map(zcode)
    current["sector_code"] = current["sector_code"].astype(str)
    candidates = current[["source_group", "sector_name", "sector_code", "stock_code", "stock_name"]].copy()
    candidates = candidates.drop_duplicates(["source_group", "sector_code", "stock_code"]).sort_values(
        ["source_group", "sector_code", "stock_code"]
    )
    unique = candidates.drop_duplicates("stock_code")

    stock_close, stock_amount, cache_log = read_stock_cache(set(unique["stock_code"]))
    candidates = candidates[candidates["stock_code"].isin(stock_close.columns)].copy()
    unique = candidates.drop_duplicates("stock_code")
    stock_close = stock_close.reindex(columns=unique["stock_code"]).ffill(limit=10)
    stock_amount = stock_amount.reindex(index=stock_close.index, columns=stock_close.columns)

    sectors = pd.read_csv(SECTOR_BARS, dtype={"code": str})
    sectors["date"] = pd.to_datetime(sectors["date"])
    sectors["close"] = pd.to_numeric(sectors["close"], errors="coerce")
    sectors["amount"] = pd.to_numeric(sectors["amount"], errors="coerce")
    sectors = sectors[(sectors["date"] >= START_DATE) & (sectors["date"] <= END_DATE)]
    sector_close = sectors.pivot_table(index="date", columns="code", values="close", aggfunc="last").sort_index()
    sector_amount = sectors.pivot_table(index="date", columns="code", values="amount", aggfunc="last").sort_index()

    market_close = load_market_close()
    common_index = stock_close.index.union(sector_close.index).union(market_close.index).sort_values()
    stock_close = stock_close.reindex(common_index).ffill(limit=10)
    stock_amount = stock_amount.reindex(common_index)
    sector_close = sector_close.reindex(common_index).ffill()
    sector_amount = sector_amount.reindex(common_index)
    market_close = market_close.reindex(common_index).ffill()
    return candidates, stock_close, stock_amount, sector_close, market_close, cache_log, sector_amount


def build_factor_panel(
    signal_dates: pd.DatetimeIndex | None = None,
    horizons: dict[str, int] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Build capital-migration rows for monthly defaults or supplied dates."""

    candidates, stock_close, stock_amount, sector_close, market_close, cache_log, sector_amount = load_inputs()

    stock_avg_amount_20 = stock_amount.rolling(20, min_periods=10).mean()
    stock_liq_level = percentile_rank(np.log1p(stock_avg_amount_20))
    stock_liq_delta = stock_liq_level - stock_liq_level.shift(20)

    sector_avg_amount_20 = sector_amount.rolling(20, min_periods=10).mean()
    sector_liq_level = percentile_rank(np.log1p(sector_avg_amount_20))
    sector_liq_delta = sector_liq_level - sector_liq_level.shift(20)

    stock_ret20 = stock_close / stock_close.shift(20) - 1.0
    sector_ret20 = sector_close / sector_close.shift(20) - 1.0
    market_ret20 = market_close / market_close.shift(20) - 1.0

    stock_liq_delta_score = percentile_rank(stock_liq_delta)
    sector_liq_delta_score = percentile_rank(sector_liq_delta)
    stock_ret20_score = percentile_rank(stock_ret20)

    label_horizons = horizons or HORIZONS
    labels = {
        horizon: stock_close.shift(-days) / stock_close - 1.0
        for horizon, days in label_horizons.items()
    }

    rows = []
    if signal_dates is None:
        factor_dates = month_end_dates(stock_close.index)
    else:
        factor_dates = pd.DatetimeIndex(pd.to_datetime(signal_dates)).unique().intersection(stock_close.index).sort_values()
    for date in factor_dates:
        if date < pd.Timestamp("2018-01-01"):
            continue
        for row in candidates.itertuples(index=False):
            code = row.stock_code
            sector_code = row.sector_code
            if code not in stock_close or sector_code not in sector_close:
                continue

            stock_excess_sector = stock_ret20.at[date, code] - sector_ret20.at[date, sector_code]
            sector_excess_market = sector_ret20.at[date, sector_code] - market_ret20.at[date]
            record = {
                "date": date.date().isoformat(),
                "source_group": row.source_group,
                "sector_name": row.sector_name,
                "sector_code": sector_code,
                "stock_code": code,
                "stock_name": row.stock_name,
                "stock_liquidity_level": stock_liq_level.at[date, code],
                "stock_liquidity_delta": stock_liq_delta.at[date, code],
                "stock_liquidity_delta_score": stock_liq_delta_score.at[date, code],
                "sector_liquidity_level": sector_liq_level.at[date, sector_code],
                "sector_liquidity_delta": sector_liq_delta.at[date, sector_code],
                "sector_liquidity_delta_score": sector_liq_delta_score.at[date, sector_code],
                "stock_return_20d": stock_ret20.at[date, code],
                "sector_return_20d": sector_ret20.at[date, sector_code],
                "market_return_20d": market_ret20.at[date],
                "stock_excess_sector_20d": stock_excess_sector,
                "sector_excess_market_20d": sector_excess_market,
                "avg_amount_20d": stock_avg_amount_20.at[date, code],
            }
            record["price_confirm_score"] = np.nan
            record["relative_strength_score"] = np.nan
            for horizon, label_panel in labels.items():
                record[f"future_return_{horizon}"] = label_panel.at[date, code]
            rows.append(record)

    factors = pd.DataFrame(rows)
    factors["price_confirm_score"] = (
        0.50 * factors.groupby("date")["stock_return_20d"].rank(pct=True)
        + 0.50 * factors.groupby("date")["stock_excess_sector_20d"].rank(pct=True)
    )
    factors["relative_strength_score"] = (
        0.60 * factors.groupby("date")["stock_excess_sector_20d"].rank(pct=True)
        + 0.40 * factors.groupby("date")["sector_excess_market_20d"].rank(pct=True)
    )
    ret_pct = factors.groupby("date")["stock_return_20d"].rank(pct=True)
    liq_pct = factors.groupby("date")["stock_liquidity_level"].rank(pct=True)
    factors["overheat_penalty"] = (ret_pct - 0.80).clip(lower=0) + (liq_pct - 0.90).clip(lower=0)
    factors["capital_migration_score"] = (
        0.30 * factors["sector_liquidity_delta_score"]
        + 0.30 * factors["stock_liquidity_delta_score"]
        + 0.20 * factors["price_confirm_score"]
        + 0.15 * factors["relative_strength_score"]
        - 0.05 * factors["overheat_penalty"]
    )
    factors["static_liquidity_score"] = factors["stock_liquidity_level"]
    return factors, candidates, cache_log


def validate(factors: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    factor_cols = [
        "capital_migration_score",
        "stock_liquidity_delta_score",
        "sector_liquidity_delta_score",
        "price_confirm_score",
        "relative_strength_score",
        "static_liquidity_score",
    ]
    score_models = {
        "资金迁移确认因子": "capital_migration_score",
        "静态流动性因子": "static_liquidity_score",
    }
    ic_rows = []
    layer_rows = []
    topn_rows = []
    for horizon in HORIZONS:
        label = f"future_return_{horizon}"
        last_valid_date = factors.loc[factors[label].notna(), "date"].max()
        sample = factors[
            (factors["date"] <= last_valid_date)
            & (factors["avg_amount_20d"] >= MIN_AVG_AMOUNT)
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
            base_return = group[label].mean()
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
                            "universe_return": float(base_return),
                            "top_excess_vs_universe": float(top[label].mean() - base_return),
                            "top_minus_bottom": float(top[label].mean() - bottom[label].mean()),
                        }
                    )
    return pd.DataFrame(ic_rows), pd.DataFrame(layer_rows), pd.DataFrame(topn_rows)


def summarize_ic(ic: pd.DataFrame) -> pd.DataFrame:
    return (
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
        .sort_values(["horizon", "mean_rank_ic"], ascending=[True, False])
    )


def summarize_layers(layers: pd.DataFrame) -> pd.DataFrame:
    pivot = layers.pivot_table(index=["horizon", "score_model", "date"], columns="layer", values="mean_forward_return")
    rows = []
    for (horizon, model), group in pivot.groupby(level=[0, 1]):
        g = group.droplevel([0, 1])
        rows.append(
            {
                "horizon": horizon,
                "score_model": model,
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
    return pd.DataFrame(rows)


def summarize_topn(topn: pd.DataFrame) -> pd.DataFrame:
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


def current_snapshot(factors: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    latest_date = factors["date"].max()
    current = factors[factors["date"] == latest_date].copy()
    cols = [
        "source_group",
        "sector_name",
        "stock_code",
        "stock_name",
        "capital_migration_score",
        "stock_liquidity_delta",
        "sector_liquidity_delta",
        "stock_return_20d",
        "stock_excess_sector_20d",
        "sector_excess_market_20d",
        "avg_amount_20d",
    ]
    top = current.sort_values("capital_migration_score", ascending=False).head(80)[cols]
    sector = (
        current.groupby(["source_group", "sector_name"])
        .agg(
            rows=("stock_code", "count"),
            score_mean=("capital_migration_score", "mean"),
            stock_liq_delta_mean=("stock_liquidity_delta", "mean"),
            sector_liq_delta_mean=("sector_liquidity_delta", "mean"),
            return_20d_mean=("stock_return_20d", "mean"),
            avg_amount_20d_mean=("avg_amount_20d", "mean"),
        )
        .reset_index()
        .sort_values(["source_group", "score_mean"], ascending=[True, False])
    )
    return top, sector


def md_table(df: pd.DataFrame, columns: list[str], rows: int = 20) -> str:
    view = df[columns].head(rows).copy()
    for col in view.columns:
        if "amount" in col:
            if pd.api.types.is_numeric_dtype(view[col]):
                view[col] = view[col].map(lambda x: f"{x / 1e8:.2f}亿" if pd.notna(x) else "-")
        elif col in {"periods", "rows", "top_n", "avg_sample_size"}:
            continue
        elif any(key in col for key in ["return", "delta", "excess", "ratio", "ic", "score"]):
            if pd.api.types.is_numeric_dtype(view[col]):
                view[col] = view[col].map(lambda x: pct(x) if pd.notna(x) else "-")
        elif "mean" in col:
            if pd.api.types.is_numeric_dtype(view[col]):
                view[col] = view[col].map(lambda x: pct(x) if pd.notna(x) else "-")
    return view.to_markdown(index=False) + "\n"


def write_report(
    ic_summary: pd.DataFrame,
    layer_summary: pd.DataFrame,
    topn_summary: pd.DataFrame,
    current_top: pd.DataFrame,
    sector_snapshot: pd.DataFrame,
    candidates: pd.DataFrame,
) -> None:
    cm = ic_summary[ic_summary["factor"] == "capital_migration_score"]
    conclusions = []
    for row in cm.itertuples(index=False):
        conclusions.append(
            f"{row.horizon} 资金迁移确认因子：平均 Rank IC {row.mean_rank_ic:.3f}，正 IC 占比 {row.positive_ratio:.1%}。"
        )
    text = f"""# 资金迁移确认因子验证报告

数据口径：AKShare/本地缓存，最新价格日 `{END_DATE}`；候选池 `{len(candidates)}` 条记录，`{candidates["stock_code"].nunique()}` 只唯一股票。

## 因子定义

`资金迁移分 = 30%板块流动性升温 + 30%个股流动性升温 + 20%价格确认 + 15%相对强弱改善 - 5%过热惩罚`

- 板块流动性升温：行业 20 日均成交额分位相对 20 个交易日前的变化。
- 个股流动性升温：个股 20 日均成交额分位相对 20 个交易日前的变化。
- 价格确认：个股 20 日收益分位和个股相对行业 20 日超额分位。
- 相对强弱改善：个股相对行业超额，以及行业相对中证500超额。
- 过热惩罚：短期涨幅分位和流动性分位过高时扣分。

## 先给结论

{chr(10).join(f"- {item}" for item in conclusions)}
- 相比静态流动性，资金迁移确认因子更符合“资金边际迁移”的直觉，但本次还只是因子验证，不是完整回测。

## Rank IC 汇总

{md_table(ic_summary, ["horizon", "factor", "periods", "mean_rank_ic", "median_rank_ic", "positive_ratio", "ic_ir", "avg_sample_size"], 20)}

## 分层收益

Layer 5 是因子最高组，Layer 1 是因子最低组。

{md_table(layer_summary, ["horizon", "score_model", "periods", "layer1_low_mean", "layer2_mean", "layer3_mean", "layer4_mean", "layer5_high_mean", "high_minus_low_mean", "high_beats_low_ratio"], 20)}

## TopN 前瞻收益

{md_table(topn_summary, ["horizon", "score_model", "top_n", "periods", "top_return_mean", "universe_return_mean", "excess_mean", "top_minus_bottom_mean", "excess_positive_ratio"], 20)}

## 当前资金迁移 Top 80

{md_table(current_top, ["source_group", "sector_name", "stock_code", "stock_name", "capital_migration_score", "stock_liquidity_delta", "sector_liquidity_delta", "stock_return_20d", "stock_excess_sector_20d", "sector_excess_market_20d", "avg_amount_20d"], 80)}

## 当前板块资金迁移概览

{md_table(sector_snapshot, ["source_group", "sector_name", "rows", "score_mean", "stock_liq_delta_mean", "sector_liq_delta_mean", "return_20d_mean", "avg_amount_20d_mean"], 60)}

## 限制

- 候选池仍来自当前主线/修复/防守观察池，有幸存者偏差。
- 这里验证的是因子排序，不含真实交易成本、涨跌停、停牌、冲击成本。
- 因子使用成交额和价格共同确认，不能单独解释为“资金净流入”。
"""
    REPORT_PATH.write_text(text, encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    factors, candidates, cache_log = build_factor_panel()
    ic, layers, topn = validate(factors)
    ic_summary = summarize_ic(ic)
    layer_summary = summarize_layers(layers)
    topn_summary = summarize_topn(topn)
    current_top, sector_snapshot = current_snapshot(factors)

    outputs = {
        "capital_migration_factor_panel.csv": factors,
        "rank_ic_by_month.csv": ic,
        "rank_ic_summary.csv": ic_summary,
        "layer_returns_by_month.csv": layers,
        "layer_returns_summary.csv": layer_summary,
        "topn_forward_returns.csv": topn,
        "topn_forward_summary.csv": topn_summary,
        "current_capital_migration_top80.csv": current_top,
        "current_sector_capital_migration_snapshot.csv": sector_snapshot,
        "validated_candidates.csv": candidates,
        "stock_price_cache_log.csv": cache_log,
    }
    for name, df in outputs.items():
        df.to_csv(OUTPUT_DIR / name, index=False)
    write_report(ic_summary, layer_summary, topn_summary, current_top, sector_snapshot, candidates)

    summary = {
        "latest_price_date": END_DATE,
        "candidate_rows": int(len(candidates)),
        "unique_stocks": int(candidates["stock_code"].nunique()),
        "factor_rows": int(len(factors)),
        "rank_ic_rows": int(len(ic)),
        "layer_rows": int(len(layers)),
        "topn_rows": int(len(topn)),
    }
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    zip_path = OUTPUT_DIR / "capital_migration_factor_validation_outputs.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(OUTPUT_DIR.glob("*")):
            if path == zip_path:
                continue
            zf.write(path, arcname=path.name)
    print(json.dumps(summary | {"report": str(REPORT_PATH), "zip": str(zip_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

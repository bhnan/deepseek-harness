#!/usr/bin/env python3
"""Validate and rank mainline growth candidates for V3.

Historical validation only uses price/amount fields that can be reconstructed
point-in-time. Current fundamentals are used only for the latest cross-section.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / "lab/backtests/multifactor_v1_supplement"
V2_DIR = ROOT / "lab/backtests/multifactor_v2_type_beta_validation"
MIGRATION_DIR = ROOT / "lab/backtests/capital_migration_factor_validation"
OUTPUT_DIR = ROOT / "lab/backtests/mainline_growth_v3_validation"
REPORT_PATH = OUTPUT_DIR / "mainline_growth_v3_validation_report.md"

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


def safe_rank(series: pd.Series, ascending: bool = True) -> pd.Series:
    return series.replace([np.inf, -np.inf], np.nan).rank(pct=True, ascending=ascending)


def sector_neutral_rank(df: pd.DataFrame, column: str, ascending: bool = True) -> pd.Series:
    ranked = df.groupby("sector_name", group_keys=False)[column].transform(lambda s: safe_rank(s, ascending=ascending))
    fallback = safe_rank(df[column], ascending=ascending)
    return ranked.fillna(fallback)


def load_historical_panel() -> pd.DataFrame:
    v2 = pd.read_csv(V2_DIR / "historical_factor_panel.csv", dtype={"stock_code": str, "sector_code": str})
    migration = pd.read_csv(
        MIGRATION_DIR / "capital_migration_factor_panel.csv",
        dtype={"stock_code": str, "sector_code": str},
    )
    for df in [v2, migration]:
        df["stock_code"] = df["stock_code"].map(zcode)
        df["sector_code"] = df["sector_code"].astype(str)
    v2 = v2[v2["source_group"].eq("主线板块")].copy()
    migration = migration[migration["source_group"].eq("主线板块")].copy()
    cols = [
        "date",
        "source_group",
        "sector_code",
        "stock_code",
        "stock_liquidity_delta_score",
        "sector_liquidity_delta_score",
        "price_confirm_score",
        "relative_strength_score",
        "capital_migration_score",
        "overheat_penalty",
        "static_liquidity_score",
    ]
    panel = v2.merge(
        migration[cols],
        on=["date", "source_group", "sector_code", "stock_code"],
        how="left",
        validate="one_to_one",
    )
    panel["mainline_price_proxy_v2"] = panel["price_proxy_score_v2"]
    panel["mainline_growth_price_proxy_v3"] = (
        0.25 * panel["industry_trend_score_hist"]
        + 0.25 * panel["stock_momentum_score_hist"]
        + 0.20 * panel["type_beta_score_hist"]
        + 0.20 * panel["capital_migration_score"]
        + 0.10 * panel["drawdown_score_hist"]
        - 0.05 * panel["overheat_penalty"].fillna(0)
    )
    return panel


def validate_historical(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    factor_cols = [
        "industry_trend_score_hist",
        "stock_momentum_score_hist",
        "type_beta_score_hist",
        "capital_migration_score",
        "drawdown_score_hist",
        "mainline_price_proxy_v2",
        "mainline_growth_price_proxy_v3",
    ]
    score_models = {
        "V2主线价格代理": "mainline_price_proxy_v2",
        "V3主线成长价格资金代理": "mainline_growth_price_proxy_v3",
    }
    ic_rows: list[dict[str, object]] = []
    layer_rows: list[dict[str, object]] = []
    topn_rows: list[dict[str, object]] = []

    for horizon in HORIZONS:
        label = f"future_return_{horizon}"
        last_valid_date = panel.loc[panel[label].notna(), "date"].max()
        sample = panel[
            (panel["date"] <= last_valid_date)
            & (panel["avg_amount_20d_hist"] >= MIN_AVG_AMOUNT)
            & panel[label].notna()
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
    for (horizon, score_model), group in pivot.groupby(level=[0, 1]):
        g = group.droplevel([0, 1])
        rows.append(
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


def build_current_tables(historical: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    current = pd.read_csv(INPUT_DIR / "multifactor_v1_stock_sector_scores.csv", dtype={"stock_code": str, "sector_code": str})
    current = current[current["source_group"].eq("主线板块")].copy()
    current["stock_code"] = current["stock_code"].map(zcode)
    current["sector_code"] = current["sector_code"].astype(str)

    latest = historical[historical["date"].eq(historical["date"].max())][
        [
            "date",
            "stock_code",
            "sector_code",
            "industry_trend_score_hist",
            "stock_momentum_score_hist",
            "type_beta_score_hist",
            "capital_migration_score",
            "stock_liquidity_delta_score",
            "sector_liquidity_delta_score",
            "price_confirm_score",
            "relative_strength_score",
            "overheat_penalty",
        ]
    ].copy()
    current = current.merge(latest, on=["stock_code", "sector_code"], how="left", validate="one_to_one")

    for col in [
        "revenue_yoy_q1",
        "profit_yoy_q1",
        "revenue_qoq_q1",
        "profit_qoq_q1",
        "roe_q1",
        "gross_margin_q1",
        "pe_percentile_3y",
        "ps_percentile_3y",
        "pb_percentile_3y",
        "valuation_cheap_score",
        "earnings_repair_score_raw",
        "market_cap",
        "avg_amount_20d",
        "20d_return",
        "1y_from_high",
    ]:
        current[col] = pd.to_numeric(current[col], errors="coerce")

    current["revenue_growth_score"] = sector_neutral_rank(current, "revenue_yoy_q1")
    current["profit_growth_score"] = sector_neutral_rank(current, "profit_yoy_q1")
    current["growth_acceleration_score"] = (
        0.50 * sector_neutral_rank(current, "revenue_qoq_q1")
        + 0.50 * sector_neutral_rank(current, "profit_qoq_q1")
    )
    current["profitability_quality_score"] = (
        0.55 * sector_neutral_rank(current, "roe_q1")
        + 0.45 * sector_neutral_rank(current, "gross_margin_q1")
    )
    current["growth_quality_score"] = (
        0.30 * current["revenue_growth_score"]
        + 0.30 * current["profit_growth_score"]
        + 0.15 * current["growth_acceleration_score"]
        + 0.15 * current["profitability_quality_score"]
        + 0.10 * current["earnings_repair_score_raw"].clip(0, 1)
    )

    valuation_pressure = current[["pe_percentile_3y", "ps_percentile_3y"]].mean(axis=1)
    current["valuation_headroom_score"] = (1.0 - valuation_pressure).clip(0, 1)
    current["growth_value_spread_score"] = safe_rank(current["growth_quality_score"] - valuation_pressure.fillna(0.5))
    current["valuation_growth_fit_score"] = (
        0.45 * current["growth_value_spread_score"]
        + 0.35 * current["valuation_headroom_score"]
        + 0.20 * current["valuation_cheap_score"].clip(0, 1)
    )

    sector_space = (
        current.groupby(["sector_code", "sector_name"])
        .agg(
            sector_market_cap=("market_cap", "sum"),
            sector_avg_amount_20d=("avg_amount_20d", "sum"),
            sector_revenue_yoy_mean=("revenue_yoy_q1", "mean"),
            sector_profit_yoy_mean=("profit_yoy_q1", "mean"),
            sector_industry_trend_mean=("industry_trend_score_hist", "mean"),
            stocks=("stock_code", "count"),
        )
        .reset_index()
    )
    sector_space["industry_space_score"] = (
        0.30 * safe_rank(sector_space["sector_market_cap"])
        + 0.25 * safe_rank(sector_space["sector_avg_amount_20d"])
        + 0.20 * safe_rank(sector_space["sector_revenue_yoy_mean"])
        + 0.15 * safe_rank(sector_space["sector_profit_yoy_mean"])
        + 0.10 * safe_rank(sector_space["sector_industry_trend_mean"])
    )
    current = current.merge(
        sector_space[
            [
                "sector_code",
                "sector_market_cap",
                "sector_avg_amount_20d",
                "sector_revenue_yoy_mean",
                "sector_profit_yoy_mean",
                "industry_space_score",
            ]
        ],
        on="sector_code",
        how="left",
        validate="many_to_one",
    )

    current["mainline_beta_score"] = current["type_beta_score_hist"].fillna(current["industry_beta_score"])
    current["industry_trend_v3_score"] = current["industry_trend_score_hist"].fillna(current["industry_trend_score"])
    current["stock_momentum_v3_score"] = current["stock_momentum_score_hist"].fillna(current["momentum_score"])
    current["capital_migration_v3_score"] = current["capital_migration_score"].fillna(current["liquidity_score"])
    overheat = current["overheat_penalty"].fillna(0)
    weak_risk = ((current["20d_return"] < -0.08) & (current["1y_from_high"] < -0.25)).astype(float)
    current["risk_penalty"] = (0.08 * overheat + 0.10 * weak_risk).clip(0, 0.20)
    current["mainline_growth_v3_score"] = (
        0.20 * current["industry_trend_v3_score"]
        + 0.15 * current["industry_space_score"]
        + 0.20 * current["growth_quality_score"]
        + 0.15 * current["stock_momentum_v3_score"]
        + 0.10 * current["mainline_beta_score"]
        + 0.10 * current["valuation_growth_fit_score"]
        + 0.10 * current["capital_migration_v3_score"]
        - current["risk_penalty"]
    )
    current["risk_label"] = np.select(
        [
            weak_risk.eq(1),
            current["overheat_penalty"].fillna(0) > 0.10,
            current["avg_amount_20d"] < MIN_AVG_AMOUNT,
            current["valuation_headroom_score"] < 0.15,
        ],
        ["短期转弱且离高点远", "短期过热", "流动性不足", "成长估值偏拥挤"],
        default="观察",
    )

    top_cols = [
        "sector_name",
        "stock_code",
        "stock_name",
        "mainline_growth_v3_score",
        "industry_trend_v3_score",
        "industry_space_score",
        "growth_quality_score",
        "stock_momentum_v3_score",
        "mainline_beta_score",
        "valuation_growth_fit_score",
        "capital_migration_v3_score",
        "risk_penalty",
        "revenue_yoy_q1",
        "profit_yoy_q1",
        "roe_q1",
        "gross_margin_q1",
        "pe_ttm",
        "ps",
        "pe_percentile_3y",
        "ps_percentile_3y",
        "20d_return",
        "6m_return",
        "1y_return",
        "1y_from_high",
        "avg_amount_20d",
        "risk_label",
    ]
    top = current.sort_values("mainline_growth_v3_score", ascending=False).head(80)[top_cols]
    by_sector = current.sort_values("mainline_growth_v3_score", ascending=False).groupby("sector_name").head(10)[top_cols]
    sector_summary = (
        current.groupby("sector_name")
        .agg(
            stocks=("stock_code", "count"),
            score_mean=("mainline_growth_v3_score", "mean"),
            growth_quality_mean=("growth_quality_score", "mean"),
            valuation_growth_fit_mean=("valuation_growth_fit_score", "mean"),
            capital_migration_mean=("capital_migration_v3_score", "mean"),
            trend_mean=("industry_trend_v3_score", "mean"),
            sector_space_mean=("industry_space_score", "mean"),
            revenue_yoy_mean=("revenue_yoy_q1", "mean"),
            profit_yoy_mean=("profit_yoy_q1", "mean"),
            avg_amount_sum=("avg_amount_20d", "sum"),
            market_cap_sum=("market_cap", "sum"),
        )
        .reset_index()
        .sort_values("score_mean", ascending=False)
    )
    return top, by_sector, sector_summary


def md_table(df: pd.DataFrame, columns: list[str], rows: int = 20) -> str:
    if df.empty:
        return "无可用数据。\n"
    view = df[columns].head(rows).copy()
    for col in view.columns:
        if col in {"periods", "top_n", "stocks", "avg_sample_size"}:
            continue
        if "amount" in col or "market_cap" in col:
            if pd.api.types.is_numeric_dtype(view[col]):
                view[col] = view[col].map(lambda x: f"{x / 1e8:.2f}亿" if pd.notna(x) else "-")
        elif any(key in col for key in ["yoy", "qoq", "roe", "margin"]):
            if pd.api.types.is_numeric_dtype(view[col]):
                view[col] = view[col].map(lambda x: f"{float(x):.2f}%" if pd.notna(x) else "-")
        elif col.endswith("_mean") or any(key in col for key in ["return", "ratio", "delta", "excess", "ic", "percentile", "from_high"]):
            if pd.api.types.is_numeric_dtype(view[col]):
                view[col] = view[col].map(lambda x: pct(x) if pd.notna(x) else "-")
        elif "score" in col or "penalty" in col:
            if pd.api.types.is_numeric_dtype(view[col]):
                view[col] = view[col].map(lambda x: pct(x) if pd.notna(x) else "-")
    return view.to_markdown(index=False) + "\n"


def write_report(
    ic_summary: pd.DataFrame,
    layer_summary: pd.DataFrame,
    topn_summary: pd.DataFrame,
    current_top: pd.DataFrame,
    current_by_sector: pd.DataFrame,
    sector_summary: pd.DataFrame,
    historical: pd.DataFrame,
) -> None:
    v3_rows = ic_summary[ic_summary["factor"].eq("mainline_growth_price_proxy_v3")]
    bullets = []
    for row in v3_rows.itertuples(index=False):
        bullets.append(
            f"{row.horizon} V3 主线价格资金代理因子：平均 Rank IC {row.mean_rank_ic:.3f}，正 IC 占比 {row.positive_ratio:.1%}。"
        )
    text = f"""# 主线成长 V3 因子验证报告

数据口径：AKShare/本地缓存，最新价格日 `{END_DATE}`。股票池固定为“主线板块”候选股，共 `{historical["stock_code"].nunique()}` 只唯一股票；当前截面候选来自 `multifactor_v1_supplement`。

## 因子口径

当前主线成长综合分：

`20% 行业趋势 + 15% 行业空间 + 20% 成长质量 + 15% 个股动量 + 10% 主线成长Beta + 10% 估值成长匹配 + 10% 资金迁移确认 - 风险惩罚`

历史验证只验证可回溯的价格/资金代理：

`25% 行业趋势 + 25% 个股动量 + 20% 主线成长Beta + 20% 资金迁移确认 + 10% 回撤位置 - 过热惩罚`

成长质量、估值成长匹配和行业空间当前只做最新截面排序，不做历史 IC，因为当前只有最新财务截面，不能回填到历史月份。

## 先给结论

{chr(10).join(f"- {b}" for b in bullets)}
- 主线成长 V3 相比 V2，核心变化是把“静态流动性”替换为“资金迁移确认”，并在当前截面加入成长质量、行业空间和估值成长匹配。
- 如果历史 IC 不强但当前 TopN 前瞻观察好看，应把它当“筛选器/观察名单”，不能直接当交易策略。
- 当前候选更偏向“行业仍在主线、财务成长质量不差、资金没有明显撤出、估值没有极端透支”的股票。

## 历史 Rank IC

{md_table(ic_summary, ["horizon", "factor", "periods", "mean_rank_ic", "median_rank_ic", "positive_ratio", "ic_ir", "avg_sample_size"], 30)}

## 历史分层收益

Layer 5 是高分组，Layer 1 是低分组。

{md_table(layer_summary, ["horizon", "score_model", "periods", "layer1_low_mean", "layer2_mean", "layer3_mean", "layer4_mean", "layer5_high_mean", "high_minus_low_mean", "high_beats_low_ratio"], 20)}

## TopN 前瞻观察

这不是完整回测，只是月频按分数取 TopN 后观察未来 20/60 日平均收益。

{md_table(topn_summary, ["horizon", "score_model", "top_n", "periods", "top_return_mean", "universe_return_mean", "excess_mean", "top_minus_bottom_mean", "excess_positive_ratio"], 20)}

## 当前主线行业概览

{md_table(sector_summary, ["sector_name", "stocks", "score_mean", "growth_quality_mean", "valuation_growth_fit_mean", "capital_migration_mean", "trend_mean", "sector_space_mean", "revenue_yoy_mean", "profit_yoy_mean", "avg_amount_sum", "market_cap_sum"], 20)}

## 当前主线成长 Top 80

{md_table(current_top, ["sector_name", "stock_code", "stock_name", "mainline_growth_v3_score", "growth_quality_score", "industry_trend_v3_score", "industry_space_score", "stock_momentum_v3_score", "mainline_beta_score", "valuation_growth_fit_score", "capital_migration_v3_score", "risk_penalty", "revenue_yoy_q1", "profit_yoy_q1", "pe_percentile_3y", "ps_percentile_3y", "20d_return", "6m_return", "1y_from_high", "avg_amount_20d", "risk_label"], 80)}

## 当前各主线行业 Top 10

{md_table(current_by_sector, ["sector_name", "stock_code", "stock_name", "mainline_growth_v3_score", "growth_quality_score", "industry_trend_v3_score", "industry_space_score", "stock_momentum_v3_score", "mainline_beta_score", "valuation_growth_fit_score", "capital_migration_v3_score", "risk_penalty", "revenue_yoy_q1", "profit_yoy_q1", "20d_return", "6m_return", "1y_from_high", "risk_label"], 120)}

## 限制

- 这是因子验证和当前排序，不是正式交易回测。
- 股票池使用当前主线候选股，有成分幸存者偏差。
- 成长质量、估值成长匹配和行业空间使用最新财务截面，只能解释当前排序，不能用于历史 IC。
- 现金流、订单、研发等更细的成长因子当前数据还不完整，后续需要补财务报表历史后再升级。
"""
    REPORT_PATH.write_text(text, encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    historical = load_historical_panel()
    ic, layers, topn = validate_historical(historical)
    ic_summary = summarize_ic(ic)
    layer_summary = summarize_layers(layers)
    topn_summary = summarize_topn(topn)
    current_top, current_by_sector, sector_summary = build_current_tables(historical)

    outputs = {
        "historical_mainline_price_factor_panel.csv": historical,
        "rank_ic_by_month.csv": ic,
        "rank_ic_summary.csv": ic_summary,
        "layer_returns_by_month.csv": layers,
        "layer_returns_summary.csv": layer_summary,
        "topn_forward_returns.csv": topn,
        "topn_forward_summary.csv": topn_summary,
        "current_mainline_growth_top80.csv": current_top,
        "current_mainline_growth_by_sector_top10.csv": current_by_sector,
        "current_mainline_sector_summary.csv": sector_summary,
    }
    for filename, df in outputs.items():
        df.to_csv(OUTPUT_DIR / filename, index=False)
    write_report(ic_summary, layer_summary, topn_summary, current_top, current_by_sector, sector_summary, historical)

    summary = {
        "latest_price_date": END_DATE,
        "universe": "source_group == 主线板块",
        "unique_stocks": int(historical["stock_code"].nunique()),
        "historical_factor_rows": int(len(historical)),
        "rank_ic_rows": int(len(ic)),
        "layer_rows": int(len(layers)),
        "topn_rows": int(len(topn)),
        "current_top_rows": int(len(current_top)),
        "limitations": [
            "growth, valuation-growth fit, and industry-space factors are latest cross-section only",
            "historical validation only uses reconstructable price/amount proxy factors",
            "factor validation is not a cost-aware trading backtest",
        ],
    }
    (OUTPUT_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    zip_path = OUTPUT_DIR / "mainline_growth_v3_validation_outputs.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(OUTPUT_DIR.glob("*")):
            if path == zip_path:
                continue
            zf.write(path, arcname=path.name)
    print(json.dumps(summary | {"report": str(REPORT_PATH), "zip": str(zip_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Build current type-specific factor pools and candidate grades.

This is not a trading backtest. It turns the agreed framework into a current
cross-section artifact: each stock is scored only inside its type pool, with
hard filters applied before A/B/C grading.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
BASE_DIR = ROOT / "lab/backtests/multifactor_v1_supplement"
V2_DIR = ROOT / "lab/backtests/multifactor_v2_type_beta_validation"
MIGRATION_DIR = ROOT / "lab/backtests/capital_migration_factor_validation"
OUTPUT_DIR = ROOT / "lab/backtests/type_factor_pools_v1"
REPORT_PATH = OUTPUT_DIR / "type_factor_pools_v1_report.md"

MIN_AVG_AMOUNT = 20_000_000

POOL_SECTORS: dict[str, list[str]] = {
    "主线成长": ["电子", "通信", "机械设备", "电力设备"],
    "周期": ["基础化工", "有色金属", "建筑材料", "石油石化", "煤炭"],
    "防守": ["银行", "煤炭", "食品饮料", "医药生物", "家用电器", "交通运输", "公用事业", "石油石化"],
    "修复": ["医药生物", "农林牧渔", "非银金融", "食品饮料", "美容护理", "银行", "商贸零售", "家用电器", "交通运输"],
    "金融": ["银行", "非银金融"],
}
POOL_ORDER = {pool_type: idx for idx, pool_type in enumerate(POOL_SECTORS)}
GRADE_ORDER = {"A": 0, "B": 1, "C": 2, "剔除": 3}

PREFERRED_SOURCE: dict[str, list[str]] = {
    "主线成长": ["主线板块", "修复板块", "防守板块"],
    "周期": ["主线板块", "防守板块", "修复板块"],
    "防守": ["防守板块", "修复板块", "主线板块"],
    "修复": ["修复板块", "防守板块", "主线板块"],
    "金融": ["修复板块", "防守板块", "主线板块"],
}


def zcode(value: object) -> str:
    return str(value).split(".")[0].zfill(6)


def pct(value: object, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value) * 100:.{digits}f}%"


def num(value: object, digits: int = 3) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value):.{digits}f}"


def amount_yi(value: object, digits: int = 2) -> str:
    if value is None or pd.isna(value):
        return "-"
    return f"{float(value) / 100_000_000:.{digits}f}"


def safe_rank(series: pd.Series, ascending: bool = True) -> pd.Series:
    clean = pd.to_numeric(series, errors="coerce").replace([np.inf, -np.inf], np.nan)
    ranked = clean.rank(pct=True, ascending=ascending)
    return ranked.fillna(0.5)


def mean_score(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    if not cols:
        return pd.Series(0.5, index=df.index)
    return df[cols].mean(axis=1, skipna=True).fillna(0.5).clip(0, 1)


def load_base() -> pd.DataFrame:
    base = pd.read_csv(
        BASE_DIR / "multifactor_v1_stock_sector_scores.csv",
        dtype={"stock_code": str, "sector_code": str},
    )
    base["stock_code"] = base["stock_code"].map(zcode)
    base["sector_code"] = base["sector_code"].astype(str)

    for col in base.columns:
        if col in {"stock_code", "stock_name", "sector_code", "sector_name", "source_group", "symbol", "stock_state", "sector_trend_class", "beta_status", "valuation_date", "stock_name_fin", "q1_report_date", "reported_industry", "beta_label", "valuation_label", "earnings_label", "include_date", "latest_date"}:
            continue
        base[col] = pd.to_numeric(base[col], errors="coerce")
    return base


def load_aux(all_dates: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    v2 = pd.read_csv(
        V2_DIR / "historical_factor_panel.csv",
        dtype={"stock_code": str, "sector_code": str},
    )
    migration = pd.read_csv(
        MIGRATION_DIR / "capital_migration_factor_panel.csv",
        dtype={"stock_code": str, "sector_code": str},
    )
    for frame in [v2, migration]:
        frame["stock_code"] = frame["stock_code"].map(zcode)
        frame["sector_code"] = frame["sector_code"].astype(str)
    if not all_dates:
        v2 = v2[v2["date"].eq(v2["date"].max())].copy()
        migration = migration[migration["date"].eq(migration["date"].max())].copy()
    return v2, migration


def attach_aux(base: pd.DataFrame) -> pd.DataFrame:
    v2, migration = load_aux(all_dates=False)
    v2_cols = [
        "source_group",
        "sector_code",
        "stock_code",
        "beta_score_method",
        "industry_trend_score_hist",
        "stock_momentum_score_hist",
        "type_beta_score_hist",
        "drawdown_score_hist",
        "sector_beta120_hist",
        "sector_up_beta120_hist",
        "sector_down_beta120_hist",
        "market_beta120_hist",
        "market_down_beta120_hist",
    ]
    migration_cols = [
        "source_group",
        "sector_code",
        "stock_code",
        "stock_liquidity_delta_score",
        "sector_liquidity_delta_score",
        "price_confirm_score",
        "relative_strength_score",
        "overheat_penalty",
        "capital_migration_score",
        "static_liquidity_score",
    ]
    merged = base.merge(
        v2[v2_cols],
        on=["source_group", "sector_code", "stock_code"],
        how="left",
        validate="many_to_one",
    )
    merged = merged.merge(
        migration[migration_cols],
        on=["source_group", "sector_code", "stock_code"],
        how="left",
        validate="many_to_one",
    )
    return merged


def pick_pool_rows(base: pd.DataFrame, pool_type: str) -> pd.DataFrame:
    sectors = POOL_SECTORS[pool_type]
    pool = base[base["sector_name"].isin(sectors)].copy()
    if pool.empty:
        return pool
    priority = {name: idx for idx, name in enumerate(PREFERRED_SOURCE[pool_type])}
    pool["_source_priority"] = pool["source_group"].map(priority).fillna(99)
    pool = (
        pool.sort_values(["stock_code", "_source_priority", "avg_amount_20d"], ascending=[True, True, False])
        .drop_duplicates("stock_code", keep="first")
        .drop(columns="_source_priority")
    )
    pool.insert(0, "pool_type", pool_type)
    return pool


def prepare_common_scores(pool: pd.DataFrame) -> pd.DataFrame:
    p = pool.copy()
    p["trend_score_x"] = p["industry_trend_score_hist"].fillna(p["industry_trend_score"]).fillna(0.5).clip(0, 1)
    p["stock_momentum_score_x"] = (
        0.35 * p["stock_momentum_score_hist"].fillna(p["momentum_score"]).fillna(0.5)
        + 0.25 * safe_rank(p["6m_return"])
        + 0.25 * safe_rank(p["3m_return"])
        + 0.15 * safe_rank(p["20d_return"])
    ).clip(0, 1)
    p["drawdown_score_x"] = p["drawdown_score_hist"].fillna(p["drawdown_score"]).fillna(0.5).clip(0, 1)
    p["capital_migration_score_x"] = p["capital_migration_score"].fillna(p["liquidity_score"]).fillna(0.5).clip(0, 1)
    p["type_beta_score_x"] = p["type_beta_score_hist"].fillna(p["industry_beta_score"]).fillna(0.5).clip(0, 1)
    p["valuation_cheap_score_x"] = p["valuation_cheap_score"].fillna(0.5).clip(0, 1)
    p["valuation_pressure_x"] = mean_score(p, ["pe_percentile_3y", "pb_percentile_3y", "ps_percentile_3y"])
    p["valuation_headroom_score_x"] = (1 - p["valuation_pressure_x"]).clip(0, 1)
    p["growth_quality_score_x"] = (
        0.25 * safe_rank(p["revenue_yoy_q1"])
        + 0.25 * safe_rank(p["profit_yoy_q1"])
        + 0.15 * safe_rank(p["revenue_qoq_q1"])
        + 0.15 * safe_rank(p["profit_qoq_q1"])
        + 0.10 * safe_rank(p["roe_q1"])
        + 0.10 * safe_rank(p["gross_margin_q1"])
    ).clip(0, 1)
    p["earnings_repair_score_x"] = p["earnings_repair_score_raw"].fillna(p["earnings_score"]).fillna(0.5).clip(0, 1)
    p["liquidity_delta_score_x"] = mean_score(p, ["stock_liquidity_delta_score", "sector_liquidity_delta_score"])
    p["price_confirm_score_x"] = mean_score(p, ["price_confirm_score", "relative_strength_score"])
    p["low_beta_score_x"] = safe_rank(p["beta120_beta"], ascending=False)
    p["downside_beta_control_score_x"] = safe_rank(p["beta120_down_beta"], ascending=False)
    p["roe_score_x"] = safe_rank(p["roe_q1"])
    p["short_repair_score_x"] = (
        0.45 * safe_rank(p["20d_return"])
        + 0.35 * safe_rank(p["3m_return"])
        + 0.20 * safe_rank(p["1y_from_high"], ascending=False)
    ).clip(0, 1)
    p["cycle_price_score_x"] = (
        0.35 * safe_rank(p["6m_return"])
        + 0.35 * safe_rank(p["3m_return"])
        + 0.30 * safe_rank(p["20d_return"])
    ).clip(0, 1)
    p["sector_space_score_x"] = (
        0.45 * safe_rank(p.groupby("sector_name")["market_cap"].transform("sum"))
        + 0.35 * safe_rank(p.groupby("sector_name")["avg_amount_20d"].transform("sum"))
        + 0.20 * safe_rank(p.groupby("sector_name")["revenue_yoy_q1"].transform("mean"))
    ).clip(0, 1)
    overheat_fallback = pd.Series(
        np.where((p["20d_return"] > 0.18) | (p["20d_from_high"] > -0.02), 0.5, 0.0),
        index=p.index,
    )
    p["overheat_penalty_x"] = p["overheat_penalty"].fillna(overheat_fallback).clip(0, 1)
    return p


def hard_filter_reason(row: pd.Series) -> str:
    reasons: list[str] = []
    name = str(row.get("stock_name", ""))
    if "ST" in name.upper() or "退" in name:
        reasons.append("ST/退市风险")
    if pd.isna(row.get("latest_close")):
        reasons.append("无最新价格")
    if pd.isna(row.get("avg_amount_20d")) or float(row.get("avg_amount_20d", 0)) < MIN_AVG_AMOUNT:
        reasons.append("20日成交额不足")
    if row.get("rows", 0) < 120:
        reasons.append("价格样本不足")
    return "；".join(reasons)


def risk_labels(row: pd.Series) -> str:
    labels: list[str] = []
    if row["valuation_pressure_x"] >= 0.85:
        labels.append("估值拥挤")
    if row["overheat_penalty_x"] >= 0.4:
        labels.append("短期过热")
    if row.get("20d_return", 0) < -0.08 and row.get("1y_from_high", 0) < -0.25:
        labels.append("短期转弱且离高点远")
    if row["capital_migration_score_x"] <= 0.25:
        labels.append("资金迁移偏弱")
    if row["drawdown_score_x"] <= 0.25:
        labels.append("回撤约束偏弱")
    return "，".join(labels) if labels else "观察"


def score_pool(pool: pd.DataFrame) -> pd.DataFrame:
    p = prepare_common_scores(pool)
    pool_type = str(p["pool_type"].iloc[0])

    if pool_type == "主线成长":
        p["main_factor_score"] = (
            0.25 * p["trend_score_x"]
            + 0.20 * p["sector_space_score_x"]
            + 0.25 * p["growth_quality_score_x"]
            + 0.20 * p["stock_momentum_score_x"]
            + 0.10 * p["valuation_headroom_score_x"]
        )
        p["confirmation_score"] = (
            0.45 * p["capital_migration_score_x"] + 0.35 * p["type_beta_score_x"] + 0.20 * p["price_confirm_score_x"]
        )
        p["risk_control_score"] = (
            0.45 * p["valuation_headroom_score_x"] + 0.35 * p["drawdown_score_x"] + 0.20 * (1 - p["overheat_penalty_x"])
        )
    elif pool_type == "周期":
        p["main_factor_score"] = (
            0.30 * p["trend_score_x"]
            + 0.30 * p["cycle_price_score_x"]
            + 0.20 * p["type_beta_score_x"]
            + 0.20 * p["earnings_repair_score_x"]
        )
        p["confirmation_score"] = (
            0.50 * p["capital_migration_score_x"] + 0.30 * p["price_confirm_score_x"] + 0.20 * p["liquidity_delta_score_x"]
        )
        p["risk_control_score"] = (
            0.35 * p["valuation_cheap_score_x"] + 0.35 * p["drawdown_score_x"] + 0.30 * (1 - p["overheat_penalty_x"])
        )
    elif pool_type == "防守":
        p["main_factor_score"] = (
            0.35 * p["defense_score"].fillna(0.5)
            + 0.25 * p["downside_beta_control_score_x"]
            + 0.20 * p["drawdown_score_x"]
            + 0.20 * p["valuation_cheap_score_x"]
        )
        p["confirmation_score"] = (
            0.40 * p["capital_migration_score_x"] + 0.35 * p["liquidity_delta_score_x"] + 0.25 * p["roe_score_x"]
        )
        p["risk_control_score"] = (
            0.45 * p["drawdown_score_x"] + 0.35 * p["low_beta_score_x"] + 0.20 * p["valuation_cheap_score_x"]
        )
    elif pool_type == "修复":
        p["main_factor_score"] = (
            0.30 * p["repair_leader_score"].fillna(0.5)
            + 0.25 * p["earnings_repair_score_x"]
            + 0.25 * p["short_repair_score_x"]
            + 0.20 * p["valuation_cheap_score_x"]
        )
        p["confirmation_score"] = (
            0.45 * p["capital_migration_score_x"] + 0.35 * p["liquidity_delta_score_x"] + 0.20 * p["price_confirm_score_x"]
        )
        p["risk_control_score"] = (
            0.40 * p["drawdown_score_x"] + 0.35 * p["valuation_cheap_score_x"] + 0.25 * (1 - p["overheat_penalty_x"])
        )
    elif pool_type == "金融":
        p["main_factor_score"] = (
            0.30 * p["valuation_cheap_score_x"]
            + 0.25 * p["roe_score_x"]
            + 0.20 * p["stock_momentum_score_x"]
            + 0.15 * p["downside_beta_control_score_x"]
            + 0.10 * p["trend_score_x"]
        )
        p["confirmation_score"] = (
            0.45 * p["capital_migration_score_x"] + 0.35 * p["liquidity_delta_score_x"] + 0.20 * p["price_confirm_score_x"]
        )
        p["risk_control_score"] = (
            0.40 * p["drawdown_score_x"] + 0.35 * p["valuation_cheap_score_x"] + 0.25 * p["low_beta_score_x"]
        )
    else:
        raise ValueError(f"Unknown pool type: {pool_type}")

    p["type_score"] = (
        0.70 * p["main_factor_score"] + 0.20 * p["confirmation_score"] + 0.10 * p["risk_control_score"]
    ).clip(0, 1)
    p["hard_filter_reason"] = p.apply(hard_filter_reason, axis=1)
    p["risk_labels"] = p.apply(risk_labels, axis=1)

    eligible = p["hard_filter_reason"].eq("")
    p["score_percentile_in_pool"] = np.nan
    p.loc[eligible, "score_percentile_in_pool"] = p.loc[eligible, "type_score"].rank(pct=True)
    p["grade"] = "剔除"
    p.loc[eligible & (p["score_percentile_in_pool"] >= 0.80), "grade"] = "A"
    p.loc[eligible & (p["score_percentile_in_pool"] < 0.80) & (p["score_percentile_in_pool"] >= 0.40), "grade"] = "B"
    p.loc[eligible & (p["score_percentile_in_pool"] < 0.40), "grade"] = "C"
    return p.sort_values(["grade", "type_score"], ascending=[True, False])


def md_table(df: pd.DataFrame, columns: list[str], rows: int | None = None) -> str:
    if rows is not None:
        df = df.head(rows)
    if df.empty:
        return "_无数据_"
    out = df[columns].copy()
    percent_cols = [
        c
        for c in out.columns
        if c.endswith("_return")
        or "return" in c
        or "excess" in c
        or "minus_c" in c
        or c.endswith("_ratio")
        or c.endswith("_drawdown")
        or c.endswith("_from_high")
        or c.endswith("_q1")
        or c.endswith("_percentile_3y")
        or c
        in {
            "score_percentile_in_pool",
            "mean_rank_ic",
            "median_rank_ic",
            "positive_ratio",
            "ic_ir",
            "layer1_low_mean",
            "layer5_high_mean",
            "high_minus_low_mean",
            "high_beats_low_ratio",
            "top_return_mean",
            "universe_return_mean",
            "excess_mean",
            "top_minus_bottom_mean",
            "excess_positive_ratio",
        }
    ]
    score_cols = [
        c
        for c in out.columns
        if c.endswith("_score")
        or c
        in {
            "type_score",
            "main_factor_score",
            "confirmation_score",
            "risk_control_score",
            "score_mean",
            "score_max",
            "score_min",
            "main_factor_mean",
            "confirmation_mean",
            "risk_control_mean",
            "momentum_mean",
            "capital_migration_mean",
            "valuation_mean",
        }
    ]
    amount_cols = [c for c in out.columns if c in {"avg_amount_20d", "market_cap"}]
    for col in percent_cols:
        out[col] = out[col].map(pct)
    for col in score_cols:
        out[col] = out[col].map(num)
    for col in amount_cols:
        out[col] = out[col].map(amount_yi)
    return out.to_markdown(index=False)


def summarize(scored: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    pool_summary = (
        scored.groupby("pool_type")
        .agg(
            stocks=("stock_code", "nunique"),
            eligible=("hard_filter_reason", lambda x: int(x.eq("").sum())),
            removed=("hard_filter_reason", lambda x: int(x.ne("").sum())),
            a_count=("grade", lambda x: int((x == "A").sum())),
            b_count=("grade", lambda x: int((x == "B").sum())),
            c_count=("grade", lambda x: int((x == "C").sum())),
            score_mean=("type_score", "mean"),
            main_factor_mean=("main_factor_score", "mean"),
            confirmation_mean=("confirmation_score", "mean"),
            risk_control_mean=("risk_control_score", "mean"),
        )
        .reset_index()
        .sort_values("score_mean", ascending=False)
    )
    sector_summary = (
        scored[scored["hard_filter_reason"].eq("")]
        .groupby(["pool_type", "sector_name"])
        .agg(
            stocks=("stock_code", "nunique"),
            a_count=("grade", lambda x: int((x == "A").sum())),
            score_mean=("type_score", "mean"),
            momentum_mean=("stock_momentum_score_x", "mean"),
            capital_migration_mean=("capital_migration_score_x", "mean"),
            valuation_mean=("valuation_cheap_score_x", "mean"),
        )
        .reset_index()
        .sort_values(["pool_type", "score_mean"], ascending=[True, False])
    )
    top = scored[scored["grade"].eq("A")].sort_values(["pool_type", "type_score"], ascending=[True, False])
    return pool_summary, sector_summary, top


def build_sector_grade_summary(scored: pd.DataFrame) -> pd.DataFrame:
    summary = (
        scored.groupby(["pool_type", "sector_name"])
        .agg(
            stocks=("stock_code", "nunique"),
            eligible=("hard_filter_reason", lambda x: int(x.eq("").sum())),
            removed=("hard_filter_reason", lambda x: int(x.ne("").sum())),
            a_count=("grade", lambda x: int((x == "A").sum())),
            b_count=("grade", lambda x: int((x == "B").sum())),
            c_count=("grade", lambda x: int((x == "C").sum())),
            score_mean=("type_score", "mean"),
            score_max=("type_score", "max"),
            score_min=("type_score", "min"),
            main_factor_mean=("main_factor_score", "mean"),
            confirmation_mean=("confirmation_score", "mean"),
            risk_control_mean=("risk_control_score", "mean"),
        )
        .reset_index()
    )
    summary["_pool_order"] = summary["pool_type"].map(POOL_ORDER)
    return summary.sort_values(["_pool_order", "score_mean"], ascending=[True, False]).drop(columns="_pool_order")


def build_sector_grade_details(scored: pd.DataFrame) -> pd.DataFrame:
    detail_cols = [
        "pool_type",
        "sector_name",
        "grade",
        "stock_code",
        "stock_name",
        "type_score",
        "score_percentile_in_pool",
        "main_factor_score",
        "confirmation_score",
        "risk_control_score",
        "20d_return",
        "3m_return",
        "6m_return",
        "1y_return",
        "avg_amount_20d",
        "risk_labels",
        "hard_filter_reason",
    ]
    detail = scored[detail_cols].copy()
    detail["_pool_order"] = detail["pool_type"].map(POOL_ORDER)
    detail["_grade_order"] = detail["grade"].map(GRADE_ORDER).fillna(99)
    return detail.sort_values(
        ["_pool_order", "sector_name", "_grade_order", "type_score"],
        ascending=[True, True, True, False],
    ).drop(columns=["_pool_order", "_grade_order"])


def build_sector_grade_markdown(scored: pd.DataFrame) -> str:
    detail = build_sector_grade_details(scored)
    lines: list[str] = []
    table_cols = [
        "stock_code",
        "stock_name",
        "type_score",
        "score_percentile_in_pool",
        "main_factor_score",
        "confirmation_score",
        "risk_control_score",
        "20d_return",
        "3m_return",
        "6m_return",
        "1y_return",
        "avg_amount_20d",
        "risk_labels",
    ]
    removed_cols = table_cols + ["hard_filter_reason"]

    for pool_type in POOL_SECTORS:
        pool = detail[detail["pool_type"].eq(pool_type)]
        if pool.empty:
            continue
        lines.append(f"### {pool_type}")
        sector_order = (
            pool.groupby("sector_name")["type_score"]
            .mean()
            .sort_values(ascending=False)
            .index.tolist()
        )
        for sector_name in sector_order:
            sector = pool[pool["sector_name"].eq(sector_name)]
            counts = sector["grade"].value_counts()
            lines.append(
                f"#### {sector_name}：共 {sector['stock_code'].nunique()} 只，"
                f"A {int(counts.get('A', 0))} / B {int(counts.get('B', 0))} / "
                f"C {int(counts.get('C', 0))} / 剔除 {int(counts.get('剔除', 0))}，"
                f"均分 {num(sector['type_score'].mean())}"
            )
            for grade in ["A", "B", "C", "剔除"]:
                grade_rows = sector[sector["grade"].eq(grade)].copy()
                if grade_rows.empty:
                    continue
                lines.append(f"##### {grade}")
                cols = removed_cols if grade == "剔除" else table_cols
                lines.append(md_table(grade_rows[cols], cols))
    return "\n\n".join(lines)


def display_sector_grade_summary(summary: pd.DataFrame) -> pd.DataFrame:
    out = summary.copy()
    return out.rename(
        columns={
            "pool_type": "类型池",
            "sector_name": "板块",
            "stocks": "股票数",
            "eligible": "有效样本",
            "removed": "剔除样本",
            "a_count": "A数量",
            "b_count": "B数量",
            "c_count": "C数量",
            "score_mean": "综合均分",
            "score_max": "最高分",
            "score_min": "最低分",
            "main_factor_mean": "主因子均分",
            "confirmation_mean": "确认因子均分",
            "risk_control_mean": "风险控制均分",
        }
    )


def display_sector_grade_details(details: pd.DataFrame) -> pd.DataFrame:
    out = details.copy()
    out["avg_amount_20d_yi"] = out["avg_amount_20d"] / 100_000_000
    out = out[
        [
            "pool_type",
            "sector_name",
            "grade",
            "stock_code",
            "stock_name",
            "type_score",
            "score_percentile_in_pool",
            "main_factor_score",
            "confirmation_score",
            "risk_control_score",
            "20d_return",
            "3m_return",
            "6m_return",
            "1y_return",
            "avg_amount_20d_yi",
            "risk_labels",
            "hard_filter_reason",
        ]
    ]
    return out.rename(
        columns={
            "pool_type": "类型池",
            "sector_name": "板块",
            "grade": "评级",
            "stock_code": "股票代码",
            "stock_name": "股票名称",
            "type_score": "综合分",
            "score_percentile_in_pool": "池内分位",
            "main_factor_score": "主因子分",
            "confirmation_score": "确认因子分",
            "risk_control_score": "风险控制分",
            "20d_return": "20日涨跌",
            "3m_return": "3月涨跌",
            "6m_return": "6月涨跌",
            "1y_return": "1年涨跌",
            "avg_amount_20d_yi": "20日成交额(亿)",
            "risk_labels": "风险标签",
            "hard_filter_reason": "剔除原因",
        }
    )


def write_excel_workbook(
    pool_summary: pd.DataFrame,
    sector_grade_summary: pd.DataFrame,
    sector_grade_details: pd.DataFrame,
    type_accuracy_summary: pd.DataFrame,
    sector_accuracy_summary: pd.DataFrame,
    time_stability_summary: pd.DataFrame,
    recommendation_observations: pd.DataFrame,
    ic_summary: pd.DataFrame,
    layer_summary: pd.DataFrame,
    topn_summary: pd.DataFrame,
) -> Path:
    xlsx_path = OUTPUT_DIR / "type_factor_sector_grade_workbook.xlsx"
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        pool_summary.to_excel(writer, sheet_name="类型池汇总", index=False)
        display_sector_grade_summary(sector_grade_summary).to_excel(writer, sheet_name="板块评级汇总", index=False)
        formula_matrix().to_excel(writer, sheet_name="因子矩阵", index=False)
        for pool_type in POOL_SECTORS:
            pool_rows = sector_grade_details[sector_grade_details["pool_type"].eq(pool_type)]
            display_sector_grade_details(pool_rows).to_excel(writer, sheet_name=pool_type, index=False)
        type_accuracy_summary.to_excel(writer, sheet_name="推荐准确性", index=False)
        sector_accuracy_summary.to_excel(writer, sheet_name="板块内准确性", index=False)
        time_stability_summary.to_excel(writer, sheet_name="时间稳定性", index=False)
        recommendation_observations.to_excel(writer, sheet_name="推荐验证明细", index=False)
        ic_summary.to_excel(writer, sheet_name="历史IC", index=False)
        layer_summary.to_excel(writer, sheet_name="历史分层", index=False)
        topn_summary.to_excel(writer, sheet_name="历史TopN", index=False)

        for worksheet in writer.book.worksheets:
            worksheet.freeze_panes = "A2"
            worksheet.auto_filter.ref = worksheet.dimensions
            for column_cells in worksheet.columns:
                values = [cell.value for cell in column_cells if cell.value is not None]
                if not values:
                    continue
                width = min(max(len(str(value)) for value in values) + 2, 32)
                worksheet.column_dimensions[column_cells[0].column_letter].width = width
    return xlsx_path


def select_preferred_history_rows(frame: pd.DataFrame, pool_type: str) -> pd.DataFrame:
    history = frame[frame["sector_name"].isin(POOL_SECTORS[pool_type])].copy()
    if history.empty:
        return history
    priority = {name: idx for idx, name in enumerate(PREFERRED_SOURCE[pool_type])}
    history["_source_priority"] = history["source_group"].map(priority).fillna(99)
    return (
        history.sort_values(["date", "stock_code", "_source_priority"], ascending=[True, True, True])
        .drop_duplicates(["date", "stock_code"], keep="first")
        .drop(columns="_source_priority")
    )


def historical_proxy_scores(history: pd.DataFrame, pool_type: str) -> pd.DataFrame:
    h = history.copy()
    h["trend_score_h"] = h["industry_trend_score_hist"].fillna(0.5).clip(0, 1)
    h["momentum_score_h"] = h["stock_momentum_score_hist"].fillna(0.5).clip(0, 1)
    h["beta_score_h"] = h["type_beta_score_hist"].fillna(h["industry_beta_score_hist"]).fillna(0.5).clip(0, 1)
    h["drawdown_score_h"] = h["drawdown_score_hist"].fillna(0.5).clip(0, 1)
    h["capital_score_h"] = h["capital_migration_score"].fillna(h["liquidity_score_hist"]).fillna(0.5).clip(0, 1)
    h["liquidity_delta_score_h"] = mean_score(h, ["stock_liquidity_delta_score", "sector_liquidity_delta_score"])
    h["price_confirm_score_h"] = mean_score(h, ["price_confirm_score", "relative_strength_score"])
    h["low_market_beta_score_h"] = h.groupby("date", group_keys=False)["market_beta120_hist"].transform(
        lambda s: safe_rank(s, ascending=False)
    )
    h["low_down_beta_score_h"] = h.groupby("date", group_keys=False)["market_down_beta120_hist"].transform(
        lambda s: safe_rank(s, ascending=False)
    )
    h["overheat_penalty_h"] = h["overheat_penalty"].fillna(0).clip(0, 1)

    if pool_type == "主线成长":
        h["historical_proxy_score"] = (
            0.25 * h["trend_score_h"]
            + 0.25 * h["momentum_score_h"]
            + 0.20 * h["beta_score_h"]
            + 0.20 * h["capital_score_h"]
            + 0.10 * h["drawdown_score_h"]
            - 0.05 * h["overheat_penalty_h"]
        )
    elif pool_type == "周期":
        h["historical_proxy_score"] = (
            0.30 * h["trend_score_h"]
            + 0.30 * h["momentum_score_h"]
            + 0.20 * h["beta_score_h"]
            + 0.10 * h["capital_score_h"]
            + 0.10 * h["drawdown_score_h"]
            - 0.05 * h["overheat_penalty_h"]
        )
    elif pool_type == "防守":
        h["historical_proxy_score"] = (
            0.25 * h["low_down_beta_score_h"]
            + 0.25 * h["drawdown_score_h"]
            + 0.20 * h["low_market_beta_score_h"]
            + 0.20 * h["capital_score_h"]
            + 0.10 * h["price_confirm_score_h"]
        )
    elif pool_type == "修复":
        h["historical_proxy_score"] = (
            0.30 * h["momentum_score_h"]
            + 0.25 * h["capital_score_h"]
            + 0.20 * h["liquidity_delta_score_h"]
            + 0.15 * h["price_confirm_score_h"]
            + 0.10 * h["drawdown_score_h"]
            - 0.05 * h["overheat_penalty_h"]
        )
    elif pool_type == "金融":
        h["historical_proxy_score"] = (
            0.25 * h["low_down_beta_score_h"]
            + 0.25 * h["capital_score_h"]
            + 0.20 * h["trend_score_h"]
            + 0.15 * h["momentum_score_h"]
            + 0.15 * h["drawdown_score_h"]
        )
    else:
        raise ValueError(f"Unknown pool type: {pool_type}")
    h["historical_proxy_score"] = h["historical_proxy_score"].clip(0, 1)
    h.insert(0, "pool_type", pool_type)
    return h


def assign_historical_grades(
    panel: pd.DataFrame,
    group_cols: list[str],
    min_group_size: int,
    grade_col: str,
    percentile_col: str,
) -> pd.DataFrame:
    """Replay the current A/B/C thresholds on one historical cross-section."""

    scored = panel.copy()
    score = pd.to_numeric(scored["historical_proxy_score"], errors="coerce")
    group_size = scored.assign(_score=score).groupby(group_cols)["_score"].transform("count")
    valid = score.notna() & group_size.ge(min_group_size)

    scored[percentile_col] = np.nan
    ranked = scored.loc[valid].groupby(group_cols)["historical_proxy_score"].rank(pct=True)
    scored.loc[ranked.index, percentile_col] = ranked

    scored[grade_col] = "无效"
    scored.loc[valid & scored[percentile_col].ge(0.80), grade_col] = "A"
    scored.loc[
        valid & scored[percentile_col].ge(0.40) & scored[percentile_col].lt(0.80),
        grade_col,
    ] = "B"
    scored.loc[valid & scored[percentile_col].lt(0.40), grade_col] = "C"
    return scored


def build_accuracy_snapshots(
    graded: pd.DataFrame,
    horizon: str,
    grade_col: str,
    scope: str,
    group_cols: list[str],
) -> pd.DataFrame:
    """Calculate one A/B/C recommendation result for every decision-date group."""

    label = f"future_return_{horizon}"
    valid = graded[graded[grade_col].isin(["A", "B", "C"]) & graded[label].notna()].copy()
    rows: list[dict[str, object]] = []
    for _, group in valid.groupby(group_cols):
        a = group[group[grade_col].eq("A")]
        b = group[group[grade_col].eq("B")]
        c = group[group[grade_col].eq("C")]
        if a.empty or c.empty:
            continue

        reference_return = float(group[label].mean())
        a_return = float(a[label].mean())
        b_return = float(b[label].mean()) if not b.empty else np.nan
        c_return = float(c[label].mean())
        row = {
            "scope": scope,
            "pool_type": str(group["pool_type"].iloc[0]),
            "date": str(group["date"].iloc[0]),
            "sector_name": str(group["sector_name"].iloc[0]) if "sector_name" in group_cols else "全部板块",
            "horizon": horizon,
            "a_count": int(len(a)),
            "b_count": int(len(b)),
            "c_count": int(len(c)),
            "a_forward_return": a_return,
            "b_forward_return": b_return,
            "c_forward_return": c_return,
            "reference_forward_return": reference_return,
            "a_excess_vs_reference": a_return - reference_return,
            "a_minus_c": a_return - c_return,
            "a_positive_count": int((a[label] > 0).sum()),
            "a_relative_win_count": int((a[label] > reference_return).sum()),
        }
        rows.append(row)
    return pd.DataFrame(rows)


def summarize_accuracy_snapshots(snapshots: pd.DataFrame) -> pd.DataFrame:
    columns = [
        "scope",
        "pool_type",
        "horizon",
        "periods",
        "sector_snapshots",
        "a_stock_count",
        "a_forward_return_mean",
        "b_forward_return_mean",
        "c_forward_return_mean",
        "reference_forward_return_mean",
        "a_excess_vs_reference_mean",
        "a_minus_c_mean",
        "a_positive_period_ratio",
        "a_beats_reference_period_ratio",
        "a_beats_c_period_ratio",
        "a_stock_positive_hit_ratio",
        "a_stock_relative_hit_ratio",
    ]
    if snapshots.empty:
        return pd.DataFrame(columns=columns)

    rows: list[dict[str, object]] = []
    for (scope, pool_type, horizon), group in snapshots.groupby(["scope", "pool_type", "horizon"]):
        a_count = int(group["a_count"].sum())
        rows.append(
            {
                "scope": scope,
                "pool_type": pool_type,
                "horizon": horizon,
                "periods": int(group["date"].nunique()),
                "sector_snapshots": int(len(group)),
                "a_stock_count": a_count,
                "a_forward_return_mean": float(group["a_forward_return"].mean()),
                "b_forward_return_mean": float(group["b_forward_return"].mean()),
                "c_forward_return_mean": float(group["c_forward_return"].mean()),
                "reference_forward_return_mean": float(group["reference_forward_return"].mean()),
                "a_excess_vs_reference_mean": float(group["a_excess_vs_reference"].mean()),
                "a_minus_c_mean": float(group["a_minus_c"].mean()),
                "a_positive_period_ratio": float((group["a_forward_return"] > 0).mean()),
                "a_beats_reference_period_ratio": float((group["a_excess_vs_reference"] > 0).mean()),
                "a_beats_c_period_ratio": float((group["a_minus_c"] > 0).mean()),
                "a_stock_positive_hit_ratio": float(group["a_positive_count"].sum() / a_count) if a_count else np.nan,
                "a_stock_relative_hit_ratio": float(group["a_relative_win_count"].sum() / a_count) if a_count else np.nan,
            }
        )
    return pd.DataFrame(rows, columns=columns).sort_values(
        ["horizon", "scope", "pool_type"],
        ascending=[True, True, True],
    )


def summarize_time_stability(snapshots: pd.DataFrame, time_split_ratio: float = 0.70) -> pd.DataFrame:
    columns = [
        "pool_type",
        "horizon",
        "phase",
        "start_date",
        "end_date",
        "periods",
        "a_forward_return_mean",
        "b_forward_return_mean",
        "c_forward_return_mean",
        "reference_forward_return_mean",
        "a_excess_vs_reference_mean",
        "a_minus_c_mean",
        "a_positive_period_ratio",
        "a_beats_reference_period_ratio",
        "a_beats_c_period_ratio",
        "a_stock_positive_hit_ratio",
        "a_stock_relative_hit_ratio",
    ]
    if snapshots.empty:
        return pd.DataFrame(columns=columns)
    if not 0 < time_split_ratio < 1:
        raise ValueError("time_split_ratio must be between 0 and 1")

    rows: list[dict[str, object]] = []
    for (pool_type, horizon), group in snapshots.groupby(["pool_type", "horizon"]):
        dates = sorted(group["date"].astype(str).unique().tolist())
        if len(dates) < 2:
            continue
        split_at = min(max(int(len(dates) * time_split_ratio), 1), len(dates) - 1)
        early_dates = set(dates[:split_at])
        for phase, phase_group in [
            ("早期样本", group[group["date"].astype(str).isin(early_dates)]),
            ("后段留出期", group[~group["date"].astype(str).isin(early_dates)]),
        ]:
            if phase_group.empty:
                continue
            a_count = int(phase_group["a_count"].sum())
            rows.append(
                {
                    "pool_type": pool_type,
                    "horizon": horizon,
                    "phase": phase,
                    "start_date": str(phase_group["date"].min()),
                    "end_date": str(phase_group["date"].max()),
                    "periods": int(phase_group["date"].nunique()),
                    "a_forward_return_mean": float(phase_group["a_forward_return"].mean()),
                    "b_forward_return_mean": float(phase_group["b_forward_return"].mean()),
                    "c_forward_return_mean": float(phase_group["c_forward_return"].mean()),
                    "reference_forward_return_mean": float(phase_group["reference_forward_return"].mean()),
                    "a_excess_vs_reference_mean": float(phase_group["a_excess_vs_reference"].mean()),
                    "a_minus_c_mean": float(phase_group["a_minus_c"].mean()),
                    "a_positive_period_ratio": float((phase_group["a_forward_return"] > 0).mean()),
                    "a_beats_reference_period_ratio": float((phase_group["a_excess_vs_reference"] > 0).mean()),
                    "a_beats_c_period_ratio": float((phase_group["a_minus_c"] > 0).mean()),
                    "a_stock_positive_hit_ratio": float(phase_group["a_positive_count"].sum() / a_count) if a_count else np.nan,
                    "a_stock_relative_hit_ratio": float(phase_group["a_relative_win_count"].sum() / a_count) if a_count else np.nan,
                }
            )
    result = pd.DataFrame(rows, columns=columns)
    if result.empty:
        return result
    phase_order = {"早期样本": 0, "后段留出期": 1}
    return (
        result.assign(_phase_order=result["phase"].map(phase_order))
        .sort_values(["horizon", "pool_type", "_phase_order"])
        .drop(columns="_phase_order")
        .reset_index(drop=True)
    )


def build_recommendation_validation(
    panel: pd.DataFrame,
    horizons: list[str] | None = None,
    min_type_pool_size: int = 30,
    min_sector_size: int = 8,
    time_split_ratio: float = 0.70,
) -> dict[str, pd.DataFrame]:
    """Validate the A/B/C recommendation tiers at type-pool and sector levels."""

    horizons = horizons or ["20d", "60d"]
    type_graded = assign_historical_grades(
        panel,
        group_cols=["pool_type", "date"],
        min_group_size=min_type_pool_size,
        grade_col="type_grade",
        percentile_col="type_score_percentile",
    )
    graded = assign_historical_grades(
        type_graded,
        group_cols=["pool_type", "date", "sector_name"],
        min_group_size=min_sector_size,
        grade_col="sector_grade",
        percentile_col="sector_score_percentile",
    )

    type_snapshots: list[pd.DataFrame] = []
    sector_snapshots: list[pd.DataFrame] = []
    observations: list[pd.DataFrame] = []
    base_cols = [
        "pool_type",
        "date",
        "sector_name",
        "stock_code",
        "stock_name",
        "historical_proxy_score",
        "type_score_percentile",
        "type_grade",
        "sector_score_percentile",
        "sector_grade",
    ]
    for optional_col in ["stock_code", "stock_name"]:
        if optional_col not in graded.columns:
            graded[optional_col] = ""
    for horizon in horizons:
        label = f"future_return_{horizon}"
        if label not in graded.columns:
            continue
        type_snapshots.append(
            build_accuracy_snapshots(
                graded,
                horizon=horizon,
                grade_col="type_grade",
                scope="类型池",
                group_cols=["pool_type", "date"],
            )
        )
        sector_snapshots.append(
            build_accuracy_snapshots(
                graded,
                horizon=horizon,
                grade_col="sector_grade",
                scope="板块内",
                group_cols=["pool_type", "date", "sector_name"],
            )
        )

        observation = graded[base_cols + [label]].copy()
        observation = observation.rename(columns={label: "future_return"})
        observation["horizon"] = horizon
        type_reference = (
            observation[observation["type_grade"].isin(["A", "B", "C"])]
            .groupby(["pool_type", "date"])["future_return"]
            .mean()
            .rename("type_reference_forward_return")
            .reset_index()
        )
        sector_reference = (
            observation[observation["sector_grade"].isin(["A", "B", "C"])]
            .groupby(["pool_type", "date", "sector_name"])["future_return"]
            .mean()
            .rename("sector_reference_forward_return")
            .reset_index()
        )
        observation = observation.merge(type_reference, on=["pool_type", "date"], how="left")
        observation = observation.merge(sector_reference, on=["pool_type", "date", "sector_name"], how="left")
        observation["type_excess_return"] = observation["future_return"] - observation["type_reference_forward_return"]
        observation["sector_excess_return"] = observation["future_return"] - observation["sector_reference_forward_return"]
        observations.append(observation)

    type_snapshot_panel = pd.concat(type_snapshots, ignore_index=True) if type_snapshots else pd.DataFrame()
    sector_snapshot_panel = pd.concat(sector_snapshots, ignore_index=True) if sector_snapshots else pd.DataFrame()
    observation_panel = pd.concat(observations, ignore_index=True) if observations else pd.DataFrame(columns=base_cols)
    type_summary = summarize_accuracy_snapshots(type_snapshot_panel)
    sector_summary = summarize_accuracy_snapshots(sector_snapshot_panel)
    time_stability = summarize_time_stability(type_snapshot_panel, time_split_ratio=time_split_ratio)
    return {
        "observations": observation_panel,
        "type_pool_snapshots": type_snapshot_panel,
        "sector_neutral_snapshots": sector_snapshot_panel,
        "type_pool_summary": type_summary,
        "sector_neutral_summary": sector_summary,
        "time_stability_summary": time_stability,
    }


def build_historical_validation() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, dict[str, pd.DataFrame]]:
    v2, migration = load_aux(all_dates=True)
    migration_cols = [
        "date",
        "source_group",
        "sector_code",
        "stock_code",
        "stock_liquidity_delta_score",
        "sector_liquidity_delta_score",
        "price_confirm_score",
        "relative_strength_score",
        "overheat_penalty",
        "capital_migration_score",
        "static_liquidity_score",
    ]
    history = v2.merge(
        migration[migration_cols],
        on=["date", "source_group", "sector_code", "stock_code"],
        how="left",
        validate="one_to_one",
    )
    scored_history = []
    for pool_type in POOL_SECTORS:
        selected = select_preferred_history_rows(history, pool_type)
        if not selected.empty:
            scored_history.append(historical_proxy_scores(selected, pool_type))
    panel = pd.concat(scored_history, ignore_index=True)
    panel = panel[panel["avg_amount_20d_hist"].fillna(0) >= MIN_AVG_AMOUNT].copy()
    recommendation_validation = build_recommendation_validation(panel)

    ic_rows: list[dict[str, object]] = []
    layer_rows: list[dict[str, object]] = []
    topn_rows: list[dict[str, object]] = []
    for horizon in ["20d", "60d"]:
        label = f"future_return_{horizon}"
        valid_panel = panel[panel[label].notna()].copy()
        for (pool_type, date), group in valid_panel.groupby(["pool_type", "date"]):
            group = group.dropna(subset=[label, "historical_proxy_score"])
            if len(group) < 30:
                continue
            ic_rows.append(
                {
                    "pool_type": pool_type,
                    "horizon": horizon,
                    "date": date,
                    "rank_ic": group["historical_proxy_score"].rank().corr(group[label].rank()),
                    "sample_size": int(len(group)),
                }
            )
            ranked = group.assign(layer=pd.qcut(group["historical_proxy_score"].rank(method="first"), 5, labels=False) + 1)
            for layer, layer_group in ranked.groupby("layer"):
                layer_rows.append(
                    {
                        "pool_type": pool_type,
                        "horizon": horizon,
                        "date": date,
                        "layer": int(layer),
                        "mean_forward_return": float(layer_group[label].mean()),
                        "sample_size": int(len(layer_group)),
                    }
                )
            for top_n in [10, 20, 30]:
                if len(group) < top_n * 2:
                    continue
                top = group.nlargest(top_n, "historical_proxy_score")
                bottom = group.nsmallest(top_n, "historical_proxy_score")
                universe_return = group[label].mean()
                topn_rows.append(
                    {
                        "pool_type": pool_type,
                        "horizon": horizon,
                        "date": date,
                        "top_n": top_n,
                        "top_return": float(top[label].mean()),
                        "bottom_return": float(bottom[label].mean()),
                        "universe_return": float(universe_return),
                        "top_excess_vs_universe": float(top[label].mean() - universe_return),
                        "top_minus_bottom": float(top[label].mean() - bottom[label].mean()),
                    }
                )

    ic = pd.DataFrame(ic_rows)
    layers = pd.DataFrame(layer_rows)
    topn = pd.DataFrame(topn_rows)
    ic_summary = (
        ic.groupby(["pool_type", "horizon"])
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
    if layers.empty:
        layer_summary = pd.DataFrame()
    else:
        pivot = layers.pivot_table(index=["pool_type", "horizon", "date"], columns="layer", values="mean_forward_return")
        layer_rows_out = []
        for (pool_type, horizon), group in pivot.groupby(level=[0, 1]):
            g = group.droplevel([0, 1])
            layer_rows_out.append(
                {
                    "pool_type": pool_type,
                    "horizon": horizon,
                    "periods": int(len(g)),
                    "layer1_low_mean": float(g[1].mean()),
                    "layer5_high_mean": float(g[5].mean()),
                    "high_minus_low_mean": float((g[5] - g[1]).mean()),
                    "high_beats_low_ratio": float((g[5] > g[1]).mean()),
                }
            )
        layer_summary = pd.DataFrame(layer_rows_out).sort_values(["horizon", "high_minus_low_mean"], ascending=[True, False])
    topn_summary = (
        topn.groupby(["pool_type", "horizon", "top_n"])
        .agg(
            periods=("top_return", "count"),
            top_return_mean=("top_return", "mean"),
            universe_return_mean=("universe_return", "mean"),
            excess_mean=("top_excess_vs_universe", "mean"),
            top_minus_bottom_mean=("top_minus_bottom", "mean"),
            excess_positive_ratio=("top_excess_vs_universe", lambda x: float((x > 0).mean())),
        )
        .reset_index()
        .sort_values(["horizon", "top_n", "excess_mean"], ascending=[True, True, False])
    )
    return panel, ic_summary, layer_summary, topn_summary, recommendation_validation


def formula_matrix() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "pool_type": "主线成长",
                "main_factor": "行业趋势/行业空间/成长质量/个股动量/估值空间",
                "confirmation": "资金迁移/主线弹性 beta/价格相对强度",
                "risk_control": "估值拥挤、回撤、短期过热进入分数，不单独改名次",
            },
            {
                "pool_type": "周期",
                "main_factor": "行业趋势/周期价格强度/上涨弹性 beta/盈利修复",
                "confirmation": "资金迁移/价格确认/流动性变化",
                "risk_control": "估值低位、回撤、短期过热",
            },
            {
                "pool_type": "防守",
                "main_factor": "防守属性/下跌 beta 控制/回撤控制/估值低位",
                "confirmation": "资金迁移/流动性变化/ROE",
                "risk_control": "低 beta、低回撤、估值安全边际",
            },
            {
                "pool_type": "修复",
                "main_factor": "修复龙头/盈利修复/短期修复强度/估值低位",
                "confirmation": "资金迁移/流动性变化/价格确认",
                "risk_control": "回撤、估值低位、短期过热",
            },
            {
                "pool_type": "金融",
                "main_factor": "PB/PE 低位、ROE、个股动量、下跌 beta 控制、行业趋势",
                "confirmation": "资金迁移/流动性变化/价格确认",
                "risk_control": "回撤、估值低位、低 beta",
            },
        ]
    )


def build_report(
    scored: pd.DataFrame,
    pool_summary: pd.DataFrame,
    sector_summary: pd.DataFrame,
    sector_grade_summary: pd.DataFrame,
    top: pd.DataFrame,
    type_accuracy_summary: pd.DataFrame,
    sector_accuracy_summary: pd.DataFrame,
    time_stability_summary: pd.DataFrame,
    ic_summary: pd.DataFrame,
    layer_summary: pd.DataFrame,
    topn_summary: pd.DataFrame,
) -> str:
    latest_date = scored["latest_date"].dropna().astype(str).max()
    return f"""# 类型化股票池因子矩阵 V1

数据口径：AKShare/本地缓存，最新价格日 `{latest_date}`。本报告是当前截面的板块内选股分析，不是交易回测。

## 结论

- 已按类型股票池独立打分，避免把成长、防守、修复、周期、金融放进同一个因子里比较。
- A/B/C 来自各自类型池内分位：A 为池内前 20%，B 为 40%-80%，C 为后 40%；硬过滤样本不参与分位。
- 软风险没有另起人工规则，而是进入 `risk_control_score`；`risk_labels` 只解释风险来源，不改变最终排序。
- 当前数据覆盖来自原先主线/修复/防守三组行业候选，不是全 A 股全行业成分。
- 本版主结构改为“类型池 -> 板块 -> A/B/C 明细”，每个板块都能直接看到评级数量、股票名单和分数。

## 类型因子矩阵

{md_table(formula_matrix(), ["pool_type", "main_factor", "confirmation", "risk_control"])}

## 类型池汇总

{md_table(pool_summary, ["pool_type", "stocks", "eligible", "removed", "a_count", "b_count", "c_count", "score_mean", "main_factor_mean", "confirmation_mean", "risk_control_mean"])}

## 板块-评级汇总

{md_table(sector_grade_summary, ["pool_type", "sector_name", "stocks", "eligible", "removed", "a_count", "b_count", "c_count", "score_mean", "score_max", "score_min", "main_factor_mean", "confirmation_mean", "risk_control_mean"])}

## 板块 A/B/C 明细

{build_sector_grade_markdown(scored)}

## 推荐准确性验证

口径：在每个历史截面，用当日可重建的代理因子生成与当前相同的 A/B/C 分级，再观察其后 20 日或 60 日收益。`A 正收益期占比`表示 A 组平均收益为正的截面比例；`A 相对基准胜率`表示 A 组平均收益高于比较基准的截面比例；`A-C 胜率`表示 A 组高于 C 组的截面比例。相对口径比“是否上涨”更重要，因为市场整体上涨时所有股票都可能上涨。

### 类型池 A/B/C 准确性

{md_table(type_accuracy_summary, ["pool_type", "horizon", "periods", "a_forward_return_mean", "b_forward_return_mean", "c_forward_return_mean", "reference_forward_return_mean", "a_excess_vs_reference_mean", "a_minus_c_mean"], 30)}

### 类型池命中率

{md_table(type_accuracy_summary, ["pool_type", "horizon", "periods", "a_stock_count", "a_positive_period_ratio", "a_beats_reference_period_ratio", "a_beats_c_period_ratio", "a_stock_positive_hit_ratio", "a_stock_relative_hit_ratio"], 30)}

### 板块内选股准确性

这里先把同日、同板块的平均未来收益扣掉，再看 A 是否仍优于板块平均和 C。这个表更接近“板块已经选定后，个股推荐是否准确”。

{md_table(sector_accuracy_summary, ["pool_type", "horizon", "periods", "sector_snapshots", "a_forward_return_mean", "c_forward_return_mean", "reference_forward_return_mean", "a_excess_vs_reference_mean", "a_minus_c_mean", "a_beats_reference_period_ratio", "a_beats_c_period_ratio"], 30)}

### 时间稳定性

权重固定后按时间顺序切分为早期样本和后段留出期，用于检查结果是否只集中在某一段行情。由于因子构成是在完整历史已知后形成，这不是严格的完全样本外证明，只能作为稳定性检查。

{md_table(time_stability_summary, ["pool_type", "horizon", "phase", "start_date", "end_date", "periods", "a_excess_vs_reference_mean", "a_minus_c_mean", "a_beats_reference_period_ratio", "a_beats_c_period_ratio"], 40)}

## 分类型历史代理有效性

说明：这里仅验证历史可重建代理因子，不包含当前截面的估值/财务成长/行业空间字段。

### Rank IC

{md_table(ic_summary, ["pool_type", "horizon", "periods", "mean_rank_ic", "median_rank_ic", "positive_ratio", "ic_ir", "avg_sample_size"], 30)}

### 分层收益

{md_table(layer_summary, ["pool_type", "horizon", "periods", "layer1_low_mean", "layer5_high_mean", "high_minus_low_mean", "high_beats_low_ratio"], 30)}

### TopN 收益

{md_table(topn_summary, ["pool_type", "horizon", "top_n", "periods", "top_return_mean", "universe_return_mean", "excess_mean", "top_minus_bottom_mean", "excess_positive_ratio"], 50)}

## 行业层面汇总

{md_table(sector_summary, ["pool_type", "sector_name", "stocks", "a_count", "score_mean", "momentum_mean", "capital_migration_mean", "valuation_mean"], 80)}

## 使用边界

- 财务与估值数据仍是当前截面字段，不能当作历史点位回测结论。
- 历史验证部分只验证价格、成交额、beta、资金迁移可重建代理因子；完整财务因子有效性需要点位财务库。
- 推荐准确性采用相对类型池和相对板块两种口径；它验证排序能力，不等同于交易策略收益。
- 60 日评价窗口之间会重叠，不能把每个截面当作完全独立样本。
- 同一只股票可以在多个类型池出现，解释时必须按其所在类型池的因子逻辑看分数。
"""


def write_outputs(
    scored: pd.DataFrame,
    pool_summary: pd.DataFrame,
    sector_summary: pd.DataFrame,
    sector_grade_summary: pd.DataFrame,
    sector_grade_details: pd.DataFrame,
    top: pd.DataFrame,
    historical_panel: pd.DataFrame,
    recommendation_validation: dict[str, pd.DataFrame],
    ic_summary: pd.DataFrame,
    layer_summary: pd.DataFrame,
    topn_summary: pd.DataFrame,
) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    scored.to_csv(OUTPUT_DIR / "type_factor_candidates_all.csv", index=False)
    pool_summary.to_csv(OUTPUT_DIR / "type_factor_pool_summary.csv", index=False)
    sector_summary.to_csv(OUTPUT_DIR / "type_factor_sector_summary.csv", index=False)
    sector_grade_summary.to_csv(OUTPUT_DIR / "type_factor_sector_grade_summary.csv", index=False)
    sector_grade_details.to_csv(OUTPUT_DIR / "type_factor_sector_grade_details.csv", index=False)
    top.to_csv(OUTPUT_DIR / "type_factor_a_candidates.csv", index=False)
    formula_matrix().to_csv(OUTPUT_DIR / "type_factor_formula_matrix.csv", index=False)
    historical_panel.to_csv(OUTPUT_DIR / "type_factor_historical_proxy_panel.csv", index=False)
    recommendation_validation["type_pool_summary"].to_csv(
        OUTPUT_DIR / "type_factor_recommendation_accuracy_type_pool.csv", index=False
    )
    recommendation_validation["sector_neutral_summary"].to_csv(
        OUTPUT_DIR / "type_factor_recommendation_accuracy_sector_neutral.csv", index=False
    )
    recommendation_validation["time_stability_summary"].to_csv(
        OUTPUT_DIR / "type_factor_recommendation_accuracy_time_stability.csv", index=False
    )
    recommendation_validation["observations"].to_csv(
        OUTPUT_DIR / "type_factor_recommendation_accuracy_observations.csv", index=False
    )
    ic_summary.to_csv(OUTPUT_DIR / "type_factor_historical_ic_summary.csv", index=False)
    layer_summary.to_csv(OUTPUT_DIR / "type_factor_historical_layer_summary.csv", index=False)
    topn_summary.to_csv(OUTPUT_DIR / "type_factor_historical_topn_summary.csv", index=False)
    xlsx_path = write_excel_workbook(
        pool_summary,
        sector_grade_summary,
        sector_grade_details,
        recommendation_validation["type_pool_summary"],
        recommendation_validation["sector_neutral_summary"],
        recommendation_validation["time_stability_summary"],
        recommendation_validation["observations"],
        ic_summary,
        layer_summary,
        topn_summary,
    )
    REPORT_PATH.write_text(
        build_report(
            scored,
            pool_summary,
            sector_summary,
            sector_grade_summary,
            top,
            recommendation_validation["type_pool_summary"],
            recommendation_validation["sector_neutral_summary"],
            recommendation_validation["time_stability_summary"],
            ic_summary,
            layer_summary,
            topn_summary,
        ),
        encoding="utf-8",
    )

    metadata = {
        "latest_date": str(scored["latest_date"].dropna().astype(str).max()),
        "rows": int(len(scored)),
        "unique_stocks_across_pools": int(scored["stock_code"].nunique()),
        "historical_proxy_rows": int(len(historical_panel)),
        "recommendation_validation": {
            "type_min_group_size": 30,
            "sector_min_group_size": 8,
            "time_split_ratio": 0.70,
        },
        "pool_types": list(POOL_SECTORS),
        "min_avg_amount": MIN_AVG_AMOUNT,
        "outputs": [
            "type_factor_candidates_all.csv",
            "type_factor_pool_summary.csv",
            "type_factor_sector_summary.csv",
            "type_factor_sector_grade_summary.csv",
            "type_factor_sector_grade_details.csv",
            "type_factor_a_candidates.csv",
            "type_factor_formula_matrix.csv",
            "type_factor_historical_proxy_panel.csv",
            "type_factor_recommendation_accuracy_type_pool.csv",
            "type_factor_recommendation_accuracy_sector_neutral.csv",
            "type_factor_recommendation_accuracy_time_stability.csv",
            "type_factor_recommendation_accuracy_observations.csv",
            "type_factor_historical_ic_summary.csv",
            "type_factor_historical_layer_summary.csv",
            "type_factor_historical_topn_summary.csv",
            "type_factor_sector_grade_workbook.xlsx",
            "type_factor_pools_v1_report.md",
        ],
    }
    (OUTPUT_DIR / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    zip_path = OUTPUT_DIR / "type_factor_pools_v1_outputs.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in [
            "type_factor_candidates_all.csv",
            "type_factor_pool_summary.csv",
            "type_factor_sector_summary.csv",
            "type_factor_sector_grade_summary.csv",
            "type_factor_sector_grade_details.csv",
            "type_factor_a_candidates.csv",
            "type_factor_formula_matrix.csv",
            "type_factor_historical_proxy_panel.csv",
            "type_factor_recommendation_accuracy_type_pool.csv",
            "type_factor_recommendation_accuracy_sector_neutral.csv",
            "type_factor_recommendation_accuracy_time_stability.csv",
            "type_factor_recommendation_accuracy_observations.csv",
            "type_factor_historical_ic_summary.csv",
            "type_factor_historical_layer_summary.csv",
            "type_factor_historical_topn_summary.csv",
            xlsx_path.name,
            "type_factor_pools_v1_report.md",
            "metadata.json",
        ]:
            zf.write(OUTPUT_DIR / file, arcname=file)
    return zip_path


def main() -> None:
    base = attach_aux(load_base())
    scored_pools = []
    for pool_type in POOL_SECTORS:
        pool = pick_pool_rows(base, pool_type)
        if not pool.empty:
            scored_pools.append(score_pool(pool))
    scored = pd.concat(scored_pools, ignore_index=True)
    pool_summary, sector_summary, top = summarize(scored)
    sector_grade_summary = build_sector_grade_summary(scored)
    sector_grade_details = build_sector_grade_details(scored)
    historical_panel, ic_summary, layer_summary, topn_summary, recommendation_validation = build_historical_validation()
    zip_path = write_outputs(
        scored,
        pool_summary,
        sector_summary,
        sector_grade_summary,
        sector_grade_details,
        top,
        historical_panel,
        recommendation_validation,
        ic_summary,
        layer_summary,
        topn_summary,
    )
    print(
        json.dumps(
            {
                "report": str(REPORT_PATH),
                "zip": str(zip_path),
                "current_rows": len(scored),
                "historical_proxy_rows": len(historical_panel),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

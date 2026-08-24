#!/usr/bin/env python3
"""Build a point-in-time, sector-neutral stock Beta score panel.

The strategy has two intentionally separated decisions:
1. ``industry_trend_score_hist`` selects sectors.
2. This file ranks stocks *inside* each selected sector.

The stock score never includes the sector trend. Every stock sub-score is
standardized within the same date/type/sector cross-section, so it answers
"which stock is stronger than its peers in this sector?" rather than
"which stock happens to be in a strong sector?".
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PRICE_PANEL = ROOT / "lab/backtests/type_factor_pools_v1/type_factor_historical_proxy_panel.csv"
DEFAULT_FINANCIAL_PANEL = ROOT / "lab/backtests/pit_financial_panel/pit_financial_asof_panel.csv"
DEFAULT_VALUATION_PANEL = ROOT / "lab/backtests/pit_valuation_panel/pit_valuation_asof_panel.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/stock_beta_score_v1"

GROUP_COLUMNS = ["date", "pool_type", "sector_code"]

# Each of the 19 sectors receives exactly one stock-selection type. Existing
# research pools overlap by design; a live two-step portfolio cannot, because
# the same selected sector must not be scored under multiple formulas.
SECTOR_TYPE_ROUTE = {
    "电子": "主线成长",
    "通信": "主线成长",
    "电力设备": "主线成长",
    "机械设备": "主线成长",
    "基础化工": "周期",
    "建筑材料": "周期",
    "有色金属": "周期",
    "煤炭": "周期",
    "石油石化": "周期",
    "公用事业": "防守",
    "交通运输": "防守",
    "食品饮料": "防守",
    "家用电器": "防守",
    "医药生物": "修复",
    "农林牧渔": "修复",
    "商贸零售": "修复",
    "美容护理": "修复",
    "银行": "金融",
    "非银金融": "金融",
}

STOCK_COMPONENTS = [
    "momentum_score",
    "type_beta_score",
    "earnings_growth_score",
    "growth_quality_score",
    "valuation_position_score",
    "capital_liquidity_score",
    "drawdown_constraint_score",
]

# Every row is a 0-100 component score. Zero weights are explicit: a type can
# still expose the component for diagnostics, but it cannot affect its total.
TYPE_WEIGHTS = {
    "主线成长": {
        "momentum_score": 0.20,
        "type_beta_score": 0.15,
        "earnings_growth_score": 0.20,
        "growth_quality_score": 0.15,
        "valuation_position_score": 0.10,
        "capital_liquidity_score": 0.10,
        "drawdown_constraint_score": 0.10,
    },
    "周期": {
        "momentum_score": 0.20,
        "type_beta_score": 0.20,
        "earnings_growth_score": 0.20,
        "growth_quality_score": 0.00,
        "valuation_position_score": 0.15,
        "capital_liquidity_score": 0.10,
        "drawdown_constraint_score": 0.15,
    },
    "防守": {
        "momentum_score": 0.10,
        "type_beta_score": 0.20,
        "earnings_growth_score": 0.15,
        "growth_quality_score": 0.20,
        "valuation_position_score": 0.25,
        "capital_liquidity_score": 0.05,
        "drawdown_constraint_score": 0.05,
    },
    "修复": {
        "momentum_score": 0.20,
        "type_beta_score": 0.10,
        "earnings_growth_score": 0.35,
        "growth_quality_score": 0.10,
        "valuation_position_score": 0.15,
        "capital_liquidity_score": 0.10,
        "drawdown_constraint_score": 0.00,
    },
    "金融": {
        "momentum_score": 0.10,
        "type_beta_score": 0.20,
        "earnings_growth_score": 0.20,
        "growth_quality_score": 0.00,
        "valuation_position_score": 0.30,
        "capital_liquidity_score": 0.10,
        "drawdown_constraint_score": 0.10,
    },
}

FINANCIAL_COLUMNS = [
    "PARENT_NETPROFIT_YOY",
    "DEDUCT_PARENT_NETPROFIT_YOY",
    "TOTAL_OPERATE_INCOME_YOY",
    "TOTAL_OPERATE_INCOME_TTM",
    "PARENT_NETPROFIT_TTM",
    "DEDUCT_PARENT_NETPROFIT_TTM",
]
VALUATION_COLUMNS = ["market_cap_yi", "pe_ttm", "pb"]


def zcode(value: object) -> str:
    return str(value).split(".")[0].zfill(6)


def output_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def true_mask(series: pd.Series) -> pd.Series:
    """Parse bool-like CSV values without treating the string 'False' as true."""

    return series.astype(str).str.strip().str.lower().isin({"true", "1", "1.0"})


def apply_point_in_time_masks(panel: pd.DataFrame) -> pd.DataFrame:
    """Null financial/valuation inputs that were not available on decision day."""

    result = panel.copy()
    if "availability_valid_financial" in result:
        finance_ok = true_mask(result["availability_valid_financial"])
        result.loc[~finance_ok, [column for column in FINANCIAL_COLUMNS if column in result]] = np.nan
    if "availability_valid_valuation" in result:
        valuation_ok = true_mask(result["availability_valid_valuation"])
        result.loc[~valuation_ok, [column for column in VALUATION_COLUMNS if column in result]] = np.nan
    return result


def row_mean(panel: pd.DataFrame, columns: list[str]) -> pd.Series:
    available = [column for column in columns if column in panel]
    if not available:
        return pd.Series(np.nan, index=panel.index, dtype=float)
    return panel[available].apply(pd.to_numeric, errors="coerce").mean(axis=1)


def rank_within_sector(
    panel: pd.DataFrame,
    raw_column: str,
    score_column: str,
    *,
    min_group_size: int = 2,
    ascending: bool = True,
) -> pd.DataFrame:
    """Convert a raw factor to a 0-100 same-sector cross-sectional score."""

    result = panel.copy()
    values = pd.to_numeric(result[raw_column], errors="coerce")
    groups = [result[column] for column in GROUP_COLUMNS]
    counts = values.groupby(groups, dropna=False).transform("count")
    ranks = values.groupby(groups, dropna=False).rank(method="average", ascending=ascending)
    denominator = (counts - 1).replace(0, np.nan)
    score = ((ranks - 1) / denominator * 100.0).where(counts.ge(min_group_size))
    result[score_column] = score
    return result


def _bounded_yoy(value: pd.Series) -> pd.Series:
    """Limit near-zero-base YoY explosions before the within-sector rank."""

    return pd.to_numeric(value, errors="coerce").clip(lower=-100.0, upper=200.0)


def _margin(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    denominator = pd.to_numeric(denominator, errors="coerce")
    numerator = pd.to_numeric(numerator, errors="coerce")
    return (numerator / denominator.where(denominator.gt(0))).clip(lower=-1.0, upper=1.0)


def build_factor_components(panel: pd.DataFrame, min_group_size: int) -> pd.DataFrame:
    """Create named raw and 0-100 stock factor components."""

    scored = panel.copy()
    scored["momentum_raw"] = row_mean(scored, ["stock_momentum_score_hist", "relative_strength_score"])
    scored["type_beta_raw"] = row_mean(scored, ["type_beta_score_hist", "industry_beta_score_hist"])
    scored["capital_liquidity_raw"] = row_mean(
        scored,
        ["stock_liquidity_delta_score", "capital_migration_score", "price_confirm_score"],
    )
    scored["drawdown_constraint_raw"] = row_mean(scored, ["drawdown_score_hist"])

    scored["earnings_growth_raw"] = row_mean(
        scored.assign(
            _parent_yoy=_bounded_yoy(scored.get("PARENT_NETPROFIT_YOY", pd.Series(index=scored.index))),
            _deduct_yoy=_bounded_yoy(scored.get("DEDUCT_PARENT_NETPROFIT_YOY", pd.Series(index=scored.index))),
        ),
        ["_parent_yoy", "_deduct_yoy"],
    )
    scored["profit_margin_ttm_raw"] = _margin(
        scored.get("PARENT_NETPROFIT_TTM", pd.Series(index=scored.index)),
        scored.get("TOTAL_OPERATE_INCOME_TTM", pd.Series(index=scored.index)),
    )
    scored["deduct_margin_ttm_raw"] = _margin(
        scored.get("DEDUCT_PARENT_NETPROFIT_TTM", pd.Series(index=scored.index)),
        scored.get("TOTAL_OPERATE_INCOME_TTM", pd.Series(index=scored.index)),
    )
    scored["growth_quality_raw"] = row_mean(scored, ["profit_margin_ttm_raw", "deduct_margin_ttm_raw"])

    pe = pd.to_numeric(scored.get("pe_ttm", pd.Series(index=scored.index)), errors="coerce")
    pb = pd.to_numeric(scored.get("pb", pd.Series(index=scored.index)), errors="coerce")
    market_cap = pd.to_numeric(scored.get("market_cap_yi", pd.Series(index=scored.index)), errors="coerce") * 100_000_000.0
    revenue_ttm = pd.to_numeric(scored.get("TOTAL_OPERATE_INCOME_TTM", pd.Series(index=scored.index)), errors="coerce")
    # A loss-making company is not left missing: its earnings yield is placed
    # below every positive-yield company in the same sector.
    scored["earnings_yield_raw"] = np.where(pe.gt(0), 1.0 / pe, np.where(pe.notna(), 0.0, np.nan))
    scored["book_yield_raw"] = np.where(pb.gt(0), 1.0 / pb, np.where(pb.notna(), 0.0, np.nan))
    scored["sales_yield_raw"] = revenue_ttm / market_cap.where(market_cap.gt(0))

    for raw, score in [
        ("momentum_raw", "momentum_score"),
        ("type_beta_raw", "type_beta_score"),
        ("capital_liquidity_raw", "capital_liquidity_score"),
        ("drawdown_constraint_raw", "drawdown_constraint_score"),
        ("earnings_growth_raw", "earnings_growth_score"),
        ("growth_quality_raw", "growth_quality_score"),
        ("earnings_yield_raw", "earnings_yield_score"),
        ("book_yield_raw", "book_yield_score"),
        ("sales_yield_raw", "sales_yield_score"),
    ]:
        scored = rank_within_sector(scored, raw, score, min_group_size=min_group_size)

    scored["valuation_position_score"] = row_mean(
        scored, ["earnings_yield_score", "book_yield_score", "sales_yield_score"]
    )
    for component in STOCK_COMPONENTS:
        scored[f"{component}_observed"] = scored[component].notna()
    return scored


def combine_type_scores(panel: pd.DataFrame) -> pd.DataFrame:
    """Apply the frozen, type-specific weight matrix to 0-100 components."""

    result = panel.copy()
    scores = pd.Series(np.nan, index=result.index, dtype=float)
    coverage = pd.Series(0.0, index=result.index, dtype=float)
    for pool_type, weights in TYPE_WEIGHTS.items():
        if not np.isclose(sum(weights.values()), 1.0):
            raise ValueError(f"weights for {pool_type} must sum to 1")
        mask = result["pool_type"].eq(pool_type)
        if not mask.any():
            continue
        total = pd.Series(0.0, index=result.index[mask], dtype=float)
        observed_weight = pd.Series(0.0, index=result.index[mask], dtype=float)
        for component, weight in weights.items():
            values = pd.to_numeric(result.loc[mask, component], errors="coerce")
            observed = result.loc[mask, f"{component}_observed"].fillna(False).astype(bool)
            total += weight * values.fillna(50.0)
            observed_weight += weight * observed.astype(float)
        scores.loc[mask] = total
        coverage.loc[mask] = observed_weight
    result["stock_beta_score"] = scores.round(4)
    result["score_coverage"] = coverage.round(4)
    result["score_valid"] = result["score_coverage"].ge(0.70)
    return result


def load_score_inputs(price_path: Path, financial_path: Path, valuation_path: Path) -> pd.DataFrame:
    price = pd.read_csv(price_path, dtype={"stock_code": str})
    price["stock_code"] = price["stock_code"].map(zcode)
    price["date"] = pd.to_datetime(price["date"], errors="coerce").dt.normalize()
    price["route_pool_type"] = price["sector_name"].map(SECTOR_TYPE_ROUTE)
    routed = price[price["pool_type"].eq(price["route_pool_type"])].copy()
    missing_route = sorted(set(price["sector_name"].dropna()).difference(SECTOR_TYPE_ROUTE))
    if missing_route:
        raise ValueError(f"unrouted sectors: {', '.join(missing_route)}")
    routed = routed.drop(columns="route_pool_type").drop_duplicates(["date", "stock_code"], keep="first")

    financial = pd.read_csv(financial_path, dtype={"stock_code": str}, low_memory=False)
    financial["stock_code"] = financial["stock_code"].map(zcode)
    financial["date"] = pd.to_datetime(financial["date"], errors="coerce").dt.normalize()
    finance_keep = ["stock_code", "date", "REPORT_DATE", "NOTICE_DATE", "availability_valid", *FINANCIAL_COLUMNS]
    financial = financial.reindex(columns=[column for column in finance_keep if column in financial]).rename(
        columns={
            "REPORT_DATE": "financial_report_date",
            "NOTICE_DATE": "financial_notice_date",
            "availability_valid": "availability_valid_financial",
        }
    )

    valuation = pd.read_csv(valuation_path, dtype={"stock_code": str}, low_memory=False)
    valuation["stock_code"] = valuation["stock_code"].map(zcode)
    valuation["date"] = pd.to_datetime(valuation["date"], errors="coerce").dt.normalize()
    valuation_keep = ["stock_code", "date", "valuation_date", "availability_valid", *VALUATION_COLUMNS]
    valuation = valuation.reindex(columns=[column for column in valuation_keep if column in valuation]).rename(
        columns={
            "valuation_date": "valuation_observation_date",
            "availability_valid": "availability_valid_valuation",
        }
    )
    result = routed.merge(financial, on=["stock_code", "date"], how="left", validate="one_to_one")
    result = result.merge(valuation, on=["stock_code", "date"], how="left", validate="one_to_one")
    return apply_point_in_time_masks(result)


def score_diagnostics(panel: pd.DataFrame) -> dict[str, object]:
    valid = panel[panel["stock_beta_score"].notna()].copy()
    correlation = valid[["stock_beta_score", "industry_trend_score_hist"]].corr(method="spearman").iloc[0, 1]
    component_coverage = {
        component: float(panel[f"{component}_observed"].mean()) for component in STOCK_COMPONENTS
    }
    return {
        "rows": int(len(panel)),
        "dates": int(panel["date"].nunique()),
        "stocks": int(panel["stock_code"].nunique()),
        "sectors": int(panel["sector_name"].nunique()),
        "score_valid_ratio": float(panel["score_valid"].mean()),
        "mean_score_coverage": float(panel["score_coverage"].mean()),
        "stock_score_vs_industry_trend_spearman": None if pd.isna(correlation) else float(correlation),
        "component_observation_ratio": component_coverage,
        "point_in_time_rule": "Financial inputs require a report announced on or before the decision date; valuation inputs require an observation on or before the decision date.",
        "sector_selection_rule": "industry_trend_score_hist is retained for the sector stage but excluded from STOCK_COMPONENTS and TYPE_WEIGHTS.",
    }


def write_outputs(output_dir: Path, panel: pd.DataFrame) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    panel.to_csv(output_dir / "stock_beta_score_panel.csv", index=False)
    pd.DataFrame(
        [
            {"pool_type": pool_type, "component": component, "weight": weight}
            for pool_type, weights in TYPE_WEIGHTS.items()
            for component, weight in weights.items()
        ]
    ).to_csv(output_dir / "type_score_weight_matrix.csv", index=False)
    pd.DataFrame(
        [{"sector_name": sector, "pool_type": pool_type} for sector, pool_type in SECTOR_TYPE_ROUTE.items()]
    ).to_csv(output_dir / "sector_type_route.csv", index=False)
    diagnostics = score_diagnostics(panel)
    (output_dir / "score_diagnostics.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2), encoding="utf-8")
    formula = """# 板块内个股 Beta 总分 v1

## 两步决策

1. 行业层：`industry_trend_score_hist` 仅用于选择行业。
2. 个股层：在已选行业内按 `stock_beta_score` 判断个股强弱；不同板块之间不按该分数直接争夺名额。

## 共同计算规则

- 每个原始个股因子都在 `调仓日 × 类型 × 行业` 内转换为 0–100 分位分数。
- 数字越高代表该股票相对同业更强；缺失的组件在总分中按 50 分中性填充，同时由 `score_coverage` 披露。
- `score_valid = score_coverage >= 70%`。行业趋势不属于任何个股组件。
- 财务和估值只取调仓日可见数据：财报以 `NOTICE_DATE` 为准，估值以历史估值观测日为准。

## 组件定义

- `momentum_score`：个股动量与相对强弱。
- `type_beta_score`：按行业类型预先计算的个股 Beta 分。
- `earnings_growth_score`：归母与扣非净利同比，分别截断到 [-100%, 200%] 后合成。
- `growth_quality_score`：TTM 归母/扣非净利率。
- `valuation_position_score`：正 PE 的盈利收益率、PB 倒数、PS 倒数的同业分位均值；亏损 PE 记为最低盈利收益率。
- `capital_liquidity_score`：个股成交额变化、资金迁移、价格确认。
- `drawdown_constraint_score`：历史回撤分，分数越高代表回撤约束越好。

权重见 `type_score_weight_matrix.csv`；行业-类型唯一映射见 `sector_type_route.csv`。
"""
    (output_dir / "README.md").write_text(formula, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--price-panel", default=str(DEFAULT_PRICE_PANEL))
    parser.add_argument("--financial-panel", default=str(DEFAULT_FINANCIAL_PANEL))
    parser.add_argument("--valuation-panel", default=str(DEFAULT_VALUATION_PANEL))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--min-group-size", type=int, default=8)
    args = parser.parse_args()

    panel = load_score_inputs(
        output_path(args.price_panel), output_path(args.financial_panel), output_path(args.valuation_panel)
    )
    panel = build_factor_components(panel, min_group_size=max(2, args.min_group_size))
    panel = combine_type_scores(panel)
    write_outputs(output_path(args.output_dir), panel)
    diagnostics = score_diagnostics(panel)
    print(json.dumps(diagnostics, ensure_ascii=False, indent=2))
    print(f"artifacts={output_path(args.output_dir)}")


if __name__ == "__main__":
    main()

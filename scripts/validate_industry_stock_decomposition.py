#!/usr/bin/env python3
"""Attribute the type-factor proxy between industry timing and stock ranking.

The existing proxy score mixes a common industry-trend component with
stock-specific components.  This report keeps the existing score definition
but validates the two decisions separately: select industries with the pure
industry trend score, then rank stocks only inside each selected industry.
"""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PANEL = ROOT / "lab/backtests/recent_type_factor_proxy_validation/daily_historical_proxy_panel.csv"
DEFAULT_WINDOWS = ROOT / "lab/backtests/recent_type_factor_proxy_validation/signal_windows.csv"
OUTPUT_DIR = ROOT / "lab/backtests/industry_stock_decomposition"
HORIZONS = {"1d": 1, "10d": 10, "20d": 20, "60d": 60}
MIN_STOCKS_PER_SECTOR = 8
TOP_SECTOR_COUNT = 3
TOP_STOCK_PERCENTILE = 0.80


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


def md_table(frame: pd.DataFrame, columns: list[str], rows: int = 60) -> str:
    if frame.empty:
        return "_No valid observations._"
    shown = frame.reindex(columns=[column for column in columns if column in frame.columns]).head(rows).copy()
    if shown.empty:
        return "_No selected columns._"

    def text(value: object) -> str:
        if value is None or pd.isna(value):
            return "-"
        if isinstance(value, (float, np.floating)):
            return f"{float(value):.4f}"
        return str(value).replace("|", "\\|").replace("\n", " ")

    header = "| " + " | ".join(shown.columns) + " |"
    divider = "| " + " | ".join("---" for _ in shown.columns) + " |"
    body = ["| " + " | ".join(text(value) for value in row) + " |" for row in shown.itertuples(index=False, name=None)]
    return "\n".join([header, divider, *body])


def non_overlapping_dates(dates: pd.DatetimeIndex, horizon_days: int) -> pd.DatetimeIndex:
    """Sample dates far enough apart that their forward labels do not overlap."""

    ordered = pd.DatetimeIndex(pd.to_datetime(dates)).unique().sort_values()
    return ordered[::horizon_days]


def monthly_non_overlapping_dates(dates: pd.DatetimeIndex, horizon_days: int) -> pd.DatetimeIndex:
    """Sample month-end signals at least one forward holding period apart.

    The full-history panel is monthly, unlike the daily recent panel.  Twenty
    sessions is approximately one month, so a 20-day label uses every monthly
    signal and a 60-day label uses every third one.
    """

    ordered = pd.DatetimeIndex(pd.to_datetime(dates)).unique().sort_values()
    step = max(1, int(np.ceil(horizon_days / 20)))
    return ordered[::step]


def prepare_panel(frame: pd.DataFrame, min_stocks_per_sector: int = MIN_STOCKS_PER_SECTOR) -> pd.DataFrame:
    """Create a pure industry signal and an industry-neutral stock rank.

    ``industry_trend_score_hist`` is identical for all stocks in a sector.
    Ranking the established proxy score inside each date/type/sector therefore
    removes that shared industry contribution without changing the stock-level
    ordering implied by the existing score.
    """

    required = {
        "pool_type",
        "date",
        "stock_code",
        "sector_code",
        "sector_name",
        "industry_trend_score_hist",
        "historical_proxy_score",
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"panel is missing required columns: {', '.join(missing)}")

    panel = frame.copy()
    panel["date"] = pd.to_datetime(panel["date"])
    for column in ["industry_trend_score_hist", "historical_proxy_score"]:
        panel[column] = pd.to_numeric(panel[column], errors="coerce")

    panel = panel.dropna(subset=["industry_trend_score_hist", "historical_proxy_score"]).copy()
    group_cols = ["date", "pool_type", "sector_code"]
    panel["sector_stock_count"] = panel.groupby(group_cols)["stock_code"].transform("nunique")
    panel = panel[panel["sector_stock_count"].ge(min_stocks_per_sector)].copy()
    panel["industry_score"] = panel.groupby(group_cols)["industry_trend_score_hist"].transform("mean")
    panel["stock_rank_in_sector"] = panel.groupby(group_cols)["historical_proxy_score"].rank(
        pct=True, method="average"
    )
    panel["stock_top_tier"] = panel["stock_rank_in_sector"].ge(TOP_STOCK_PERCENTILE)
    return panel


def _sector_returns(group: pd.DataFrame, label: str) -> pd.DataFrame:
    """Return sector-level forward returns for all stocks and the top stock tier."""

    rows: list[dict[str, object]] = []
    for (sector_code, sector_name), sector in group.groupby(["sector_code", "sector_name"], sort=True):
        valid = sector.dropna(subset=[label])
        top = valid[valid["stock_top_tier"]]
        if valid.empty or top.empty:
            continue
        rows.append(
            {
                "sector_code": sector_code,
                "sector_name": sector_name,
                "industry_score": float(valid["industry_score"].mean()),
                "sector_return": float(valid[label].mean()),
                "top_stock_return": float(top[label].mean()),
                "stock_count": int(valid["stock_code"].nunique()),
                "top_stock_count": int(top["stock_code"].nunique()),
            }
        )
    return pd.DataFrame(rows)


def portfolio_observations(
    panel: pd.DataFrame,
    horizon: str,
    top_sector_count: int = TOP_SECTOR_COUNT,
) -> pd.DataFrame:
    """Build equal-sector-weighted baseline, industry-only, stock-only and double portfolios."""

    label = f"future_return_{horizon}"
    if label not in panel.columns:
        raise ValueError(f"panel has no {label} column")

    rows: list[dict[str, object]] = []
    for (date, pool_type), group in panel.groupby(["date", "pool_type"], sort=True):
        sectors = _sector_returns(group, label)
        if sectors.empty:
            continue
        selected_count = min(top_sector_count, len(sectors))
        selected = sectors.sort_values(["industry_score", "sector_code"], ascending=[False, True]).head(selected_count)
        selected_codes = set(selected["sector_code"])

        baseline = sectors["sector_return"].mean()
        industry_only = selected["sector_return"].mean()
        stock_only = sectors["top_stock_return"].mean()
        double = selected["top_stock_return"].mean()
        rows.append(
            {
                "date": pd.Timestamp(date).date().isoformat(),
                "pool_type": pool_type,
                "horizon": horizon,
                "sector_count": int(len(sectors)),
                "selected_sector_count": int(selected_count),
                "selected_sectors": ", ".join(selected["sector_name"].tolist()),
                "baseline_return": baseline,
                "industry_only_return": industry_only,
                "stock_only_return": stock_only,
                "double_return": double,
                "industry_excess": industry_only - baseline,
                "stock_excess": stock_only - baseline,
                "double_excess": double - baseline,
                "stock_after_industry_excess": double - industry_only,
                "interaction_excess": double - industry_only - stock_only + baseline,
                "baseline_stock_count": int(sectors["stock_count"].sum()),
                "double_stock_count": int(
                    sectors[sectors["sector_code"].isin(selected_codes)]["top_stock_count"].sum()
                ),
            }
        )
    return pd.DataFrame(rows)


def ic_observations(panel: pd.DataFrame, horizon: str) -> pd.DataFrame:
    """Calculate sector timing IC and sector-neutral stock-ranking IC separately."""

    label = f"future_return_{horizon}"
    rows: list[dict[str, object]] = []
    for (date, pool_type), group in panel.groupby(["date", "pool_type"], sort=True):
        sectors = _sector_returns(group, label)
        if sectors.empty:
            continue
        sector_ic = np.nan
        if len(sectors) >= 3:
            sector_ic = sectors["industry_score"].rank().corr(sectors["sector_return"].rank())

        stock_ics: list[float] = []
        for _, sector in group.groupby(["sector_code", "sector_name"], sort=True):
            valid = sector.dropna(subset=[label, "stock_rank_in_sector"])
            if len(valid) < MIN_STOCKS_PER_SECTOR:
                continue
            value = valid["stock_rank_in_sector"].rank().corr(valid[label].rank())
            if pd.notna(value):
                stock_ics.append(float(value))
        rows.append(
            {
                "date": pd.Timestamp(date).date().isoformat(),
                "pool_type": pool_type,
                "horizon": horizon,
                "industry_rank_ic": sector_ic,
                "stock_rank_ic": float(np.mean(stock_ics)) if stock_ics else np.nan,
                "sector_count": int(len(sectors)),
                "stock_ic_sector_count": int(len(stock_ics)),
            }
        )
    return pd.DataFrame(rows)


def summarize_portfolios(observations: pd.DataFrame) -> pd.DataFrame:
    if observations.empty:
        return pd.DataFrame()
    return (
        observations.groupby(["window", "sampling", "horizon", "pool_type"], as_index=False)
        .agg(
            signal_date_count=("date", "nunique"),
            periods=("date", "count"),
            baseline_return_mean=("baseline_return", "mean"),
            industry_only_return_mean=("industry_only_return", "mean"),
            stock_only_return_mean=("stock_only_return", "mean"),
            double_return_mean=("double_return", "mean"),
            industry_excess_mean=("industry_excess", "mean"),
            stock_excess_mean=("stock_excess", "mean"),
            double_excess_mean=("double_excess", "mean"),
            stock_after_industry_excess_mean=("stock_after_industry_excess", "mean"),
            interaction_excess_mean=("interaction_excess", "mean"),
            industry_win_ratio=("industry_excess", lambda values: float((values > 0).mean())),
            stock_win_ratio=("stock_excess", lambda values: float((values > 0).mean())),
            double_win_ratio=("double_excess", lambda values: float((values > 0).mean())),
            stock_after_industry_win_ratio=("stock_after_industry_excess", lambda values: float((values > 0).mean())),
            avg_sector_count=("sector_count", "mean"),
        )
        .sort_values(["window", "sampling", "horizon", "pool_type"])
        .reset_index(drop=True)
    )


def summarize_ics(observations: pd.DataFrame) -> pd.DataFrame:
    if observations.empty:
        return pd.DataFrame()
    return (
        observations.groupby(["window", "sampling", "horizon", "pool_type"], as_index=False)
        .agg(
            periods=("date", "count"),
            industry_rank_ic_mean=("industry_rank_ic", "mean"),
            industry_rank_ic_positive_ratio=("industry_rank_ic", lambda values: float((values > 0).mean())),
            stock_rank_ic_mean=("stock_rank_ic", "mean"),
            stock_rank_ic_positive_ratio=("stock_rank_ic", lambda values: float((values > 0).mean())),
            avg_sector_count=("sector_count", "mean"),
            avg_stock_ic_sector_count=("stock_ic_sector_count", "mean"),
        )
        .sort_values(["window", "sampling", "horizon", "pool_type"])
        .reset_index(drop=True)
    )


def with_context(frame: pd.DataFrame, window: str, sampling: str, dates: pd.DatetimeIndex) -> pd.DataFrame:
    if frame.empty:
        return frame
    out = frame.copy()
    out.insert(0, "sampling", sampling)
    out.insert(0, "window", window)
    return out


def evaluate(
    panel: pd.DataFrame,
    windows: dict[str, pd.DatetimeIndex],
) -> tuple[pd.DataFrame, pd.DataFrame]:
    portfolio_frames: list[pd.DataFrame] = []
    ic_frames: list[pd.DataFrame] = []
    plans = [
        ("recent_60d", ["1d", "10d"]),
        ("latest_60d_anchor", ["60d"]),
        ("mature_60d", ["60d"]),
    ]
    for window, horizons in plans:
        if window not in windows:
            continue
        dates = windows[window]
        for horizon in horizons:
            samples = [("every_signal", dates)]
            if HORIZONS[horizon] > 1:
                samples.append((f"nonoverlap_{horizon}", non_overlapping_dates(dates, HORIZONS[horizon])))
            for sampling, sampled_dates in samples:
                selected = panel[panel["date"].isin(sampled_dates)].copy()
                portfolio_frames.append(with_context(portfolio_observations(selected, horizon), window, sampling, sampled_dates))
                ic_frames.append(with_context(ic_observations(selected, horizon), window, sampling, sampled_dates))

    def concat(frames: list[pd.DataFrame]) -> pd.DataFrame:
        usable = [frame for frame in frames if not frame.empty]
        return pd.concat(usable, ignore_index=True) if usable else pd.DataFrame()

    return concat(portfolio_frames), concat(ic_frames)


def evaluate_full_history(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Evaluate every available monthly signal in the long-history panel."""

    dates = pd.DatetimeIndex(panel["date"].unique()).sort_values()
    portfolio_frames: list[pd.DataFrame] = []
    ic_frames: list[pd.DataFrame] = []
    for horizon in ["20d", "60d"]:
        if f"future_return_{horizon}" not in panel.columns:
            continue
        samples = [("monthly_signal", dates)]
        if horizon == "60d":
            samples.append(("nonoverlap_60d_monthly", monthly_non_overlapping_dates(dates, HORIZONS[horizon])))
        for sampling, sampled_dates in samples:
            selected = panel[panel["date"].isin(sampled_dates)].copy()
            portfolio_frames.append(
                with_context(portfolio_observations(selected, horizon), "full_history", sampling, sampled_dates)
            )
            ic_frames.append(with_context(ic_observations(selected, horizon), "full_history", sampling, sampled_dates))

    def concat(frames: list[pd.DataFrame]) -> pd.DataFrame:
        usable = [frame for frame in frames if not frame.empty]
        return pd.concat(usable, ignore_index=True) if usable else pd.DataFrame()

    return concat(portfolio_frames), concat(ic_frames)


def format_portfolio_summary(frame: pd.DataFrame) -> pd.DataFrame:
    shown = frame.copy()
    percent_columns = [
        "baseline_return_mean",
        "industry_only_return_mean",
        "stock_only_return_mean",
        "double_return_mean",
        "industry_excess_mean",
        "stock_excess_mean",
        "double_excess_mean",
        "stock_after_industry_excess_mean",
        "interaction_excess_mean",
        "industry_win_ratio",
        "stock_win_ratio",
        "double_win_ratio",
        "stock_after_industry_win_ratio",
    ]
    for column in percent_columns:
        if column in shown:
            shown[column] = shown[column].map(pct)
    return shown


def format_ic_summary(frame: pd.DataFrame) -> pd.DataFrame:
    shown = frame.copy()
    for column in ["industry_rank_ic_mean", "stock_rank_ic_mean"]:
        if column in shown:
            shown[column] = shown[column].map(num)
    for column in ["industry_rank_ic_positive_ratio", "stock_rank_ic_positive_ratio"]:
        if column in shown:
            shown[column] = shown[column].map(pct)
    return shown


def build_report(
    portfolio_summary: pd.DataFrame,
    ic_summary: pd.DataFrame,
    latest_price_date: pd.Timestamp,
) -> str:
    headline_portfolios = portfolio_summary[portfolio_summary["sampling"].eq("every_signal")]
    headline_ics = ic_summary[ic_summary["sampling"].eq("every_signal")]
    if headline_portfolios.empty:
        headline_portfolios = portfolio_summary[
            ~portfolio_summary["sampling"].str.startswith("nonoverlap", na=False)
        ]
    if headline_ics.empty:
        headline_ics = ic_summary[~ic_summary["sampling"].str.startswith("nonoverlap", na=False)]
    robustness_portfolios = portfolio_summary[portfolio_summary["sampling"].str.startswith("nonoverlap", na=False)]
    return f"""# 行业趋势与个股排序拆分验证

数据截至 `{latest_price_date.date().isoformat()}`。本报告使用既有的可回溯价格代理面板，回答两个独立问题：行业趋势是否有前瞻价值，以及在已知行业后，个股排序是否还能带来额外价值。

## 拆分口径

- **行业信号**：`industry_trend_score_hist`，它是同一日期、同一行业内所有股票共享的历史行业趋势分。
- **个股信号**：既有 `historical_proxy_score` 在“日期-类型-行业”内的分位名次。行业趋势等共同项在行业内为常数，不能改变个股名次，因此该名次只检验原代理分中的个股排序信息。
- 每个组合都采用行业等权：先平均每个行业内股票收益，再平均行业收益，避免股票数量更多的行业主导结果。

## 四组组合及归因

| 组合 | 决策 |
| --- | --- |
| 基准 A | 所有行业、行业内全股票，行业等权 |
| B：仅行业 | 取行业趋势 Top 3，行业内全股票 |
| C：仅个股 | 所有行业中，各取行业内分位前 20% 股票 |
| D：双层 | 行业趋势 Top 3，再取行业内前 20% 股票 |

`B - A` 是行业趋势贡献；`C - A` 是个股排序贡献；`D - B` 是在已经选对行业后个股排序的增量。`D - B - C + A` 是二者交互项。金融池只有两个行业，无法形成真正的 Top 3 行业选择，因此其行业归因没有识别力。

## 组合收益与归因

{md_table(format_portfolio_summary(headline_portfolios), ['window', 'horizon', 'pool_type', 'signal_date_count', 'periods', 'baseline_return_mean', 'industry_only_return_mean', 'stock_only_return_mean', 'double_return_mean', 'industry_excess_mean', 'stock_excess_mean', 'double_excess_mean', 'stock_after_industry_excess_mean', 'industry_win_ratio', 'stock_win_ratio', 'stock_after_industry_win_ratio'])}

## 行业与个股 Rank IC

行业 Rank IC 在行业横截面计算；个股 Rank IC 先在每个行业内部计算，再在行业间等权平均。它们不能混用。

{md_table(format_ic_summary(headline_ics), ['window', 'horizon', 'pool_type', 'periods', 'industry_rank_ic_mean', 'industry_rank_ic_positive_ratio', 'stock_rank_ic_mean', 'stock_rank_ic_positive_ratio', 'avg_sector_count', 'avg_stock_ic_sector_count'])}

## 不重叠样本

多日未来收益会重叠。以下结果每隔持有期取一个信号日，样本更独立但数量更少。

{md_table(format_portfolio_summary(robustness_portfolios), ['window', 'sampling', 'horizon', 'pool_type', 'signal_date_count', 'periods', 'industry_excess_mean', 'stock_excess_mean', 'double_excess_mean', 'stock_after_industry_excess_mean', 'industry_win_ratio', 'stock_win_ratio', 'stock_after_industry_win_ratio'])}

## 限制

- 这里只检验可回溯的价格代理；成长质量、估值、行业空间尚缺逐期按披露日对齐的历史数据。
- 当前候选股票池和类型划分回溯使用，仍有幸存者与成员资格偏差。
- 这不是交易组合回测：未计交易成本、停牌、涨跌停、仓位与换手约束。
"""


def load_windows(path: Path) -> dict[str, pd.DatetimeIndex]:
    frame = pd.read_csv(path)
    frame["signal_date"] = pd.to_datetime(frame["signal_date"])
    return {
        str(window): pd.DatetimeIndex(group["signal_date"].sort_values().unique())
        for window, group in frame.groupby("window")
    }


def write_outputs(
    output_dir: Path,
    prepared_panel: pd.DataFrame,
    portfolio_observations_frame: pd.DataFrame,
    ic_observations_frame: pd.DataFrame,
    latest_price_date: pd.Timestamp,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    portfolio_summary = summarize_portfolios(portfolio_observations_frame)
    ic_summary = summarize_ics(ic_observations_frame)
    artifacts: list[Path] = []
    for name, frame in {
        "prepared_proxy_panel.csv": prepared_panel,
        "portfolio_observations.csv": portfolio_observations_frame,
        "portfolio_summary.csv": portfolio_summary,
        "ic_observations.csv": ic_observations_frame,
        "ic_summary.csv": ic_summary,
    }.items():
        path = output_dir / name
        frame.to_csv(path, index=False)
        artifacts.append(path)

    report_path = output_dir / "industry_stock_decomposition_report.md"
    report_path.write_text(build_report(portfolio_summary, ic_summary, latest_price_date), encoding="utf-8")
    artifacts.append(report_path)

    metadata_path = output_dir / "summary.json"
    metadata_path.write_text(
        json.dumps(
            {
                "validation": "industry_trend_stock_ranking_decomposition",
                "latest_local_price_date": latest_price_date.date().isoformat(),
                "top_sector_count": TOP_SECTOR_COUNT,
                "stock_top_percentile": TOP_STOCK_PERCENTILE,
                "weighting": "equal sector, then equal stock within sector",
                "artifacts": [path.name for path in artifacts],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    artifacts.append(metadata_path)

    zip_path = output_dir / "industry_stock_decomposition_outputs.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for artifact in artifacts:
            archive.write(artifact, arcname=artifact.name)
    return zip_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--panel", default=str(DEFAULT_PANEL))
    parser.add_argument("--windows", default=str(DEFAULT_WINDOWS))
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR))
    parser.add_argument(
        "--full-history",
        action="store_true",
        help="evaluate all monthly signals in a panel with future_return_20d and future_return_60d labels",
    )
    args = parser.parse_args()

    panel_path = output_path(args.panel)
    raw_panel = pd.read_csv(panel_path, dtype={"stock_code": str, "sector_code": str})
    prepared_panel = prepare_panel(raw_panel)
    if args.full_history:
        portfolio_frame, ic_frame = evaluate_full_history(prepared_panel)
    else:
        windows = load_windows(output_path(args.windows))
        portfolio_frame, ic_frame = evaluate(prepared_panel, windows)
    latest_price_date = prepared_panel["date"].max()
    zip_path = write_outputs(output_path(args.output_dir), prepared_panel, portfolio_frame, ic_frame, latest_price_date)

    print("Portfolio attribution summary")
    print(summarize_portfolios(portfolio_frame).to_string(index=False))
    print("\nIndustry and stock IC summary")
    print(summarize_ics(ic_frame).to_string(index=False))
    print(f"\nArtifacts written to: {output_path(args.output_dir)}")
    print(f"ZIP: {zip_path}")


if __name__ == "__main__":
    main()

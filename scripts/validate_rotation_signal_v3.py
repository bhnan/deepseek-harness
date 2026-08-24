#!/usr/bin/env python3
"""Validate a sector-rotation signal with a separate money-flow proxy.

The primary score is deliberately simple: medium/long-term relative strength
plus rank acceleration.  Signed amount is exposed as a confirmation feature,
not silently mixed into the production score.  This keeps the distinction
between a useful signal and a plausible story explicit.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BARS = ROOT / "data/rotation_benchmark/sector_daily_bars.csv"
DEFAULT_OUTPUT_DIR = ROOT / "lab/backtests/rotation_signal_v3"
DEFAULT_REPORT = ROOT / "docs/research/rotation-signal-v3-validation-20260821.md"


@dataclass(frozen=True)
class SignalConfig:
    momentum_window: int = 252
    skip_window: int = 20
    turn_fast_window: int = 20
    turn_slow_window: int = 60
    flow_short_window: int = 5
    flow_long_window: int = 20
    top_k: int = 5
    min_score: float = 0.80
    min_selected: int = 5
    rebalance_days: int = 20
    history_days: int = 300
    cost_bps: float = 20.0


def load_bars(path: str | Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    frame = pd.read_csv(path, parse_dates=["date"])
    frame = frame.sort_values(["date", "sector_id"])
    frame["sector_id"] = frame["sector_id"].astype(str)
    for column in ("open", "close", "amount"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    def pivot(column: str) -> pd.DataFrame:
        return frame.pivot_table(index="date", columns="sector_id", values=column, aggfunc="last").sort_index()

    # Only forward-fill short source gaps.  No backward fill is allowed because
    # it would introduce information that was unavailable on the signal date.
    close = pivot("close").ffill(limit=5)
    opening = pivot("open").ffill(limit=5)
    amount = pivot("amount").ffill(limit=5)
    return close, opening, amount


def rank_pct(panel: pd.DataFrame) -> pd.DataFrame:
    """Cross-sectional percentile where 1.0 means strongest/highest."""

    return panel.rank(axis=1, pct=True, method="average")


def signed_flow_ratio(close: pd.DataFrame, amount: pd.DataFrame, window: int) -> pd.DataFrame:
    """Estimate directional flow from daily price direction and turnover.

    This is a proxy.  It is not an actual account-level net flow and should not
    be interpreted as one.
    """

    daily_return = close.pct_change(fill_method=None)
    signed_amount = np.sign(daily_return).mul(amount)
    numerator = signed_amount.rolling(window, min_periods=max(3, window // 2)).sum()
    denominator = amount.rolling(window, min_periods=max(3, window // 2)).sum()
    return numerator.div(denominator.replace(0.0, np.nan))


def build_signal_panel(
    close: pd.DataFrame,
    amount: pd.DataFrame,
    config: SignalConfig | None = None,
) -> dict[str, pd.DataFrame]:
    """Build all signal fields using information available through each date."""

    cfg = config or SignalConfig()
    ret1 = close.pct_change(fill_method=None)
    ret_fast = close / close.shift(cfg.turn_fast_window) - 1.0
    ret_slow = close / close.shift(cfg.turn_slow_window) - 1.0
    momentum = close.shift(cfg.skip_window) / close.shift(cfg.momentum_window) - 1.0

    momentum_score = rank_pct(momentum)
    fast_rank = rank_pct(ret_fast)
    slow_rank = rank_pct(ret_slow)
    rank_turn = fast_rank - slow_rank
    turn_score = rank_pct(rank_turn)

    flow_short = signed_flow_ratio(close, amount, cfg.flow_short_window)
    flow_long = signed_flow_ratio(close, amount, cfg.flow_long_window)
    flow_acceleration = flow_short - flow_long
    flow_short_score = rank_pct(flow_short)
    flow_acceleration_score = rank_pct(flow_acceleration)
    flow_score = 0.60 * flow_short_score + 0.40 * flow_acceleration_score

    breadth_short = (ret1 > 0).rolling(cfg.flow_short_window, min_periods=3).mean()
    breadth_score = rank_pct(breadth_short)

    # Production candidate score.  The flow fields remain separate because
    # their incremental value must be demonstrated out of sample first.
    up_score = 0.70 * momentum_score + 0.30 * turn_score
    up_score_with_flow = 0.55 * up_score + 0.25 * flow_score + 0.20 * breadth_score
    down_score = 0.60 * momentum_score + 0.40 * (1.0 - turn_score)
    repair_score = 0.55 * (1.0 - momentum_score) + 0.45 * turn_score

    return {
        "momentum_score": momentum_score,
        "turn_score": turn_score,
        "up_score": up_score,
        "up_score_with_flow": up_score_with_flow,
        "down_score": down_score,
        "repair_score": repair_score,
        "flow_short": flow_short,
        "flow_long": flow_long,
        "flow_acceleration": flow_acceleration,
        "flow_score": flow_score,
        "breadth_score": breadth_score,
        "flow_confirmed": (flow_score >= 0.40).astype(float),
    }


def daily_candidates(
    signal_panel: dict[str, pd.DataFrame],
    as_of_date: str | pd.Timestamp,
    *,
    top_k: int = 5,
) -> dict[str, list[str] | str]:
    """Return ranked leader, repair and fading candidates for one date."""

    date = pd.Timestamp(as_of_date)
    scores = {name: panel.loc[date].dropna() for name, panel in signal_panel.items() if date in panel.index}
    required = {"up_score", "down_score", "repair_score", "flow_score"}
    if not required.issubset(scores):
        return {
            "as_of_date": date.date().isoformat(),
            "leaders": [],
            "repair_candidates": [],
            "fading_leaders": [],
            "candidate_pairs": [],
        }

    leaders = scores["up_score"].nlargest(top_k).index.astype(str).tolist()
    repairs = scores["repair_score"].nlargest(top_k).index.astype(str).tolist()
    fading = scores["down_score"].nlargest(top_k).index.astype(str).tolist()
    candidate_pairs = [
        {"old_sector_id": fading[0], "new_sector_id": leader}
        for leader in leaders
        if fading and leader != fading[0]
    ]
    return {
        "as_of_date": date.date().isoformat(),
        "leaders": leaders,
        "repair_candidates": repairs,
        "fading_leaders": fading,
        "candidate_pairs": candidate_pairs,
    }


def _date_mask(index: pd.DatetimeIndex, start: str, end: str) -> np.ndarray:
    return np.asarray((index >= pd.Timestamp(start)) & (index <= pd.Timestamp(end)), dtype=bool)


def _rank_ic(score: np.ndarray, target: np.ndarray) -> float:
    valid = np.isfinite(score) & np.isfinite(target)
    if valid.sum() < 10:
        return float("nan")
    left = pd.Series(score[valid]).rank(method="average").to_numpy(dtype=float)
    right = pd.Series(target[valid]).rank(method="average").to_numpy(dtype=float)
    if left.std() == 0.0 or right.std() == 0.0:
        return float("nan")
    return float(np.corrcoef(left, right)[0, 1])


def _rank_metrics(
    score: pd.DataFrame,
    target: pd.DataFrame,
    *,
    start: str,
    end: str,
    direction: float = 1.0,
) -> dict[str, float | int]:
    dates = score.index[_date_mask(score.index, start, end)]
    top_values: list[float] = []
    bottom_values: list[float] = []
    ic_values: list[float] = []
    for date in dates:
        current_score = score.loc[date].to_numpy(dtype=float)
        current_target = target.loc[date].to_numpy(dtype=float)
        valid = np.isfinite(current_score) & np.isfinite(current_target)
        if valid.sum() < 20:
            continue
        ic_values.append(_rank_ic(current_score, current_target) * direction)
        order = np.argsort(current_score[valid])[::-1]
        values = current_target[valid] * direction
        n = max(1, int(valid.sum() * 0.10))
        top_values.append(float(np.mean(values[order[:n]])))
        bottom_values.append(float(np.mean(values[order[-n:]])))

    if not ic_values:
        return {"observations": 0, "rank_ic": None, "positive_ic_ratio": None, "top_decile": None, "top_minus_bottom": None}
    top = np.asarray(top_values, dtype=float)
    bottom = np.asarray(bottom_values, dtype=float)
    ics = np.asarray(ic_values, dtype=float)
    return {
        "observations": int(len(ics)),
        "rank_ic": float(np.nanmean(ics)),
        "positive_ic_ratio": float(np.mean(ics > 0)),
        "top_decile": float(np.nanmean(top)),
        "top_minus_bottom": float(np.nanmean(top - bottom)),
    }


def evaluate_rank_signals(
    close: pd.DataFrame,
    signal_panel: dict[str, pd.DataFrame],
    *,
    splits: dict[str, tuple[str, str]] | None = None,
    horizons: Iterable[int] = (5, 10, 20),
) -> list[dict[str, object]]:
    splits = splits or {
        "train": ("2017-01-01", "2021-12-31"),
        "validation": ("2022-01-01", "2024-12-31"),
        "holdout": ("2025-01-01", "2026-06-30"),
        "full": ("2017-01-01", "2026-06-30"),
    }
    rows: list[dict[str, object]] = []
    score_directions = {"up_score": 1.0, "up_score_with_flow": 1.0, "down_score": -1.0}
    for horizon in horizons:
        future = close.shift(-horizon) / close - 1.0
        target = future.sub(future.median(axis=1), axis=0)
        for split_name, (start, end) in splits.items():
            for score_name, direction in score_directions.items():
                metrics = _rank_metrics(signal_panel[score_name], target, start=start, end=end, direction=direction)
                rows.append({"horizon": horizon, "split": split_name, "score": score_name, **metrics})
    return rows


def _portfolio_metrics(curve: pd.Series) -> dict[str, float | int]:
    curve = curve.dropna()
    if len(curve) < 2:
        return {"observations": int(len(curve)), "cagr": None, "max_drawdown": None}
    years = max((curve.index[-1] - curve.index[0]).days / 365.25, 1.0 / 252.0)
    cagr = float((curve.iloc[-1] / curve.iloc[0]) ** (1.0 / years) - 1.0)
    drawdown = curve / curve.cummax() - 1.0
    return {"observations": int(len(curve)), "cagr": cagr, "max_drawdown": float(drawdown.min())}


def backtest_top_k(
    opening: pd.DataFrame,
    score: pd.DataFrame,
    *,
    config: SignalConfig | None = None,
) -> pd.DataFrame:
    """Backtest close-signal -> next-open entry with periodic rebalancing."""

    cfg = config or SignalConfig()
    open_to_open = opening.shift(-1) / opening - 1.0
    curve_rows: list[dict[str, object]] = []
    nav = 1.0
    previous_weights: pd.Series | None = None
    last_index = len(score.index) - 2
    for signal_index in range(cfg.history_days, last_index, cfg.rebalance_days):
        current = score.iloc[signal_index].dropna()
        selected = current[current >= cfg.min_score].nlargest(cfg.top_k).index
        if len(selected) < cfg.min_selected:
            selected = pd.Index([], dtype=score.columns.dtype)
        weights = pd.Series(0.0, index=score.columns)
        if len(selected) >= cfg.min_selected:
            weights.loc[selected] = 1.0 / len(selected)
        turnover = float(weights.sum() if previous_weights is None else (weights - previous_weights).abs().sum())
        nav *= max(0.0, 1.0 - (cfg.cost_bps / 10000.0) * turnover)

        next_signal_index = min(signal_index + cfg.rebalance_days, last_index)
        holding = open_to_open.iloc[signal_index + 1 : next_signal_index + 1]
        if len(selected) >= cfg.min_selected and not holding.empty:
            daily_return = holding.loc[:, selected].mean(axis=1).fillna(0.0)
            nav *= float((1.0 + daily_return).prod())
        curve_rows.append({"date": score.index[signal_index], "nav": nav, "turnover": turnover})
        previous_weights = weights
    return pd.DataFrame(curve_rows).set_index("date") if curve_rows else pd.DataFrame(columns=["nav", "turnover"])


def backtest_equal_weight(opening: pd.DataFrame, *, config: SignalConfig | None = None) -> pd.DataFrame:
    """Equal-weight all available sectors on the same rebalance calendar."""

    cfg = config or SignalConfig()
    open_to_open = opening.shift(-1) / opening - 1.0
    curve_rows: list[dict[str, object]] = []
    nav = 1.0
    last_index = len(opening.index) - 2
    for signal_index in range(cfg.history_days, last_index, cfg.rebalance_days):
        next_signal_index = min(signal_index + cfg.rebalance_days, last_index)
        holding = open_to_open.iloc[signal_index + 1 : next_signal_index + 1]
        if not holding.empty:
            nav *= float((1.0 + holding.mean(axis=1).fillna(0.0)).prod())
        curve_rows.append({"date": opening.index[signal_index], "nav": nav, "turnover": 0.0})
    return pd.DataFrame(curve_rows).set_index("date") if curve_rows else pd.DataFrame(columns=["nav", "turnover"])


def evaluate_backtests(
    opening: pd.DataFrame,
    signal_panel: dict[str, pd.DataFrame],
    *,
    config: SignalConfig | None = None,
    splits: dict[str, tuple[str, str]] | None = None,
) -> list[dict[str, object]]:
    cfg = config or SignalConfig()
    splits = splits or {
        "train": ("2017-01-01", "2021-12-31"),
        "validation": ("2022-01-01", "2024-12-31"),
        "holdout": ("2025-01-01", "2026-06-30"),
        "full": ("2017-01-01", "2026-06-30"),
    }
    rows: list[dict[str, object]] = []
    benchmark_curve = backtest_equal_weight(opening, config=cfg)
    for split_name, (start, end) in splits.items():
        sample = benchmark_curve.loc[
            (benchmark_curve.index >= pd.Timestamp(start)) & (benchmark_curve.index <= pd.Timestamp(end)), "nav"
        ]
        metrics = _portfolio_metrics(sample)
        metrics.update({"score": "equal_weight_benchmark", "min_score": None, "split": split_name, "cost_bps": 0.0})
        rows.append(metrics)

    for score_name in ("up_score", "up_score_with_flow"):
        curve = backtest_top_k(opening, signal_panel[score_name], config=cfg)
        for split_name, (start, end) in splits.items():
            sample = curve.loc[(curve.index >= pd.Timestamp(start)) & (curve.index <= pd.Timestamp(end)), "nav"]
            metrics = _portfolio_metrics(sample)
            metrics["score"] = score_name
            metrics["min_score"] = cfg.min_score
            metrics["split"] = split_name
            metrics["cost_bps"] = cfg.cost_bps
            rows.append(metrics)

    # An ungated control shows whether the confidence threshold itself is
    # doing useful work, rather than allowing the report to compare only two
    # similarly tuned variants.
    control = replace(cfg, min_score=0.0, min_selected=cfg.top_k)
    curve = backtest_top_k(opening, signal_panel["up_score"], config=control)
    for split_name, (start, end) in splits.items():
        sample = curve.loc[(curve.index >= pd.Timestamp(start)) & (curve.index <= pd.Timestamp(end)), "nav"]
        metrics = _portfolio_metrics(sample)
        metrics.update({"score": "up_score_ungated", "min_score": 0.0, "split": split_name, "cost_bps": control.cost_bps})
        rows.append(metrics)
    return rows


def run_validation(
    bars_path: str | Path = DEFAULT_BARS,
    *,
    config: SignalConfig | None = None,
) -> dict[str, object]:
    cfg = config or SignalConfig()
    close, opening, amount = load_bars(bars_path)
    signal_panel = build_signal_panel(close, amount, cfg)
    rank_rows = evaluate_rank_signals(close, signal_panel)
    backtest_rows = evaluate_backtests(opening, signal_panel, config=cfg)
    stress_config = replace(cfg, cost_bps=max(50.0, cfg.cost_bps))
    stress_rows = [
        row
        for row in evaluate_backtests(opening, signal_panel, config=stress_config)
        if row["score"] == "up_score"
    ]
    return {
        "config": asdict(cfg),
        "data": {
            "rows": int(len(close.index)),
            "sectors": int(len(close.columns)),
            "start": close.index.min().date().isoformat(),
            "end": close.index.max().date().isoformat(),
        },
        "rank_metrics": rank_rows,
        "backtest_metrics": backtest_rows,
        "stress_backtest_metrics": stress_rows,
        "conclusion": {
            "production_score": "up_score",
            "flow_status": "confirmation_only_until_incremental_edge_is_stable",
            "label": "future_cross_sectional_excess_return",
        },
    }


def _fmt(value: object, digits: int = 4) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def render_report(result: dict[str, object]) -> str:
    data = result["data"]
    rank_rows = result["rank_metrics"]
    backtest_rows = result["backtest_metrics"]
    stress_rows = result["stress_backtest_metrics"]
    lines = [
        "# Rotation Signal v3 Validation",
        "",
        "This report separates a price/relative-strength signal from a daily signed-amount flow proxy.",
        "The flow proxy is not treated as institutional account flow.",
        "",
        f"- Data: `{data['start']}` to `{data['end']}`, `{data['sectors']}` sectors, `{data['rows']}` dates",
        "- Signal timing: close at T, entry at T+1 open",
        "- Production score: `0.70 * momentum_12m_skip20_score + 0.30 * rank_turn_score`, with score gate `>= 0.80` and at least 5 sectors",
        "- Flow proxy: `sign(daily_return) * amount`, smoothed into 5d/20d directional-flow ratios",
        "- Primary label: future sector return minus same-day cross-sectional median",
        "- Pair benchmark note: the dense event table is retained for diagnosis, but exact same-day pair matching is not the production objective",
        "",
        "## Rank Metrics",
        "",
        "| Horizon | Split | Score | Obs | Rank IC | Positive IC | Top decile excess | Top-bottom |",
        "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in rank_rows:
        lines.append(
            "| {h}d | {split} | `{score}` | {obs} | {ic} | {pos} | {top} | {spread} |".format(
                h=row["horizon"], split=row["split"], score=row["score"], obs=row["observations"],
                ic=_fmt(row["rank_ic"]), pos=_fmt(row["positive_ic_ratio"]),
                top=_fmt(row["top_decile"], 5), spread=_fmt(row["top_minus_bottom"], 5),
            )
        )
    lines.extend(
        [
            "",
            "## Costed Portfolio Replay",
            "",
            "| Split | Score | Gate | Cost (bps) | Obs | CAGR | Max drawdown |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for row in backtest_rows:
        lines.append(
            "| {split} | `{score}` | {gate} | {cost} | {obs} | {cagr} | {dd} |".format(
                split=row["split"], score=row["score"], gate=row["min_score"], cost=row["cost_bps"], obs=row["observations"],
                cagr=_fmt(row["cagr"], 4), dd=_fmt(row["max_drawdown"], 4),
            )
        )
    lines.extend(
        [
            "",
            "## Cost Stress: Production Score",
            "",
            "| Split | Cost (bps) | CAGR | Max drawdown |",
            "| --- | ---: | ---: | ---: |",
        ]
    )
    for row in stress_rows:
        lines.append(
            "| {split} | {cost} | {cagr} | {dd} |".format(
                split=row["split"], cost=row["cost_bps"], cagr=_fmt(row["cagr"], 4), dd=_fmt(row["max_drawdown"], 4)
            )
        )
    lines.extend(
        [
            "",
            "## Decision Rule",
            "",
            "- Use `up_score` as the primary ranking signal; require score `>= 0.80` for all five slots, otherwise hold cash rather than force a weak rotation.",
            "- Keep `flow_score` and `flow_confirmed` as a separate confirmation column until its holdout increment is stable.",
            "- Do not call the signed-amount proxy real capital inflow; Level-2 or ETF/fund-flow data would be required for that claim.",
            "- A strict bottom-fishing `repair_score` is diagnostic only. It is not promoted to the production entry score without independent evidence.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the v3 sector-rotation signal.")
    parser.add_argument("--bars", default=str(DEFAULT_BARS))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    parser.add_argument("--cost-bps", type=float, default=20.0)
    args = parser.parse_args()

    result = run_validation(args.bars, config=SignalConfig(cost_bps=args.cost_bps))
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(render_report(result), encoding="utf-8")
    print(json.dumps(result["conclusion"], ensure_ascii=False, indent=2))
    print(f"report={report_path}")
    print(f"summary={output_dir / 'summary.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

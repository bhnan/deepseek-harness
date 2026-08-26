"""Signal DSL 解释器（v1，测试点 S3）。

设计（生命周期 signal schema / 用户讨论共识）：
- 表达式结构：叶子 {metric, args, op, value}；组合节点 {operator: AND/OR/NOT, conditions: []}
- v0 股票类 metric（个股池）：
     指标条件：return（N 日收益）、ma_ratio（收盘/MA(N)-1）
     横截面：rank（N 日收益在股票池中的分位，1=最强）
     事件条件：notice_date（最新披露日 ≤ 决策日的财务字段存在性，1/0）
- v1 板块类 metric（板块池，视图需装载 sector_prices/sector_amounts）：
     sector_rank(N)：N 日收益在板块横截面的分位（1=最强）
     sector_slope(N)：N 日收盘线性回归斜率（归一化到起点价）
     amount_ratio(N)：近 N 日均成交额 / 近 4N 日均成交额（放量比）
     up_closes(N)：最近 N 日中收阳天数（close > prev_close）
     drawdown_recovered(N)：从近 N 日区间低点的修复比例（0~1）
- 语法护栏：未知 metric 报错；window ≤ 0（含负数=未来引用）解析即拒；求值只能走 as_of 视图
"""
from __future__ import annotations

import pandas as pd

ALLOWED_METRICS = {"return", "ma_ratio", "rank", "notice_date",
                   "sector_rank", "sector_slope", "amount_ratio", "up_closes",
                   "drawdown_recovered", "slope_decay", "slope_repair"}
ALLOWED_OPS = {">", "<", ">=", "<=", "==", "!=", "cross_above", "cross_below"}


class DSLValidationError(Exception):
    """表达式非法（含未来引用）——解析期 fail-fast。"""


def validate(expression: dict) -> None:
    """语法 + 未来引用拦截。非法抛 DSLValidationError。"""
    if not isinstance(expression, dict):
        raise DSLValidationError(f"表达式必须是对象: {expression!r}")
    if "operator" in expression:
        op = expression["operator"]
        if op not in ("AND", "OR", "NOT"):
            raise DSLValidationError(f"未知逻辑操作符: {op}")
        conds = expression.get("conditions")
        if not isinstance(conds, list) or not conds:
            raise DSLValidationError(f"{op} 需要非空 conditions 数组")
        for c in conds:
            validate(c)
        return
    metric = expression.get("metric")
    if metric not in ALLOWED_METRICS:
        raise DSLValidationError(f"未知 metric: {metric}（允许: {sorted(ALLOWED_METRICS)}）")
    op = expression.get("op")
    if op not in ALLOWED_OPS:
        raise DSLValidationError(f"未知比较操作符: {op}")
    if "value" not in expression:
        raise DSLValidationError("叶子条件缺少 value")
    args = expression.get("args") or {}
    window = args.get("window")
    if window is not None:
        if not isinstance(window, (int, float)) or window <= 0:
            raise DSLValidationError(f"window 必须为正整数（负数/零 = 未来引用，非法）: {window}")
        if window != int(window):
            raise DSLValidationError(f"window 必须为整数: {window}")
    for k in ("fast", "slow"):
        if k in args:
            v = args[k]
            if not isinstance(v, (int, float)) or v <= 0 or v != int(v):
                raise DSLValidationError(f"{k} 必须为正整数（未来引用拦截）: {v}")
    return


def _leaf_value(expression: dict, view, symbol: str, universe: list[str]) -> float:
    metric = expression["metric"]
    args = expression.get("args") or {}
    window = int(args.get("window", 1))
    # 板块类指标：基于视图的板块数据（与股票池无关，先分发避免被股票 closes 拦截）
    if metric in ("sector_rank", "sector_slope", "amount_ratio", "up_closes",
                  "drawdown_recovered", "slope_decay", "slope_repair"):
        return _sector_leaf_value(expression, view, symbol)
    closes = view.prices()
    if symbol not in closes.columns:
        return float("nan")
    series = closes[symbol].dropna()
    if metric == "return":
        if len(series) < window + 1:
            return float("nan")   # 历史不足：信号不成立
        return float(series.iloc[-1] / series.iloc[-1 - window] - 1.0)
    if metric == "ma_ratio":
        if len(series) < window:
            return float("nan")
        return float(series.iloc[-1] / series.iloc[-window:].mean() - 1.0)
    if metric == "rank":
        # 横截面：N 日收益在股票池中的分位（1=最强）
        values = {}
        for s in (universe or list(closes.columns)):
            s_series = closes[s].dropna()
            if len(s_series) < window + 1:
                continue
            values[s] = float(s_series.iloc[-1] / s_series.iloc[-1 - window] - 1.0)
        if not values or symbol not in values:
            return float("nan")
        ranked = pd.Series(values).rank(pct=True)
        return float(ranked[symbol])
    if metric == "notice_date":
        # 事件条件：披露日 ≤ 决策日 的财务字段存在 → 1，否则 0（PIT 对齐，护栏 L1）
        field = args.get("field")
        if not field:
            raise DSLValidationError("notice_date 需要 args.field")
        return 1.0 if view.financials(symbol, field) is not None else 0.0
    raise DSLValidationError(f"未知 metric: {metric}")


def _sector_leaf_value(expression: dict, view, symbol: str) -> float:
    """板块类指标求值（基于视图的 sector_prices/sector_amounts，物理隔离由视图保证）。
    同一视图（决策日）内按 (metric,args,symbol) memo——回测 2500 天 × 31 板块 × 多指标时
    避免重复计算横截面（sector_rank 全池重算是主要开销，按 pool 一次算完）。"""
    cache = getattr(view, "_sector_metric_cache", None)
    if cache is None:
        cache = {}
        try:
            view._sector_metric_cache = cache
        except Exception:
            pass
    args = expression.get("args") or {}
    if expression["metric"] == "sector_rank":
        pool_key = ("sector_rank_pool", str(sorted(args.items())))
        if pool_key not in cache:
            cache[pool_key] = _sector_rank_pool(view, int(args.get("window", 1)))
        return cache[pool_key].get(symbol, float("nan"))
    key = (expression["metric"], str(sorted(args.items())), symbol)
    if key in cache:
        return cache[key]
    value = _sector_leaf_value_raw(expression, view, symbol)
    cache[key] = value
    return value


def _sector_rank_pool(view, window: int) -> dict:
    """一次计算全部板块的 N 日收益横截面分位（1=最强）。"""
    closes = view.sector_prices()
    if closes is None:
        return {}
    values = {}
    for s in closes.columns:
        s_series = closes[s].dropna()
        if len(s_series) < window + 1:
            continue
        values[s] = float(s_series.iloc[-1] / s_series.iloc[-1 - window] - 1.0)
    if not values:
        return {}
    ranked = pd.Series(values).rank(pct=True)
    return {s: float(ranked[s]) for s in values}


def _sector_leaf_value_raw(expression: dict, view, symbol: str) -> float:
    """板块类指标实际计算。"""
    metric = expression["metric"]
    args = expression.get("args") or {}
    window = int(args.get("window", 1))
    closes = view.sector_prices()
    if closes is None or symbol not in closes.columns:
        return float("nan")
    series = closes[symbol].dropna()
    if len(series) < window + 1:
        return float("nan")
    if metric == "sector_rank":
        return _sector_rank_pool(view, window).get(symbol, float("nan"))
    if metric == "sector_slope":
        # 最近 window 日收盘线性回归斜率 / 起点价（归一化，量纲=每日相对变动）
        y = series.iloc[-window:].astype(float)
        x = pd.Series(range(len(y)), index=y.index)
        slope = float((x - x.mean()).dot(y - y.mean()) / ((x - x.mean()) ** 2).sum())
        base = float(y.iloc[0])
        return slope / base if base else float("nan")
    if metric == "amount_ratio":
        amounts = view.sector_amounts()
        if amounts is None or symbol not in amounts.columns:
            return float("nan")
        a_series = amounts[symbol].dropna()
        if len(a_series) < window * 5:
            return float("nan")
        recent = float(a_series.iloc[-window:].mean())
        base = float(a_series.iloc[-window * 4:].mean())
        return recent / base if base else float("nan")
    if metric == "up_closes":
        # 最近 window 日收阳天数（close > prev_close）
        diff = series.iloc[-window:].diff()
        return float((diff > 0).sum())
    if metric == "drawdown_recovered":
        # 从近 window 日区间低点的修复比例：0=还在低点，1=回到区间高点
        seg = series.iloc[-window:]
        lo, hi = float(seg.min()), float(seg.max())
        if hi == lo:
            return 1.0
        return float((float(seg.iloc[-1]) - lo) / (hi - lo))
    if metric in ("slope_decay", "slope_repair"):
        # 布尔动量关系（忠实 v001：5日斜率 vs 20日斜率）
        fast = int(args.get("fast", 5))
        slow = int(args.get("slow", 20))
        if len(series) < slow + 1:
            return float("nan")
        def slope(n):
            y = series.iloc[-n:].astype(float)
            x = pd.Series(range(len(y)), index=y.index)
            s = float((x - x.mean()).dot(y - y.mean()) / ((x - x.mean()) ** 2).sum())
            return s / float(y.iloc[0]) if y.iloc[0] else float("nan")
        f, s = slope(fast), slope(slow)
        if f != f or s != s:
            return float("nan")
        return 1.0 if (f < s if metric == "slope_decay" else f > s) else 0.0
    raise DSLValidationError(f"未知板块 metric: {metric}")


def _compare(left: float, op: str, right) -> bool:
    if left != left:  # NaN
        return False
    try:
        right = float(right)
    except (TypeError, ValueError):
        return False
    return {
        ">": left > right, "<": left < right, ">=": left >= right,
        "<=": left <= right, "==": left == right, "!=": left != right,
    }[op]


def evaluate(expression: dict, view, symbol: str, universe: list[str] | None = None) -> bool:
    """对单标的求值。解析失败抛 DSLValidationError；数据不足返回 False（不静默为真）。"""
    validate(expression)
    if "operator" in expression:
        op = expression["operator"]
        conds = [evaluate(c, view, symbol, universe) for c in expression["conditions"]]
        if op == "AND":
            return all(conds)
        if op == "OR":
            return any(conds)
        return not conds[0]   # NOT（v0 单条件）
    return _compare(_leaf_value(expression, view, symbol, universe),
                    expression["op"], expression["value"])


def scan(expression: dict, view, symbols: list[str]) -> list[str]:
    """对整个股票池扫描，返回满足条件的标的清单（策略函数可直接用）。"""
    validate(expression)
    return [s for s in symbols if evaluate(expression, view, s, symbols)]

"""Signal DSL 测试（测试点 S3）。

覆盖：三类表达式求值 / AND-OR-NOT 嵌套 / rank 横截面 / notice_date PIT 联动 /
负例（未来引用、未知 metric、历史不足）。
"""
import unittest

import pandas as pd

from backtest.data import MarketData
from backtest.dsl import DSLValidationError, evaluate, scan, validate

D0, D1, D2 = (pd.Timestamp("2026-04-14"), pd.Timestamp("2026-04-15"),
              pd.Timestamp("2026-04-16"))


def make_view(day=D2):
    closes = pd.DataFrame(
        {"X": [10.0, 10.5, 11.0], "Y": [20.0, 20.0, 20.0], "Z": [5.0, 4.5, 4.0]},
        index=[D0, D1, D2])
    notices = pd.DataFrame([{"symbol": "X", "report_period": "2026Q1",
                             "notice_date": D1, "eps": 0.58}])
    return MarketData(closes, None, notices).as_of(day)


class DslTest(unittest.TestCase):

    def test_return_condition(self):
        v = make_view()
        expr = {"metric": "return", "args": {"window": 1}, "op": ">", "value": 0.04}
        self.assertTrue(evaluate(expr, v, "X"))    # 11.0/10.5-1 = 0.0476
        self.assertFalse(evaluate(expr, v, "Z"))   # 负收益

    def test_ma_ratio(self):
        v = make_view()
        expr = {"metric": "ma_ratio", "args": {"window": 2}, "op": ">", "value": 0.0}
        self.assertTrue(evaluate(expr, v, "X"))    # 11.0 / mean(10.5,11.0) - 1 > 0

    def test_rank_cross_sectional(self):
        v = make_view()
        # 近 1 日收益：X +4.76%、Y 0%、Z -11.1% → X 分位最高
        expr = {"metric": "rank", "args": {"window": 1}, "op": ">=", "value": 0.66}
        self.assertTrue(evaluate(expr, v, "X", ["X", "Y", "Z"]))
        self.assertFalse(evaluate(expr, v, "Z", ["X", "Y", "Z"]))

    def test_notice_date_pit(self):
        v1 = make_view(day=D1)
        expr = {"metric": "notice_date", "args": {"field": "eps"}, "op": "==", "value": 1}
        self.assertTrue(evaluate(expr, v1, "X"), "披露日当天收盘后可得")
        v0 = make_view(day=D0)
        self.assertFalse(evaluate(expr, v0, "X"), "披露日前不可得（PIT 拦截未来函数）")

    def test_and_or_not(self):
        v = make_view()
        expr = {"operator": "AND", "conditions": [
            {"metric": "return", "args": {"window": 1}, "op": ">", "value": 0},
            {"metric": "ma_ratio", "args": {"window": 2}, "op": ">", "value": 0}]}
        self.assertTrue(evaluate(expr, v, "X"))
        expr_or = {"operator": "OR", "conditions": [
            {"metric": "return", "args": {"window": 1}, "op": ">", "value": 0},
            {"metric": "return", "args": {"window": 1}, "op": ">", "value": 5}]}
        self.assertTrue(evaluate(expr_or, v, "X"))
        expr_not = {"operator": "NOT", "conditions": [
            {"metric": "return", "args": {"window": 1}, "op": ">", "value": 0}]}
        self.assertTrue(evaluate(expr_not, v, "Z"))

    def test_scan(self):
        v = make_view()
        expr = {"metric": "return", "args": {"window": 1}, "op": ">", "value": 0}
        self.assertEqual(scan(expr, v, ["X", "Y", "Z"]), ["X"], "Y 平盘收益 0 不满足 >0")

    def test_negative_window_rejected(self):
        with self.assertRaises(DSLValidationError):
            validate({"metric": "return", "args": {"window": -1}, "op": ">", "value": 0})
        with self.assertRaises(DSLValidationError):
            validate({"metric": "return", "args": {"window": 0}, "op": ">", "value": 0})

    def test_unknown_metric_rejected(self):
        with self.assertRaises(DSLValidationError):
            validate({"metric": "future_sight", "op": ">", "value": 0})
        with self.assertRaises(DSLValidationError):
            validate({"operator": "XOR", "conditions": [{"metric": "return", "op": ">", "value": 0}]})

    def test_insufficient_history_false(self):
        v = make_view()
        expr = {"metric": "return", "args": {"window": 5}, "op": ">", "value": 0}
        self.assertFalse(evaluate(expr, v, "X"), "历史不足必须为 False，不得静默为 True")


if __name__ == "__main__":
    unittest.main()


def make_sector_view():
    """板块数据：A=前期强近期衰（疲劳候选），B=前期弱近期修复，C=平淡。"""
    dates = pd.date_range("2026-01-01", periods=30, freq="B")
    A, B, C = [100.0], [50.0], [80.0]
    for i in range(29):
        A.append(A[-1] * (1 + (0.02 if i < 15 else -0.01)))    # 先涨后跌
        B.append(B[-1] * (1 + (-0.015 if i < 15 else 0.02)))   # 先跌后涨
        C.append(C[-1] * 1.001)                                # 平淡
    sc = pd.DataFrame({"A": A, "B": B, "C": C}, index=dates)
    sa = pd.DataFrame({s: [1e9] * 30 for s in ["A", "B", "C"]}, index=dates)
    md = MarketData(pd.DataFrame(index=dates), sector_closes=sc, sector_amounts=sa)
    return md.as_of(dates[-1])


class SectorDslTest(unittest.TestCase):
    """v1 板块类指标：轮动策略（疲劳/修复）的 DSL 基础。"""

    def test_sector_rank_cross_sectional(self):
        v = make_sector_view()
        # 近 10 日收益：B 最强（先跌后涨的修复段）、C 次之、A 最弱（先涨后跌的衰退段）
        rank_b = {"metric": "sector_rank", "args": {"window": 10}, "op": ">=", "value": 0.66}
        self.assertTrue(evaluate(rank_b, v, "B", ["A", "B", "C"]))
        self.assertFalse(evaluate(rank_b, v, "A", ["A", "B", "C"]))

    def test_sector_slope_decline_and_recover(self):
        v = make_sector_view()
        # A：5 日斜率 < 10 日斜率（涨势衰减）
        expr = {"operator": "AND", "conditions": [
            {"metric": "sector_slope", "args": {"window": 5}, "op": "<", "value": 1e9},
            {"metric": "sector_slope", "args": {"window": 5}, "op": "<",
             "value": 0.0}]}
        self.assertTrue(evaluate(expr, v, "A", ["A", "B", "C"]), "A 近期斜率为负")

    def test_up_closes_and_drawdown_recovered(self):
        v = make_sector_view()
        # B：3 日内 ≥2 根阳线 且 10 日回撤修复 ≥ 0.3
        expr = {"operator": "AND", "conditions": [
            {"metric": "up_closes", "args": {"window": 3}, "op": ">=", "value": 2},
            {"metric": "drawdown_recovered", "args": {"window": 10}, "op": ">=", "value": 0.3}]}
        self.assertTrue(evaluate(expr, v, "B", ["A", "B", "C"]))
        self.assertFalse(evaluate(expr, v, "A", ["A", "B", "C"]), "A 仍在低点（修复=0）")

    def test_amount_ratio_flat(self):
        v = make_sector_view()
        expr = {"metric": "amount_ratio", "args": {"window": 5}, "op": "<=", "value": 1.25}
        self.assertTrue(evaluate(expr, v, "A", ["A", "B", "C"]))

    def test_sector_metrics_without_sector_data_are_nan(self):
        v = make_view()   # 无板块数据
        expr = {"metric": "sector_rank", "args": {"window": 5}, "op": ">=", "value": 0.8}
        self.assertFalse(evaluate(expr, v, "X", ["X"]))

    def test_sector_metrics_validate_window(self):
        with self.assertRaises(DSLValidationError):
            validate({"metric": "sector_rank", "args": {"window": 0}, "op": ">=", "value": 0.8})
        with self.assertRaises(DSLValidationError):
            validate({"metric": "sector_slope", "op": ">>", "value": 0})   # 未知 op

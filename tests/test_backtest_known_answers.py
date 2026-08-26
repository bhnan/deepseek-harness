"""回测引擎已知答案测试（护栏文档 §3.5 + 测试点 S2）。

TDD：这些测试在引擎实现前定义，引擎必须让它们转绿——任何未来函数/误成交/虚假盈亏
都会在这里暴露。测试数据为手工构造的已知答案场景。
"""
import unittest

import pandas as pd

from backtest.data import MarketData
from backtest.engine import BacktestEngine, GuardrailError

D0, D1, D2, D3 = (pd.Timestamp("2026-04-14"), pd.Timestamp("2026-04-15"),
                   pd.Timestamp("2026-04-16"), pd.Timestamp("2026-04-17"))


def frame(days, cols):
    return pd.DataFrame(cols, index=days)


class KnownAnswerTest(unittest.TestCase):

    # ---------- 案例 1：PEAD 公告次日跳空 ----------
    def test_pead_gap_not_banked(self):
        """公告 t 日晚间披露 → t+1 高开 11.0（恰好=涨停价）。双重护栏同时生效：
        成交只能发生在 t+1 开盘（而非信号日收盘），且涨停价买入被拒——跳空收益不得被吃掉。"""
        closes = frame([D0, D1, D2], {"X": [10.0, 10.0, 11.5]})
        opens = frame([D0, D1, D2], {"X": [10.0, 10.0, 11.0]})
        notices = pd.DataFrame([{"symbol": "X", "report_period": "2026Q1",
                                 "notice_date": D1, "eps": 0.58}])
        data = MarketData(closes, opens, notices)

        def strategy(view, day):
            return ["X"] if view.financials("X", "eps") is not None else []

        result = BacktestEngine(data).run(strategy, D0, D2)
        filled = [t for t in result.trades if t.side == "buy" and t.reason == "filled"]
        rejected = [t for t in result.trades if t.reason == "limit_up_rejected"]
        self.assertEqual(filled, [], "跳空开盘恰为涨停价（11.0 ≥ 昨收×1.1）→ 必须拒单，不得按信号日收盘 10.0 成交")
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0].date, D2, "拒单发生在 t+1 开盘，而非信号日")

    def test_pead_gap_entry_open(self):
        """案例 1b：开盘 10.5（未涨停），验证成交价 = t+1 开盘价、跳空不记入策略收益。"""
        closes = frame([D0, D1, D2], {"X": [10.0, 10.0, 11.5]})
        opens = frame([D0, D1, D2], {"X": [10.0, 10.0, 10.5]})
        notices = pd.DataFrame([{"symbol": "X", "report_period": "2026Q1",
                                 "notice_date": D1, "eps": 0.58}])
        data = MarketData(closes, opens, notices)

        def strategy(view, day):
            return ["X"] if view.financials("X", "eps") is not None else []

        result = BacktestEngine(data).run(strategy, D0, D2)
        buy = [t for t in result.trades if t.side == "buy"][0]
        self.assertEqual(buy.price, 10.5, "成交价 = t+1 开盘价（已含跳空），跳空段收益不归策略")
        # 收益 = 买入 10.5 → 收盘 11.5，扣除买入佣金；不含 10.0 → 10.5 的跳空段
        self.assertAlmostEqual(result.equity.iloc[-1], (1 - 0.0005) * (11.5 / 10.5), places=4)

    # ---------- 案例 2：涨停封板 ----------
    def test_limit_up_buy_rejected(self):
        """t+1 开盘 = 涨停价（昨收×1.1）→ 买入拒单；次日未涨停才成交。"""
        closes = frame([D0, D1, D2], {"X": [10.0, 11.0, 11.0]})  # D1 涨停收盘 11.0
        opens = frame([D0, D1, D2], {"X": [10.0, 11.0, 11.5]})   # D1 开=涨停价 11.0
        data = MarketData(closes, opens)

        def strategy(view, day):
            return ["X"] if day >= D0 else []

        result = BacktestEngine(data).run(strategy, D0, D2)
        rejected = [t for t in result.trades if t.reason == "limit_up_rejected"]
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0].date, D1, "涨停日买入必须被拒")
        buys = [t for t in result.trades if t.side == "buy" and t.reason == "filled"]
        self.assertEqual(len(buys), 1)
        self.assertEqual(buys[0].date, D2, "顺延至下一交易日成交")

    # ---------- 案例 3：停牌复牌 ----------
    def test_suspend_no_fake_pnl(self):
        """D1 停牌（无行情行）：买入顺延、不产生虚假盈亏；D2 复牌以开盘价成交。"""
        closes = frame([D0, D1, D2], {"X": [10.0, float("nan"), 12.0]})
        opens = frame([D0, D1, D2], {"X": [10.0, float("nan"), 12.0]})
        data = MarketData(closes, opens)

        def strategy(view, day):
            return ["X"]

        result = BacktestEngine(data).run(strategy, D0, D2)
        skipped = [t for t in result.trades if t.reason == "suspended_skipped"]
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0].date, D1, "停牌日委托顺延，不成交")
        self.assertAlmostEqual(result.equity.iloc[1], 1.0, places=6, msg="停牌日不产生虚假盈亏")
        buy = [t for t in result.trades if t.side == "buy" and t.reason == "filled"][0]
        self.assertEqual(buy.date, D2)
        self.assertEqual(buy.price, 12.0)

    # ---------- 案例 4：财报真空期（PIT） ----------
    def test_financial_vacuum_period(self):
        notices = pd.DataFrame([{"symbol": "X", "report_period": "2026Q1",
                                 "notice_date": D2, "eps": 0.58}])
        closes = frame([D0, D1, D2], {"X": [10.0, 10.0, 10.0]})
        data = MarketData(closes, None, notices)
        v1 = data.as_of(D1)   # 披露日前一天
        self.assertIsNone(v1.financials("X", "eps"), "披露日前取不到该报告期数据（未来函数拦截）")
        v2 = data.as_of(D2)   # 披露日当天（收盘后可得）
        self.assertEqual(v2.financials("X", "eps"), 0.58)

    # ---------- as_of 物理隔离 ----------
    def test_as_of_physical_isolation(self):
        closes = frame([D0, D1, D2], {"X": [10.0, 11.0, 12.0]})
        data = MarketData(closes)
        view = data.as_of(D1)
        self.assertEqual(view.prices().index.max(), D1, "视图中不存在未来行")
        with self.assertRaises(KeyError):
            view.close("X", D2)
        with self.assertRaises(KeyError):
            view.close("X", pd.Timestamp("2026-04-30"))

    # ---------- 两阶段时间轴（结构性质） ----------
    def test_t_plus_1_structural(self):
        """信号日买入 → 最早次日开盘成交；卖出日严格晚于买入日。"""
        closes = frame([D0, D1, D2, D3], {"X": [10.0, 10.5, 11.0, 11.5]})
        opens = frame([D0, D1, D2, D3], {"X": [10.0, 10.6, 11.1, 11.6]})
        data = MarketData(closes, opens)

        def strategy(view, day):
            if day == D0:
                return ["X"]
            if day == D2:
                return []
            return ["X"]

        result = BacktestEngine(data).run(strategy, D0, D3)
        buys = [t for t in result.trades if t.side == "buy" and t.reason == "filled"]
        sells = [t for t in result.trades if t.side == "sell" and t.reason == "filled"]
        self.assertEqual(buys[0].date, D1, "D0 信号 → D1 开盘买入")
        self.assertEqual(sells[0].date, D3, "D2 信号 → D3 开盘卖出")
        self.assertGreater(sells[0].date, buys[0].date, "卖出日必须晚于买入日（T+1）")

    # ---------- fail-fast ----------
    def test_t_plus_1_violation_raises(self):
        engine = BacktestEngine.__new__(BacktestEngine)
        held = {"X": (pd.Timestamp("2026-04-16"), 10.0)}
        with self.assertRaises(GuardrailError):
            BacktestEngine.assert_t_plus_1(held, ["X"], pd.Timestamp("2026-04-16"))
        BacktestEngine.assert_t_plus_1(held, ["X"], pd.Timestamp("2026-04-17"))  # 次日卖出合法

    # ---------- 可复现性 ----------
    def test_reproducible(self):
        closes = frame([D0, D1, D2, D3], {"X": [10.0, 10.5, 11.0, 11.5],
                                          "Y": [20.0, 19.5, 20.2, 20.8]})
        data1 = MarketData(closes.copy())
        data2 = MarketData(closes.copy())

        def strategy(view, day):
            return ["X"]

        r1 = BacktestEngine(data1).run(strategy, D0, D3)
        r2 = BacktestEngine(data2).run(strategy, D0, D3)
        pd.testing.assert_series_equal(r1.equity, r2.equity, check_exact=True,
                                       obj="同一实验两次运行结果必须逐位一致")
        self.assertEqual(r1.guardrails["leak_check"], True)


if __name__ == "__main__":
    unittest.main()

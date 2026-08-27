"""前向跟踪纯逻辑测试（测试点 S5）：种子落盘 / 收益计算 / 未到期不产出 / 快照 schema 校验。"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from pipeline import tracking
from pipeline.tracking import TRACKING_DIR, compute_tracking, grade, seed


class TrackingTest(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp())
        self._old = TRACKING_DIR
        tracking.TRACKING_DIR = self._tmp

    def tearDown(self):
        tracking.TRACKING_DIR = self._old
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_seed_and_compute(self):
        p = seed("exp_001", "2026-08-17", [{"symbol": "sh600001", "name": "A"},
                                           {"symbol": "sz000002", "name": "B"}])
        self.assertTrue(p.exists())
        pending = json.loads(p.read_text(encoding="utf-8"))
        self.assertFalse(pending["graded"])
        data = compute_tracking({"A": 0.05, "B": -0.03}, benchmark_return=0.01)
        self.assertAlmostEqual(data["mean_return"], 0.01, places=6)
        self.assertAlmostEqual(data["mean_relative_return"], 0.0, places=6)
        self.assertEqual(data["sample_count"], 2)

    def _data(self, n=30):
        dates = pd.date_range("2026-06-01", periods=n, freq="B")
        closes_by = {"sh600001": pd.Series([10 + i * 0.1 for i in range(n)], index=dates)}
        bench = pd.Series([100 + i * 0.2 for i in range(n)], index=dates)
        return closes_by, bench

    def test_grade_produces_valid_snapshot(self):
        closes_by, bench = self._data(30)
        obs = closes_by["sh600001"].index[5]           # 观察日
        seed("exp_001", obs.strftime("%Y-%m-%d"), [{"symbol": "sh600001"}])
        outs = grade("exp_001", obs.strftime("%Y-%m-%d"), closes_by, bench,
                     horizons=(5,), asof=closes_by["sh600001"].index[-1].strftime("%Y-%m-%d"))
        self.assertEqual(len(outs), 1, "t5 窗口应已到期产出")
        snap = json.loads(outs[0].read_text(encoding="utf-8"))
        self.assertEqual(snap["horizon_trading_days"], 5)
        self.assertIn("mean_return", snap)
        self.assertIn("grade_summary", snap)

    def test_grade_not_due_keeps_pending(self):
        closes_by, bench = self._data(30)
        obs = closes_by["sh600001"].index[-3]          # 只剩 2 个交易日 → t5 未到期
        seed("exp_001", obs.strftime("%Y-%m-%d"), [{"symbol": "sh600001"}])
        outs = grade("exp_001", obs.strftime("%Y-%m-%d"), closes_by, bench,
                     horizons=(5,), asof=closes_by["sh600001"].index[-1].strftime("%Y-%m-%d"))
        self.assertEqual(outs, [], "未到期不得产出（诚实：等待数据，不编造）")


if __name__ == "__main__":
    unittest.main()

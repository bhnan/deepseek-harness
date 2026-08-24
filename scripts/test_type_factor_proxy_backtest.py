#!/usr/bin/env python3
"""Behavior tests for the type-factor price-proxy backtest."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import backtest_type_factor_proxy_v1 as subject  # noqa: E402


class TypeFactorProxyBacktestTests(unittest.TestCase):
    def test_a_threshold_selection_is_equal_weight_and_excludes_illiquid_names(self) -> None:
        snapshot = pd.DataFrame(
            {
                "stock_code": ["000001", "000002", "000003", "000004", "000005", "000006"],
                "historical_proxy_score": [0.10, 0.20, 0.30, 0.40, 0.50, 0.99],
                "avg_amount_20d_hist": [30_000_000] * 5 + [1_000_000],
            }
        )

        weights = subject.build_a_target(snapshot, min_avg_amount=20_000_000, a_percentile=0.80)

        self.assertEqual(weights[weights > 0].index.tolist(), ["000004", "000005"])
        self.assertAlmostEqual(weights.loc["000004"], 0.5)
        self.assertAlmostEqual(weights.loc["000005"], 0.5)
        self.assertNotIn("000006", weights[weights > 0].index)

    def test_new_selection_does_not_capture_signal_to_execution_return_and_cost_hits_execution_day(self) -> None:
        dates = pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"])
        close = pd.DataFrame({"000001": [100.0, 110.0, 121.0, 121.0]}, index=dates)
        signal_targets = pd.DataFrame({"000001": [1.0]}, index=pd.to_datetime(["2024-01-02"]))

        run = subject.simulate_close_to_close_portfolio(close, signal_targets, cost_bps=20.0)

        self.assertEqual(run.trades.iloc[0]["signal_date"], "2024-01-02")
        self.assertEqual(run.trades.iloc[0]["effective_date"], "2024-01-03")
        self.assertAlmostEqual(run.returns.loc[pd.Timestamp("2024-01-03")], -0.002)
        self.assertAlmostEqual(run.returns.loc[pd.Timestamp("2024-01-04")], 0.10)


if __name__ == "__main__":
    unittest.main(verbosity=2)

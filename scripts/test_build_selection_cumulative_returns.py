#!/usr/bin/env python3
"""Tests for non-overlapping cumulative within-sector selection returns."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_selection_cumulative_returns as subject  # noqa: E402


class SelectionCumulativeReturnsTests(unittest.TestCase):
    def test_nonoverlap_schedule_skips_signals_inside_existing_holding_window(self) -> None:
        calendar = pd.date_range("2024-01-01", periods=10, freq="B")
        signals = pd.DatetimeIndex([calendar[0], calendar[1], calendar[2], calendar[3], calendar[6]])

        schedule = subject.nonoverlap_schedule(signals, calendar, horizon_days=2)

        self.assertEqual(schedule["signal_date"].tolist(), [calendar[0], calendar[3], calendar[6]])
        self.assertEqual(schedule["exit_date"].tolist(), [calendar[2], calendar[5], calendar[8]])

    def test_cumulative_return_compounds_sector_equal_period_returns(self) -> None:
        metrics = pd.DataFrame(
            [
                {"date": "2024-01-01", "sector_code": "A", "factor": "stock_beta_score", "top_return": 0.10, "universe_return": 0.05},
                {"date": "2024-01-01", "sector_code": "B", "factor": "stock_beta_score", "top_return": 0.10, "universe_return": 0.05},
                {"date": "2024-01-04", "sector_code": "A", "factor": "stock_beta_score", "top_return": 0.10, "universe_return": 0.05},
                {"date": "2024-01-04", "sector_code": "B", "factor": "stock_beta_score", "top_return": 0.10, "universe_return": 0.05},
            ]
        )
        schedule = pd.DataFrame(
            {"signal_date": pd.to_datetime(["2024-01-01", "2024-01-04"]), "exit_date": pd.to_datetime(["2024-01-03", "2024-01-06"])}
        )

        result = subject.aggregate_cumulative_returns(metrics, schedule)

        factor = result[result["series"].eq("stock_beta_score")].iloc[0]
        sector = result[result["series"].eq("sector_average")].iloc[0]
        self.assertAlmostEqual(factor["total_return"], 0.21)
        self.assertAlmostEqual(sector["total_return"], 0.1025)


if __name__ == "__main__":
    unittest.main(verbosity=2)

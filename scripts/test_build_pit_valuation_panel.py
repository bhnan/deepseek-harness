#!/usr/bin/env python3
"""Tests for point-in-time valuation alignment."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_pit_valuation_panel as subject  # noqa: E402


class PitValuationPanelTests(unittest.TestCase):
    def test_asof_join_uses_last_available_valuation_observation(self) -> None:
        stocks = pd.DataFrame(
            [{"stock_code": "000001", "stock_name": "测试", "sector_name": "银行", "sector_code": "801780"}]
        )
        history = pd.DataFrame(
            [
                {"stock_code": "000001", "date": pd.Timestamp("2024-01-02"), "market_cap_yi": 100.0, "pe_ttm": 10.0, "pb": 1.0},
                {"stock_code": "000001", "date": pd.Timestamp("2024-01-05"), "market_cap_yi": 120.0, "pe_ttm": 12.0, "pb": 1.2},
            ]
        )
        # Match the real input path: source and CSV-derived dates may use
        # different resolutions even when their calendar values are identical.
        history["date"] = history["date"].astype("datetime64[s]")
        dates = pd.DatetimeIndex([pd.Timestamp("2024-01-04"), pd.Timestamp("2024-01-08")]).as_unit("us")

        panel = subject.build_asof_panel(stocks, history, dates)

        self.assertEqual(panel.iloc[0]["market_cap_yi"], 100.0)
        self.assertEqual(panel.iloc[1]["market_cap_yi"], 120.0)
        self.assertTrue(panel["availability_valid"].all())


if __name__ == "__main__":
    unittest.main(verbosity=2)

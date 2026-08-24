#!/usr/bin/env python3
"""Tests for pure within-sector Top-N stock-selection validation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_intra_sector_top5 as subject  # noqa: E402


class IntraSectorTopFiveTests(unittest.TestCase):
    def test_top_five_metrics_compare_only_same_sector_members(self) -> None:
        rows = []
        for index in range(10):
            rows.append(
                {
                    "date": pd.Timestamp("2024-01-31"),
                    "sector_code": "A",
                    "sector_name": "测试行业",
                    "pool_type": "主线成长",
                    "stock_code": f"0000{index:02d}",
                    "stock_name": f"股票{index}",
                    "stock_beta_score": float(index),
                    "future_return_20d": float(index) / 100.0,
                }
            )
        frame = pd.DataFrame(rows)

        metrics, selections = subject.evaluate_sector_date(frame, horizon="20d", top_n=5)

        self.assertEqual(metrics["top_n"], 5)
        self.assertAlmostEqual(metrics["top_return"], 0.07)
        self.assertAlmostEqual(metrics["bottom_return"], 0.02)
        self.assertAlmostEqual(metrics["top_minus_bottom"], 0.05)
        self.assertAlmostEqual(metrics["rank_ic"], 1.0)
        self.assertEqual(set(selections[selections["selection_bucket"].eq("top")]["stock_code"]), {"000005", "000006", "000007", "000008", "000009"})

    def test_returns_none_when_sector_has_too_few_stocks_for_nonoverlapping_groups(self) -> None:
        frame = pd.DataFrame(
            {
                "date": [pd.Timestamp("2024-01-31")] * 9,
                "sector_code": ["A"] * 9,
                "stock_beta_score": np.arange(9),
                "future_return_20d": np.arange(9),
            }
        )

        metrics, selections = subject.evaluate_sector_date(frame, horizon="20d", top_n=5)

        self.assertIsNone(metrics)
        self.assertTrue(selections.empty)


if __name__ == "__main__":
    unittest.main(verbosity=2)

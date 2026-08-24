#!/usr/bin/env python3
"""Behavior tests for historical A/B/C recommendation validation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_type_factor_pools_v1 as subject  # noqa: E402


def type_pool_panel() -> pd.DataFrame:
    scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    returns = [-0.10, -0.08, -0.06, -0.04, -0.02, 0.00, 0.02, 0.04, 0.10, 0.12]
    return pd.DataFrame(
        {
            "pool_type": "主线成长",
            "date": "2024-01-31",
            "sector_name": "电子",
            "stock_code": [f"0000{idx:02d}" for idx in range(1, 11)],
            "historical_proxy_score": scores,
            "future_return_20d": returns,
        }
    )


class RecommendationValidationTests(unittest.TestCase):
    def test_replays_current_abc_cutoffs_and_reports_type_pool_accuracy(self) -> None:
        result = subject.build_recommendation_validation(
            type_pool_panel(),
            horizons=["20d"],
            min_type_pool_size=5,
            min_sector_size=5,
            time_split_ratio=0.5,
        )

        grades = result["observations"].sort_values("historical_proxy_score")["type_grade"].tolist()
        self.assertEqual(grades, ["C", "C", "C", "B", "B", "B", "B", "A", "A", "A"])

        row = result["type_pool_summary"].iloc[0]
        self.assertEqual(int(row["periods"]), 1)
        self.assertAlmostEqual(row["a_forward_return_mean"], 0.0866666667, places=8)
        self.assertAlmostEqual(row["a_minus_c_mean"], 0.1666666667, places=8)
        self.assertGreater(row["a_excess_vs_reference_mean"], 0)
        self.assertEqual(row["a_beats_reference_period_ratio"], 1.0)

    def test_sector_neutral_output_compares_a_to_its_own_sector(self) -> None:
        panel = pd.DataFrame(
            {
                "pool_type": "主线成长",
                "date": "2024-01-31",
                "sector_name": "电子",
                "stock_code": [f"0001{idx:02d}" for idx in range(1, 6)],
                "historical_proxy_score": [0.1, 0.3, 0.5, 0.7, 0.9],
                "future_return_20d": [-0.10, -0.05, 0.00, 0.08, 0.10],
            }
        )

        result = subject.build_recommendation_validation(
            panel,
            horizons=["20d"],
            min_type_pool_size=5,
            min_sector_size=5,
            time_split_ratio=0.5,
        )

        row = result["sector_neutral_summary"].iloc[0]
        self.assertEqual(int(row["sector_snapshots"]), 1)
        self.assertAlmostEqual(row["a_forward_return_mean"], 0.09, places=8)
        self.assertAlmostEqual(row["a_excess_vs_reference_mean"], 0.084, places=8)
        self.assertEqual(row["a_beats_c_period_ratio"], 1.0)

    def test_time_split_keeps_late_dates_in_a_separate_stability_bucket(self) -> None:
        snapshots = pd.DataFrame(
            {
                "pool_type": ["主线成长"] * 4,
                "horizon": ["20d"] * 4,
                "date": ["2024-01-31", "2024-02-29", "2024-03-29", "2024-04-30"],
                "a_forward_return": [0.01, 0.02, 0.03, 0.04],
                "b_forward_return": [0.00, 0.00, 0.00, 0.00],
                "c_forward_return": [-0.01, -0.02, -0.03, -0.04],
                "reference_forward_return": [0.00, 0.00, 0.00, 0.00],
                "a_excess_vs_reference": [0.01, 0.02, 0.03, 0.04],
                "a_minus_c": [0.02, 0.04, 0.06, 0.08],
                "a_count": [2, 2, 2, 2],
                "a_positive_count": [2, 2, 2, 2],
                "a_relative_win_count": [2, 2, 2, 2],
            }
        )

        split = subject.summarize_time_stability(snapshots, time_split_ratio=0.5)
        self.assertEqual(split["phase"].tolist(), ["早期样本", "后段留出期"])
        self.assertEqual(split["periods"].tolist(), [2, 2])
        self.assertEqual(split["start_date"].tolist(), ["2024-01-31", "2024-03-29"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

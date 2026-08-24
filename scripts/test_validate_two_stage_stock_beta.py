#!/usr/bin/env python3
"""Tests for industry-conditioned stock-score validation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_two_stage_stock_beta as subject  # noqa: E402


class ValidateTwoStageStockBetaTests(unittest.TestCase):
    def test_metrics_only_evaluate_stocks_from_industry_selected_sectors(self) -> None:
        panel = pd.DataFrame(
            [
                {"date": "2024-01-31", "stock_code": "000001", "sector_code": "A", "sector_name": "甲", "pool_type": "主线成长", "industry_trend_score_hist": 0.9, "avg_amount_20d_hist": 30_000_000, "score_valid": True, "stock_beta_score": 0.0, "future_return_20d": 0.04},
                {"date": "2024-01-31", "stock_code": "000002", "sector_code": "A", "sector_name": "甲", "pool_type": "主线成长", "industry_trend_score_hist": 0.9, "avg_amount_20d_hist": 30_000_000, "score_valid": True, "stock_beta_score": 33.0, "future_return_20d": 0.03},
                {"date": "2024-01-31", "stock_code": "000003", "sector_code": "A", "sector_name": "甲", "pool_type": "主线成长", "industry_trend_score_hist": 0.9, "avg_amount_20d_hist": 30_000_000, "score_valid": True, "stock_beta_score": 67.0, "future_return_20d": 0.02},
                {"date": "2024-01-31", "stock_code": "000004", "sector_code": "A", "sector_name": "甲", "pool_type": "主线成长", "industry_trend_score_hist": 0.9, "avg_amount_20d_hist": 30_000_000, "score_valid": True, "stock_beta_score": 100.0, "future_return_20d": 0.01},
                {"date": "2024-01-31", "stock_code": "000005", "sector_code": "B", "sector_name": "乙", "pool_type": "周期", "industry_trend_score_hist": 0.1, "avg_amount_20d_hist": 30_000_000, "score_valid": True, "stock_beta_score": 100.0, "future_return_20d": 0.50},
                {"date": "2024-01-31", "stock_code": "000006", "sector_code": "B", "sector_name": "乙", "pool_type": "周期", "industry_trend_score_hist": 0.1, "avg_amount_20d_hist": 30_000_000, "score_valid": True, "stock_beta_score": 50.0, "future_return_20d": 0.40},
            ]
        )

        observations = subject.industry_conditioned_observations(panel, top_k=1, min_stocks_per_sector=4)
        metrics = subject.score_metrics(observations, horizon="20d", score_columns=["stock_beta_score"], min_stocks_per_sector=4)

        self.assertEqual(set(observations["sector_code"]), {"A"})
        self.assertEqual(len(metrics), 1)
        self.assertEqual(metrics.loc[0, "rank_ic"], -1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

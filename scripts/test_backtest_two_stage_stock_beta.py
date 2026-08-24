#!/usr/bin/env python3
"""Tests for the two-stage industry-then-stock backtest contract."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import backtest_two_stage_stock_beta as subject  # noqa: E402


class TwoStageBacktestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.snapshot = pd.DataFrame(
            [
                {"stock_code": "000001", "sector_code": "A", "sector_name": "甲", "industry_trend_score_hist": 0.90, "stock_beta_score": 90.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
                {"stock_code": "000002", "sector_code": "A", "sector_name": "甲", "industry_trend_score_hist": 0.90, "stock_beta_score": 65.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
                {"stock_code": "000003", "sector_code": "A", "sector_name": "甲", "industry_trend_score_hist": 0.90, "stock_beta_score": 40.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
                {"stock_code": "000004", "sector_code": "B", "sector_name": "乙", "industry_trend_score_hist": 0.80, "stock_beta_score": 99.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
                {"stock_code": "000005", "sector_code": "B", "sector_name": "乙", "industry_trend_score_hist": 0.80, "stock_beta_score": 70.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
                {"stock_code": "000006", "sector_code": "B", "sector_name": "乙", "industry_trend_score_hist": 0.80, "stock_beta_score": 30.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
                {"stock_code": "000007", "sector_code": "C", "sector_name": "丙", "industry_trend_score_hist": 0.10, "stock_beta_score": 100.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
                {"stock_code": "000008", "sector_code": "C", "sector_name": "丙", "industry_trend_score_hist": 0.10, "stock_beta_score": 10.0, "score_valid": True, "avg_amount_20d_hist": 30_000_000},
            ]
        )

    def test_sector_stage_selects_by_industry_score_not_stock_score(self) -> None:
        sectors = subject.select_sectors(self.snapshot, top_k=2, min_stocks_per_sector=2)

        self.assertEqual(sectors["sector_code"].tolist(), ["A", "B"])

    def test_two_stage_target_equal_weights_selected_sectors_then_stocks(self) -> None:
        selected, audits = subject.select_stocks_for_sleeve(
            self.snapshot,
            sleeve="two_stage_stock_beta",
            top_k=2,
            stock_score_threshold=60.0,
            min_stocks_per_sector=2,
        )

        self.assertEqual(set(selected["stock_code"]), {"000001", "000002", "000004", "000005"})
        self.assertTrue((selected.groupby("sector_code")["target_weight"].sum() == 0.5).all())
        self.assertEqual(set(audits.loc[audits["sector_selected"], "sector_code"]), {"A", "B"})

    def test_sector_only_keeps_all_eligible_stocks_in_selected_sector(self) -> None:
        selected, _ = subject.select_stocks_for_sleeve(
            self.snapshot,
            sleeve="sector_only",
            top_k=1,
            stock_score_threshold=60.0,
            min_stocks_per_sector=2,
        )

        self.assertEqual(set(selected["stock_code"]), {"000001", "000002", "000003"})
        self.assertAlmostEqual(float(selected["target_weight"].sum()), 1.0)

    def test_empty_two_stage_selection_creates_a_cash_target(self) -> None:
        close = pd.DataFrame(
            {"000001": [10.0, 10.0, 10.0], "000002": [10.0, 10.0, 10.0]},
            index=pd.to_datetime(["2024-01-31", "2024-02-01", "2024-02-02"]),
        )
        snapshot = self.snapshot[self.snapshot["sector_code"].eq("A")].iloc[:2].copy()
        snapshot["date"] = pd.Timestamp("2024-01-31")

        targets, _ = subject.build_signal_targets(
            snapshot,
            close,
            sleeve="two_stage_stock_beta",
            top_k=1,
            stock_score_threshold=101.0,
            min_stocks_per_sector=2,
            min_avg_amount=20_000_000,
        )

        self.assertEqual(len(targets), 1)
        self.assertEqual(float(targets.iloc[0].sum()), 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

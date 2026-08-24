#!/usr/bin/env python3
"""Tests for the sector-neutral stock Beta score panel."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_stock_beta_score_panel as subject  # noqa: E402


class StockBetaScorePanelTests(unittest.TestCase):
    def test_rank_within_sector_is_not_changed_by_shared_sector_trend(self) -> None:
        panel = pd.DataFrame(
            [
                {"date": "2024-01-31", "pool_type": "主线成长", "sector_code": "A", "raw": 1.0, "industry_trend": 0.2},
                {"date": "2024-01-31", "pool_type": "主线成长", "sector_code": "A", "raw": 2.0, "industry_trend": 0.2},
                {"date": "2024-01-31", "pool_type": "主线成长", "sector_code": "B", "raw": 1.0, "industry_trend": 0.9},
                {"date": "2024-01-31", "pool_type": "主线成长", "sector_code": "B", "raw": 2.0, "industry_trend": 0.9},
            ]
        )

        ranked = subject.rank_within_sector(panel, "raw", "score")

        self.assertEqual(ranked.groupby("sector_code")["score"].mean().to_dict(), {"A": 50.0, "B": 50.0})
        self.assertEqual(ranked.groupby("sector_code")["score"].max().to_dict(), {"A": 100.0, "B": 100.0})
        self.assertNotIn("industry_trend", subject.STOCK_COMPONENTS)

    def test_point_in_time_masks_drop_invalid_finance_and_valuation(self) -> None:
        panel = pd.DataFrame(
            [
                {
                    "availability_valid_financial": False,
                    "availability_valid_valuation": False,
                    "PARENT_NETPROFIT_YOY": 99.0,
                    "TOTAL_OPERATE_INCOME_TTM": 100.0,
                    "market_cap_yi": 10.0,
                    "pe_ttm": 5.0,
                    "pb": 1.0,
                }
            ]
        )

        masked = subject.apply_point_in_time_masks(panel)

        self.assertTrue(pd.isna(masked.loc[0, "PARENT_NETPROFIT_YOY"]))
        self.assertTrue(pd.isna(masked.loc[0, "TOTAL_OPERATE_INCOME_TTM"]))
        self.assertTrue(pd.isna(masked.loc[0, "market_cap_yi"]))
        self.assertTrue(pd.isna(masked.loc[0, "pe_ttm"]))

    def test_weighted_score_uses_only_type_specific_component_weights(self) -> None:
        panel = pd.DataFrame(
            [
                {
                    "pool_type": "主线成长",
                    **{component: 100.0 for component in subject.STOCK_COMPONENTS},
                    **{f"{component}_observed": True for component in subject.STOCK_COMPONENTS},
                },
                {
                    "pool_type": "主线成长",
                    **{component: 50.0 for component in subject.STOCK_COMPONENTS},
                    **{f"{component}_observed": True for component in subject.STOCK_COMPONENTS},
                },
            ]
        )

        scored = subject.combine_type_scores(panel)

        self.assertEqual(scored.loc[0, "stock_beta_score"], 100.0)
        self.assertEqual(scored.loc[1, "stock_beta_score"], 50.0)
        self.assertEqual(scored.loc[0, "score_coverage"], 1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

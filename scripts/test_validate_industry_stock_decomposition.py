#!/usr/bin/env python3
"""Tests for the industry/stock attribution portfolio construction."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_industry_stock_decomposition as subject  # noqa: E402


class IndustryStockDecompositionTests(unittest.TestCase):
    def test_four_portfolios_keep_industry_and_stock_decisions_separate(self) -> None:
        rows: list[dict[str, object]] = []
        for sector, industry_score, base_return in [("A", 0.20, 0.00), ("B", 0.40, 0.00), ("C", 0.90, 0.10)]:
            for index in range(10):
                rows.append(
                    {
                        "pool_type": "测试",
                        "date": "2026-01-02",
                        "stock_code": f"{sector}{index:02d}",
                        "sector_code": sector,
                        "sector_name": sector,
                        "industry_trend_score_hist": industry_score,
                        "historical_proxy_score": index / 10,
                        "future_return_10d": base_return + (0.10 if index >= 8 else 0.00),
                    }
                )

        panel = subject.prepare_panel(pd.DataFrame(rows))
        observed = subject.portfolio_observations(panel, "10d", top_sector_count=1).iloc[0]

        self.assertEqual(observed["selected_sectors"], "C")
        self.assertGreater(observed["industry_only_return"], observed["baseline_return"])
        self.assertGreater(observed["stock_only_return"], observed["baseline_return"])
        self.assertGreater(observed["double_return"], observed["industry_only_return"])

    def test_sector_members_below_minimum_are_excluded_before_ranking(self) -> None:
        rows = [
            {
                "pool_type": "测试",
                "date": "2026-01-02",
                "stock_code": f"A{index:02d}",
                "sector_code": "A",
                "sector_name": "A",
                "industry_trend_score_hist": 0.90,
                "historical_proxy_score": index / 10,
                "future_return_10d": 0.01,
            }
            for index in range(7)
        ]
        rows.extend(
            {
                "pool_type": "测试",
                "date": "2026-01-02",
                "stock_code": f"B{index:02d}",
                "sector_code": "B",
                "sector_name": "B",
                "industry_trend_score_hist": 0.50,
                "historical_proxy_score": index / 10,
                "future_return_10d": 0.01,
            }
            for index in range(8)
        )

        panel = subject.prepare_panel(pd.DataFrame(rows))

        self.assertEqual(panel["sector_code"].unique().tolist(), ["B"])

    def test_monthly_non_overlap_samples_every_third_signal_for_60_days(self) -> None:
        dates = pd.date_range("2025-01-31", periods=7, freq="ME")

        sampled = subject.monthly_non_overlapping_dates(dates, horizon_days=60)

        self.assertEqual(sampled.tolist(), [dates[0], dates[3], dates[6]])


if __name__ == "__main__":
    unittest.main(verbosity=2)

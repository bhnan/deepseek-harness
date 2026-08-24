#!/usr/bin/env python3
"""Tests for same-universe single-factor versus multifactor comparison."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import compare_single_vs_multifactor as subject  # noqa: E402


class SingleVsMultifactorTests(unittest.TestCase):
    def test_common_universe_removes_rows_with_any_missing_factor(self) -> None:
        frame = pd.DataFrame(
            [
                {"stock_code": "000001", **{column: 1.0 for column in subject.SCORE_COLUMNS}},
                {"stock_code": "000002", **{column: 1.0 for column in subject.SCORE_COLUMNS[:-1]}, subject.SCORE_COLUMNS[-1]: None},
            ]
        )

        result = subject.common_factor_universe(frame)

        self.assertEqual(result["stock_code"].tolist(), ["000001"])

    def test_overlap_is_one_when_single_factor_and_multifactor_choose_same_top_five(self) -> None:
        rows = []
        for index in range(10):
            rows.append(
                {
                    "date": pd.Timestamp("2024-01-31"),
                    "sector_code": "A",
                    "stock_code": f"0000{index:02d}",
                    "stock_beta_score": float(index),
                    "earnings_growth_score": float(index),
                    "future_return_20d": float(index),
                }
            )
        frame = pd.DataFrame(rows)

        overlap = subject.top_n_overlap(frame, "earnings_growth_score", top_n=5)

        self.assertEqual(len(overlap), 1)
        self.assertEqual(overlap.loc[0, "jaccard_overlap"], 1.0)
        self.assertEqual(overlap.loc[0, "intersection_count"], 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)

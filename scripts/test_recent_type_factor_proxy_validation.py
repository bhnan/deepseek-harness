#!/usr/bin/env python3
"""Behavior tests for the recent daily type-factor validation windows."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_recent_type_factor_proxy as subject  # noqa: E402


class RecentTypeFactorDailyValidationTests(unittest.TestCase):
    def test_recent_and_mature_windows_separate_unmatured_and_mature_signals(self) -> None:
        dates = pd.bdate_range("2024-01-01", periods=200)

        windows = subject.build_signal_windows(dates, recent_days=60, long_horizon=60)

        self.assertEqual(windows["recent_60d"].tolist(), dates[-60:].tolist())
        self.assertEqual(windows["mature_60d"].tolist(), dates[-120:-60].tolist())
        self.assertEqual(windows["mature_60d"].max(), dates[-61])

    def test_non_overlapping_dates_step_by_the_forward_horizon(self) -> None:
        dates = pd.bdate_range("2024-01-01", periods=25)

        sampled = subject.non_overlapping_dates(dates, horizon_days=10)

        self.assertEqual(sampled.tolist(), [dates[0], dates[10], dates[20]])


if __name__ == "__main__":
    unittest.main(verbosity=2)

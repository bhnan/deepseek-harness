#!/usr/bin/env python3
"""Tests for point-in-time filing availability."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_pit_financial_panel as subject  # noqa: E402


class PitFinancialPanelTests(unittest.TestCase):
    def test_market_symbol_uses_expected_exchange_prefix(self) -> None:
        self.assertEqual(subject.market_symbol("600519"), "SH600519")
        self.assertEqual(subject.market_symbol("300750"), "SZ300750")
        self.assertEqual(subject.market_symbol("830001"), "BJ830001")

    def test_asof_join_does_not_use_a_filing_before_notice_date(self) -> None:
        stocks = pd.DataFrame(
            [{"stock_code": "000001", "stock_name": "测试", "sector_name": "银行", "sector_code": "801780"}]
        )
        reports = pd.DataFrame(
            [
                {
                    "stock_code": "000001",
                    "REPORT_DATE": pd.Timestamp("2024-03-31"),
                    "NOTICE_DATE": pd.Timestamp("2024-04-25"),
                    "UPDATE_DATE": pd.Timestamp("2024-04-25"),
                    "TOTAL_OPERATE_INCOME": 100.0,
                    "TOTAL_OPERATE_INCOME_YOY": 10.0,
                    "PARENT_NETPROFIT": 20.0,
                    "PARENT_NETPROFIT_YOY": 5.0,
                    "DEDUCT_PARENT_NETPROFIT": 18.0,
                    "DEDUCT_PARENT_NETPROFIT_YOY": 4.0,
                    "source": "test",
                }
            ]
        )
        dates = pd.DatetimeIndex([pd.Timestamp("2024-04-24"), pd.Timestamp("2024-04-25")])

        panel = subject.build_asof_panel(stocks, reports, dates)

        self.assertTrue(pd.isna(panel.iloc[0]["REPORT_DATE"]))
        self.assertEqual(panel.iloc[1]["REPORT_DATE"], pd.Timestamp("2024-03-31"))
        self.assertTrue(panel.iloc[1]["availability_valid"])

    def test_ttm_requires_prior_components_to_be_public(self) -> None:
        reports = pd.DataFrame(
            [
                {
                    "stock_code": "000001",
                    "REPORT_DATE": pd.Timestamp("2023-03-31"),
                    "NOTICE_DATE": pd.Timestamp("2023-04-25"),
                    "TOTAL_OPERATE_INCOME": 20.0,
                    "PARENT_NETPROFIT": 4.0,
                    "DEDUCT_PARENT_NETPROFIT": 3.0,
                },
                {
                    "stock_code": "000001",
                    "REPORT_DATE": pd.Timestamp("2023-12-31"),
                    "NOTICE_DATE": pd.Timestamp("2024-04-30"),
                    "TOTAL_OPERATE_INCOME": 100.0,
                    "PARENT_NETPROFIT": 20.0,
                    "DEDUCT_PARENT_NETPROFIT": 15.0,
                },
                {
                    "stock_code": "000001",
                    "REPORT_DATE": pd.Timestamp("2024-03-31"),
                    "NOTICE_DATE": pd.Timestamp("2024-04-26"),
                    "TOTAL_OPERATE_INCOME": 30.0,
                    "PARENT_NETPROFIT": 6.0,
                    "DEDUCT_PARENT_NETPROFIT": 5.0,
                },
            ]
        )

        result = subject.add_trailing_twelve_months(reports).sort_values("REPORT_DATE").reset_index(drop=True)

        self.assertEqual(result.loc[1, "TOTAL_OPERATE_INCOME_TTM"], 100.0)
        self.assertFalse(result.loc[2, "TOTAL_OPERATE_INCOME_TTM_AVAILABLE"])
        self.assertTrue(pd.isna(result.loc[2, "TOTAL_OPERATE_INCOME_TTM"]))

        reports.loc[1, "NOTICE_DATE"] = pd.Timestamp("2024-04-20")
        result = subject.add_trailing_twelve_months(reports).sort_values("REPORT_DATE").reset_index(drop=True)
        self.assertTrue(result.loc[2, "TOTAL_OPERATE_INCOME_TTM_AVAILABLE"])
        self.assertEqual(result.loc[2, "TOTAL_OPERATE_INCOME_TTM"], 110.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""M1 契约测试：dates / latest / normalize（golden 锚定 asof=2026-08-25）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.dates import dates, latest
from tools.normalize import is_sector, resolve_name, to_symbol
from tools._util import ParamError

ASOF = "2026-08-25"


class TestDates(unittest.TestCase):
    def test_dates_default_five(self):
        ds = dates(asof=ASOF)
        self.assertEqual(ds, ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25"])

    def test_dates_n(self):
        self.assertEqual(dates(n=3, asof=ASOF)[-1], "2026-08-25")
        self.assertEqual(len(dates(n=3, asof=ASOF)), 3)

    def test_dates_range(self):
        ds = dates(start="2026-08-18", end="2026-08-20", asof=ASOF)
        self.assertEqual(ds, ["2026-08-18", "2026-08-19", "2026-08-20"])

    def test_dates_skip_missing(self):
        # 非交易日（周末）被跳过：区间含周六，不应出现
        ds = dates(start="2026-08-22", end="2026-08-25", asof=ASOF)
        self.assertNotIn("2026-08-22", ds)
        self.assertNotIn("2026-08-23", ds)
        self.assertEqual(ds, ["2026-08-24", "2026-08-25"])

    def test_latest(self):
        self.assertEqual(latest(asof=ASOF), "2026-08-25")


class TestNormalize(unittest.TestCase):
    def test_to_symbol(self):
        self.assertEqual(to_symbol("600519"), "sh600519")
        self.assertEqual(to_symbol("000858"), "sz000858")
        self.assertEqual(to_symbol("920000"), "bj920000")
        self.assertEqual(to_symbol("sh600519"), "sh600519")
        self.assertEqual(to_symbol("601318.SH"), "sh601318")
        self.assertEqual(to_symbol("002074"), "sz002074")

    def test_to_symbol_invalid(self):
        with self.assertRaises(ParamError):
            to_symbol("12345")
        with self.assertRaises(ParamError):
            to_symbol("")

    def test_is_sector(self):
        self.assertTrue(is_sector("801010"))
        self.assertFalse(is_sector("600519"))
        self.assertFalse(is_sector(""))

    def test_resolve_name(self):
        # 真实数据：贵州茅台应在当日行情表中解析为 sh600519（数据缺失则跳过）
        try:
            code = resolve_name("贵州茅台", ASOF)
        except ParamError:
            self.skipTest("当日行情无贵州茅台")
        self.assertEqual(code, "sh600519")


if __name__ == "__main__":
    unittest.main()

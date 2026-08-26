"""M3 契约测试：个股专题（stock-news / financials / valuation）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.stock_extra import financials, stock_news, valuation
from tools._util import DataError
from tools.dates import dates

ASOF = "2026-08-25"
DS = dates(n=5, asof=ASOF)


class TestStockNews(unittest.TestCase):
    def test_structure(self):
        n = stock_news("sz002074", DS)
        self.assertEqual(n["code"], "sz002074")
        self.assertEqual(n["dates"], DS)
        self.assertIn("items", n)
        for it in n["items"]:
            self.assertIn("kind", it)
            self.assertIn("date", it)
            self.assertIn("title", it)

    def test_announcement_match_by_code(self):
        # 公告按裸 6 位代码匹配：如果区间内有国轩高科公告则应命中
        n = stock_news("sz002074", DS)
        ann = [x for x in n["items"] if x["kind"] == "announcement"]
        for a in ann:
            self.assertIn("002074", str(a.get("code")))

    def test_unknown_code(self):
        n = stock_news("sh999999", DS)
        self.assertEqual(n["items"], [])


class TestFinancials(unittest.TestCase):
    def test_guoxuan(self):
        f = financials("sz002074", reports=4)
        self.assertEqual(f["code"], "sz002074")
        self.assertTrue(len(f["reports"]) >= 1)
        r0 = f["reports"][0]
        for k in ("report_date", "notice_date", "report_type", "total_operate_income",
                  "parent_netprofit", "parent_netprofit_yoy", "basic_eps"):
            self.assertIn(k, r0)
        # 报告期与公告日格式 YYYY-MM-DD
        self.assertRegex(str(r0["report_date"] or ""), r"^\d{4}-\d{2}-\d{2}$")

    def test_unknown_code(self):
        with self.assertRaises(DataError):
            financials("sh999999")


class TestValuation(unittest.TestCase):
    def test_guoxuan(self):
        v = valuation("sz002074", DS)
        self.assertEqual(v["code"], "sz002074")
        self.assertEqual(len(v["series"]), len(DS))
        for m in ("market_cap_yi", "pe_ttm", "pb"):
            self.assertIn(m, v["period"])
            p = v["period"][m]
            self.assertIn("start", p)
            self.assertIn("change_pct", p)
            self.assertIn("high", p)

    def test_period_stats_golden(self):
        # 手工构造：5 个值，验证口径
        from tools.series import period_stats

        vals = [{"date": f"2026-08-{19+i:02d}", "value": v} for i, v in
                enumerate([100.0, 105.0, 102.0, 110.0, 108.0])]
        p = period_stats(vals)
        self.assertEqual(p["start"], 100.0)
        self.assertEqual(p["end"], 108.0)
        self.assertAlmostEqual(p["change_pct"], 8.0, places=4)
        self.assertEqual(p["high"], 110.0)
        self.assertEqual(p["low"], 100.0)
        self.assertEqual(p["positive_days"], 2)   # 100→105, 102→110 上涨
        self.assertEqual(p["negative_days"], 2)   # 105→102, 110→108 下跌
        self.assertAlmostEqual(p["consistency"], 0.5, places=4)


if __name__ == "__main__":
    unittest.main()

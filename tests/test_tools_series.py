"""M4 契约测试：series（stats/bars/universe）/ review-digest / stock-profile + golden 比对。"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd

from tools.dates import dates
from tools.series import review_digest, series, stock_profile
from tools._util import ParamError

ASOF = "2026-08-25"
DS = dates(n=5, asof=ASOF)      # [08-19..08-25]：index/review/quotes 覆盖
# sw_daily / 个股日线 parquet 截至 2026-08-18（本环境数据滞后），行业/个股序列测试锚定该窗口
SEC_DS = dates(n=5, asof="2026-08-18")


class TestSeriesIndex(unittest.TestCase):
    def test_stats_golden(self):
        # 手工从 index_daily.parquet 算 sh000001 在窗口内的首尾涨跌
        df = pd.read_parquet("data/market/index_daily.parquet")
        sub = df[df["code"] == "sh000001"]
        sub = sub[sub["date"].astype(str).str[:10].isin(DS)].sort_values("date")
        s = series(json.dumps({"type": "index", "symbols": ["sh000001"]}), DS)
        self.assertEqual(s["dates"], DS)
        self.assertEqual(len(s["daily"]), 5)
        manual = (sub["close"].iloc[-1] - sub["close"].iloc[0]) / sub["close"].iloc[0] * 100
        self.assertAlmostEqual(s["period"]["change_pct"], manual, places=2)
        self.assertEqual(s["period"]["high"], float(sub["high"].max()))
        self.assertEqual(s["period"]["low"], float(sub["low"].min()))

    def test_bare_index_code(self):
        # 000001 → sh000001（按可用代码后缀唯一匹配）
        s = series(json.dumps({"type": "index", "symbols": ["000001"]}), DS)
        self.assertEqual(len(s["daily"]), 5)


class TestSeriesSector(unittest.TestCase):
    def test_bars(self):
        r = series(json.dumps({"type": "sector", "symbols": ["801010"]}), SEC_DS, mode="bars")
        self.assertGreaterEqual(len(r["bars"]), 1)
        for b in r["bars"]:
            for k in ("date", "open", "high", "low", "close"):
                self.assertIn(k, b)
            self.assertIn(b["date"], SEC_DS)

    def test_week_resample(self):
        r = series(json.dumps({"type": "sector", "symbols": ["801010"]}), SEC_DS,
                   mode="bars", granularity="week")
        self.assertLessEqual(len(r["bars"]), len(SEC_DS))
        self.assertTrue(r["bars"])


class TestSeriesStock(unittest.TestCase):
    def test_stats(self):
        r = series(json.dumps({"type": "stock", "symbols": ["sz002074"]}), SEC_DS)
        self.assertGreaterEqual(len(r["daily"]), 1)
        self.assertIn("change_pct", r["period"])

    def test_bars_amount(self):
        r = series(json.dumps({"type": "stock", "symbols": ["sz002074"]}), SEC_DS, mode="bars")
        self.assertIn("amount", r["bars"][0])


class TestSeriesUniverse(unittest.TestCase):
    def test_nav_and_set(self):
        v = {"type": "universe", "symbols": ["sh600519", "sz002074"], "label": "测试"}
        r = series(json.dumps(v), DS)
        self.assertEqual(len(r["daily"]), 5)
        # NAV 复利关系：nav[k] = nav[k-1] * (1 + change_pct[k]/100)
        for i in range(1, len(r["daily"])):
            prev, cur = r["daily"][i - 1], r["daily"][i]
            if cur["change_pct"] is not None:
                self.assertAlmostEqual(cur["nav"],
                                       prev["nav"] * (1 + cur["change_pct"] / 100), places=4)
        p = r["period"]
        self.assertIn("set_top", p)
        self.assertIn("set_bottom", p)
        self.assertIn("persistence", p)
        self.assertIn("change_pct", p)

    def test_weighted(self):
        v = {"type": "universe", "symbols": ["sh600519", "sz002074"], "weights": [0.7, 0.3]}
        r = series(json.dumps(v), DS)
        self.assertEqual(len(r["daily"]), 5)


class TestReviewDigest(unittest.TestCase):
    def test_structure(self):
        r = review_digest(DS)
        self.assertEqual(len(r["daily"]), 5)
        ev = r["evolution"]
        self.assertIn("regime", ev)
        self.assertIn("regime_shift", ev)
        self.assertIn("trend_consistent", ev)
        self.assertIn("risk_escalation", ev)


class TestStockProfile(unittest.TestCase):
    def test_all_blocks(self):
        p = stock_profile("sz002074", DS)
        for k in ("price", "bars", "news", "financials", "valuation", "snapshot"):
            self.assertIn(k, p)
        self.assertEqual(p["view"]["symbols"], ["sz002074"])

    def test_blocks_subset(self):
        p = stock_profile("sz002074", DS, blocks="price,news")
        self.assertIn("price", p)
        self.assertIn("news", p)
        self.assertNotIn("bars", p)

    def test_bad_blocks(self):
        with self.assertRaises(ParamError):
            stock_profile("sz002074", DS, blocks="price,bogus")


if __name__ == "__main__":
    unittest.main()

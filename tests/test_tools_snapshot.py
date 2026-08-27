"""M2 契约测试：快照类命令（market/sectors/universe/stock/review/events/signals）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.snapshot import events, market, review, sectors, signals, stock, universe
from tools._util import DataError, ParamError

D = "2026-08-25"


class TestMarket(unittest.TestCase):
    def test_market_shape(self):
        m = market(D)
        self.assertEqual(m["date"], D)
        self.assertEqual(len(m["indices"]), 5)
        self.assertIn("change_pct", m["indices"][0])
        self.assertIn("code", m["indices"][0])
        b = m["breadth"]
        for k in ("advancers", "decliners", "limit_up", "limit_down", "total_amount"):
            self.assertIn(k, b)

    def test_market_missing_date(self):
        with self.assertRaises(DataError):
            market("2020-01-01")


class TestSectors(unittest.TestCase):
    def test_all(self):
        s = sectors(D)
        self.assertEqual(s["count"], 31)
        self.assertEqual(len(s["all"]), 31)
        # 按涨跌幅降序
        pcts = [x["change_pct"] for x in s["all"]]
        self.assertEqual(pcts, sorted(pcts, reverse=True))

    def test_top_bottom(self):
        s = sectors(D, top=5, bottom=5)
        self.assertEqual(len(s["top"]), 5)
        self.assertEqual(len(s["bottom"]), 5)
        # bottom 应包含全量里跌幅最大的（全量末名）
        full = sectors(D)["all"]
        self.assertEqual(s["bottom"][0]["code"], full[-1]["code"])


class TestStock(unittest.TestCase):
    def test_stock_guoxuan(self):
        st = stock(D, "002074")
        self.assertEqual(st["stock"]["code"], "sz002074")
        self.assertEqual(st["stock"]["name"], "国轩高科")
        for k in ("last_price", "change_pct", "open", "high", "low", "amount", "volume"):
            self.assertIn(k, st["stock"])

    def test_stock_missing(self):
        with self.assertRaises(DataError):
            stock(D, "sh999999")


class TestUniverse(unittest.TestCase):
    def test_universe_weights(self):
        u = universe(D, "600519,002074", weights="0.7,0.3", label="测试")
        self.assertEqual(len(u["stocks"]), 2)
        self.assertEqual(u["view"]["weights"], [0.7, 0.3])
        st = u["stats"]
        for k in ("advancers", "decliners", "na", "count", "avg_change_pct",
                  "weighted_change_pct", "top", "bottom"):
            self.assertIn(k, st)

    def test_universe_name(self):
        # 名称解析进集合
        u = universe(D, "贵州茅台,国轩高科")
        codes = {s["code"] for s in u["stocks"]}
        self.assertEqual(codes, {"sh600519", "sz002074"})

    def test_universe_weights_mismatch(self):
        with self.assertRaises(ParamError):
            universe(D, "600519,002074", weights="0.5")


class TestReviewEventsSignals(unittest.TestCase):
    def test_review(self):
        r = review(D)
        for k in ("summary", "regime", "trend", "risk_level"):
            self.assertIn(k, r["review"])

    def test_events(self):
        e = events(D)
        self.assertIn("announcements", e)
        self.assertIn("flashes", e)

    def test_signals(self):
        s = signals(D)
        self.assertIn("status", s)
        self.assertIn("strategies", s)


if __name__ == "__main__":
    unittest.main()

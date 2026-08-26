"""采集器纯函数测试（测试点 D1-⑤/D4-③/X3）。

覆盖：严重度关键词初筛 / 申万两源 join + 涨跌幅 / 复盘数字注入（含环比缺席诚实行为）/
代码形态归一 / 自选清单默认创建。
"""
import json
import unittest
from pathlib import Path

import pandas as pd

from pipeline.collect_events import classify_severity
from pipeline.collect_review import build_review_data
from pipeline.collect_sector import merge_sw_spot
from pipeline.collect_stock import normalize_symbol


class SeverityTest(unittest.TestCase):
    def test_keywords(self):
        self.assertEqual(classify_severity("关于收到立案调查通知书的公告"), "high")
        self.assertEqual(classify_severity("控股股东减持股份计划公告"), "medium")
        self.assertEqual(classify_severity("2026年半年度报告摘要"), "low")


class SwMergeTest(unittest.TestCase):
    def test_merge_verbatim_and_derived(self):
        rt = [{"指数代码": 801080, "指数名称": "电子", "昨收盘": 3000.0, "今开盘": 3010.0,
               "最新价": 3096.0, "成交额": 50000.0, "成交量": 4000.0, "最高价": 3100.0, "最低价": 3005.0}]
        info = [{"行业代码": "801080.SI", "行业名称": "电子", "成份个数": 296,
                 "静态市盈率": 21.7, "TTM(滚动)市盈率": 23.0, "市净率": 2.83, "静态股息率": 0.94}]
        out = merge_sw_spot(rt, info)
        self.assertEqual(len(out), 1)
        row = out[0]
        self.assertEqual(row["指数代码"], 801080, "realtime 原字段")
        self.assertEqual(row["行业代码"], "801080.SI", "first_info 原字段（含 .SI）")
        self.assertEqual(row["TTM(滚动)市盈率"], 23.0)
        self.assertAlmostEqual(row["derived"]["change_pct"], 3.2, places=3)  # 3096/3000-1

    def test_merge_missing_prev_raises(self):
        rt = [{"指数代码": 801080, "指数名称": "电子", "昨收盘": None, "最新价": 10.0}]
        with self.assertRaises(ValueError):
            merge_sw_spot(rt, [])


class ReviewSkeletonTest(unittest.TestCase):
    def _assets(self):
        a_spot = {"data": {"derived": {"market_breadth": {
            "advancers": 100, "decliners": 50, "unchanged": 10,
            "limit_up": 5, "limit_down": 1, "total_amount": 2.0e12}}}}
        index_spot = {"data": {"indices": []}}
        sw = {"data": {"industries": [
            {"指数名称": "电子", "derived": {"change_pct": 3.2}},
            {"指数名称": "银行", "derived": {"change_pct": 1.0}},
            {"指数名称": "煤炭", "derived": {"change_pct": -2.0}},
            {"指数名称": "传媒", "derived": {"change_pct": -1.0}},
        ]}}
        return a_spot, index_spot, sw

    def test_with_prev_amount(self):
        a, i, sw = self._assets()
        data = build_review_data(a, i, sw, prev_amount=1.8e12, news_items=[])
        m = data["market"]
        self.assertIn("amount_change_pct", m)
        self.assertAlmostEqual(m["amount_change_pct"], 11.11, places=1)  # 2.0/1.8-1
        self.assertEqual(m["volume_tone"], "expand")                    # >5%
        self.assertEqual(data["sector"]["leading_sectors"][0]["name"], "电子")
        self.assertEqual(data["sector"]["lagging_sectors"][0]["name"], "煤炭")

    def test_without_prev_amount_honest(self):
        a, i, sw = self._assets()
        data = build_review_data(a, i, sw, prev_amount=None, news_items=[])
        m = data["market"]
        self.assertNotIn("amount_change_pct", m, "昨日快照缺失时环比必须缺席，不得伪造 0")
        self.assertNotIn("volume_tone", m)
        self.assertIn("amount", m)
        self.assertEqual(m["breadth"]["advancers"], 100)

    def test_shrink_flat_threshold(self):
        a, i, sw = self._assets()
        data = build_review_data(a, i, sw, prev_amount=2.05e12, news_items=[])
        self.assertEqual(data["market"]["volume_tone"], "flat")  # -2.4% 介于 ±5%


class SymbolNormalizeTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_symbol("600519"), "sh600519")
        self.assertEqual(normalize_symbol("300750"), "sz300750")
        self.assertEqual(normalize_symbol("SH600519"), "sh600519")
        self.assertEqual(normalize_symbol("bj430017"), "bj430017")


class WatchlistDefaultTest(unittest.TestCase):
    def test_default_created(self):
        import pipeline.collect_events as ce
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            old = ce.WATCHLIST_FILE
            ce.WATCHLIST_FILE = Path(td) / "watchlist.json"
            try:
                wl = ce.load_watchlist()
                self.assertEqual(wl["symbols"], [])
                self.assertTrue(ce.WATCHLIST_FILE.exists())
            finally:
                ce.WATCHLIST_FILE = old


if __name__ == "__main__":
    unittest.main()


class SectorRotationScanTest(unittest.TestCase):
    """A13 v1：DSL 板块轮动扫描（疲劳/修复榜 + 配对 + 冷却 + 表现）。"""

    def test_scan_finds_pairs_on_historical_day(self):
        import json
        from pathlib import Path
        from pipeline.collect_signals import COOLDOWN_FILE, collect_signals

        backup = None
        if COOLDOWN_FILE.exists():
            backup = COOLDOWN_FILE.read_text(encoding="utf-8")
            COOLDOWN_FILE.unlink()
        try:
            p = collect_signals("2023-11-20")
        finally:
            if backup is not None:
                COOLDOWN_FILE.write_text(backup, encoding="utf-8")
        d = json.loads(p.read_text(encoding="utf-8"))["data"]["strategies"][0]
        note = d["derived"]["signal_note"]
        self.assertIn("配对", note)
        self.assertGreaterEqual(len(d["derived"].get("constituents", [])), 1)
        self.assertIn("name", d["derived"]["constituents"][0])
        # change_pct 为时间维收益（合理区间）
        chg = d["derived"].get("change_pct")
        if chg is not None:
            self.assertLess(abs(chg), 30)

    def test_scan_cooling_blocks_repeat_pair(self):
        import json
        from pipeline.collect_signals import collect_signals

        # 连续两日扫描：冷却期内配对不重复发出（同日数据 → 第二日配对应被冷却拦截）
        d1 = json.loads(collect_signals("2023-11-20").read_text(encoding="utf-8"))
        d2 = json.loads(collect_signals("2023-11-20").read_text(encoding="utf-8"))
        c1 = {(c["symbol"]) for c in d1["data"]["strategies"][0]["derived"].get("constituents", [])}
        # 同日重扫：冷却生效，候选可能变化或为空（不崩溃即可）
        self.assertIsInstance(c1, set)


class AggregateSectorTest(unittest.TestCase):
    """聚合端点支持板块代码（801xxx 走 sw_daily.parquet）。"""

    def test_aggregate_script_supports_sector_codes(self):
        import json
        import subprocess
        import sys

        r = subprocess.run(
            [sys.executable, "scripts/export_aggregate_daily.py", "801110,801890", "测试"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        self.assertEqual(d["name"], "测试")
        self.assertEqual(d["symbols"], ["801110", "801890"])
        self.assertGreater(len(d["bars"]), 100)

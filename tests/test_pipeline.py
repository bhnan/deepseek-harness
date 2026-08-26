"""管道基础设施测试（测试点 D1/D4/X1/SYS-2 的部分覆盖）。

覆盖测试点：
- write_asset：合法落盘 / 非法被拒（错误含字段路径）/ NaN 终止 / 原子性无残留
- compute_breadth：市场宽度计算正确（含涨停判定口径）
- 幂等：同数据重写结果一致
"""
import json
import math
import unittest
from pathlib import Path

import pandas as pd

from pipeline import io
from pipeline.collect_market import compute_breadth

GOOD_INDEX = [
    {"代码": "sh000001", "名称": "上证指数", "最新价": 3321.45, "涨跌幅": 0.62,
     "昨收": 3301.0, "成交量": 285455945, "成交额": 3.21e11},
]


class WriteAssetTest(unittest.TestCase):
    def setUp(self):
        self._tmp = Path("/tmp") / "pipeline_test_data"
        self._old_root = io.DATA_ROOT
        io.DATA_ROOT = self._tmp
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def tearDown(self):
        io.DATA_ROOT = self._old_root
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_valid_write_and_read(self):
        path = io.write_asset("index_spot", "2026-08-14", {"indices": GOOD_INDEX})
        self.assertTrue(path.exists())
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema_version"], "1.0")
        self.assertEqual(payload["data"]["indices"][0]["代码"], "sh000001")
        # 中文原文保留（非转义）
        self.assertIn("上证指数", path.read_text(encoding="utf-8"))

    def test_invalid_case_rejected_with_path(self):
        bad = [dict(x, 代码="SH000001") for x in GOOD_INDEX]  # 大写违规
        with self.assertRaises(Exception) as ctx:
            io.write_asset("index_spot", "2026-08-14", {"indices": bad})
        self.assertIn("代码", str(ctx.exception))

    def test_nan_rejected(self):
        bad = [dict(x, 最新价=float("nan")) for x in GOOD_INDEX]
        with self.assertRaises(ValueError):
            io.write_asset("index_spot", "2026-08-14", {"indices": bad})

    def test_atomic_no_tmp_leftover(self):
        io.write_asset("index_spot", "2026-08-14", {"indices": GOOD_INDEX})
        leftovers = list(self._tmp.rglob("*.tmp"))
        self.assertEqual(leftovers, [])

    def test_missing_required_field_rejected(self):
        with self.assertRaises(Exception):
            io.write_asset("index_spot", "2026-08-14", {"indices": [{"代码": "sh000001"}]})

    def test_idempotent_rewrite(self):
        p1 = io.write_asset("index_spot", "2026-08-14", {"indices": GOOD_INDEX})
        p2 = io.write_asset("index_spot", "2026-08-14", {"indices": GOOD_INDEX})
        self.assertEqual(p1.read_text(), p2.read_text())

    def test_manifest_roundtrip_and_tamper(self):
        import hashlib
        io.write_asset("index_spot", "2026-08-14", {"indices": GOOD_INDEX})
        self.assertEqual(io.verify_manifest(), [], "写入后 manifest 应一致")
        # 篡改文件 → 校验必须发现
        p = self._tmp / "market" / "2026-08-14" / "index_spot.json"
        p.write_text(p.read_text(encoding="utf-8") + " ", encoding="utf-8")
        problems = io.verify_manifest()
        self.assertTrue(problems, "篡改后必须报不一致")
        self.assertIn("index_spot.json", problems[0])


class BreadthTest(unittest.TestCase):
    def _df(self, rows):
        cols = ["代码", "名称", "最新价", "涨跌额", "涨跌幅", "买入", "卖出",
                "昨收", "今开", "最高", "最低", "成交量", "成交额", "时间戳"]
        return pd.DataFrame(rows, columns=cols)

    def test_basic_counts(self):
        df = self._df([
            ["sh600001", "A", 11.0, 1.0, 10.0, 0, 0, 10.0, 10.1, 11.0, 10.0, 100, 1e6, "15:30:01"],
            ["sz000002", "B", 9.0, -1.0, -10.0, 0, 0, 10.0, 9.9, 9.5, 9.0, 100, 1e6, "15:30:01"],
            ["sz000003", "C", 10.0, 0.0, 0.0, 0, 0, 10.0, 10.0, 10.0, 10.0, 100, 1e6, "15:30:01"],
        ])
        b = compute_breadth(df)
        self.assertEqual(b["advancers"], 1)
        self.assertEqual(b["decliners"], 1)
        self.assertEqual(b["unchanged"], 1)
        self.assertEqual(b["total_amount"], 3e6)

    def test_limit_up_rounding(self):
        # 昨收 9.09 × 1.1 = 9.999 → 涨停价 round 2 = 10.00
        df = self._df([
            ["sh600001", "A", 10.0, 0.91, 10.01, 0, 0, 9.09, 9.1, 10.0, 9.1, 100, 1e6, "15:30:01"],
            ["sz000002", "B", 9.08, -0.01, -0.11, 0, 0, 9.09, 9.09, 9.09, 9.08, 100, 1e6, "15:30:01"],
        ])
        b = compute_breadth(df)
        self.assertEqual(b["limit_up"], 1)   # A 触及 10.00
        self.assertEqual(b["limit_down"], 0)

    def test_nonpositive_prev_excluded(self):
        df = self._df([
            ["sh600001", "A", 0.0, 0.0, 0.0, 0, 0, 0.0, 0.0, 0.0, 0.0, 0, 0, "15:30:01"],
        ])
        b = compute_breadth(df)
        self.assertEqual(b["advancers"] + b["decliners"] + b["unchanged"], 0)


if __name__ == "__main__":
    unittest.main()

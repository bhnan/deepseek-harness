"""生命周期存储测试（测试点 S1）：版本化不覆盖 / 执行对象不可变 / 校验 fail-fast / 引用完整性。"""
import shutil
import tempfile
import unittest
from pathlib import Path

import lifecycle.store as store


def signal_data(version, sid="signal_001"):
    return {"id": sid, "version": version, "idea_id": "idea_001",
            "statement": "银行涨科技跌时科技相对银行未来10日收益为负",
            "expression": {"metric": "return", "args": {"window": 20}, "op": ">", "value": 0},
            "frequency": "daily", "lookback_period": 20}


def strategy_data(version, signal_version):
    return {"id": "strategy_001", "version": version,
            "signal_id": "signal_001", "signal_version": signal_version,
            "universe_id": "univ_1",
            "entry_rule": {"timing": "next_open"},
            "exit_rule": {"type": "holding_period", "holding_days": 10},
            "portfolio_config_id": "port_default", "execution_config_id": "exec_default"}


def experiment_data(exp_id, signal_version):
    return {"id": exp_id, "signal_id": "signal_001", "signal_version": signal_version,
            "purpose": "strategy_backtest", "dataset_config_id": "ds_1",
            "period": {"start": "2024-01-01", "end": "2026-08-14"},
            "evaluation_plan_id": "eval_default", "status": "created"}


class StoreTest(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp())
        self._old = store.LAB_ROOT
        store.LAB_ROOT = self._tmp

    def tearDown(self):
        store.LAB_ROOT = self._old
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_idea_roundtrip_and_status(self):
        store.save_idea({"id": "idea_001", "title": "银行涨科技跌", "description": "现象",
                         "source": "observation", "status": "draft", "created_at": "2026-08-17T10:00:00+08:00"})
        self.assertEqual(len(store.list_ideas()), 1)
        store.update_idea_status("idea_001", "validated", "2026-08-17T22:00:00+08:00")
        self.assertEqual(store.load_idea("idea_001")["status"], "validated")

    def test_definition_versioned_no_overwrite(self):
        p1 = store.save_definition("signal", signal_data(1))
        p2 = store.save_definition("signal", signal_data(2))
        self.assertNotEqual(p1, p2)
        self.assertEqual(p1.name, "v001.json")
        self.assertEqual(p2.name, "v002.json")
        self.assertEqual(store.list_definition_versions("signal", "signal_001"), [1, 2])
        self.assertEqual(store.load_definition("signal", "signal_001")["version"], 2)
        self.assertEqual(store.load_definition("signal", "signal_001", 1)["version"], 1, "旧版本不被覆盖")

    def test_definition_wrong_version_rejected(self):
        store.save_definition("signal", signal_data(1))
        with self.assertRaises(ValueError):
            store.save_definition("signal", signal_data(1))  # 再写 v1 被拒

    def test_definition_invalid_rejected(self):
        bad = signal_data(1, sid="signal_002")
        bad["expression"] = {"metric": "future_sight", "op": ">", "value": 0}  # schema 不认识的 metric 无枚举约束？
        # expression 在 lifecycle schema 里是结构化 $defs，未知 metric 由 DSL validate 拦；
        # 这里用必填缺失验证 schema 校验生效
        bad2 = signal_data(1, sid="signal_002")
        del bad2["statement"]
        with self.assertRaises(Exception):
            store.save_definition("signal", bad2)

    def test_exec_immutable(self):
        store.save_definition("signal", signal_data(1))
        p = store.save_exec("experiment", experiment_data("exp_001", 1))
        self.assertTrue(p.exists())
        with self.assertRaises(FileExistsError):
            store.save_exec("experiment", experiment_data("exp_001", 1))

    def test_run_and_evaluation_layout(self):
        store.save_definition("signal", signal_data(1))
        store.save_exec("experiment", experiment_data("exp_001", 1))
        run = {"id": "run_001", "experiment_id": "exp_001",
               "started_at": "2026-08-17T20:00:00+08:00", "status": "success",
               "environment": {"engine": "pandas-backtester", "engine_version": "0.1.0",
                               "code_commit": "abc123", "data_version": "v1", "config_hash": "xyz"},
               "resolved_config": {}, "guardrails": {"as_of": True, "t_plus_1_execution": True, "leak_check": True}}
        p = store.save_exec("backtest_run", run)
        self.assertIn("runs/exp_001/run_001.json", str(p))
        self.assertEqual(store.load_exec("backtest_run", "run_001", "exp_001")["status"], "success")

    def test_strategy_dir_spelling(self):
        """防回归：strategy 必须落 lab/strategies/（曾误拼为 strategys 导致完整性检查失明）。"""
        store.save_definition("signal", signal_data(1))
        p = store.save_definition("strategy", strategy_data(1, signal_version=1))
        self.assertIn("strategies/strategy_001", str(p))
        self.assertEqual(store.load_definition("strategy", "strategy_001")["version"], 1)

    def test_integrity(self):
        store.save_definition("signal", signal_data(1))
        store.save_definition("strategy", strategy_data(1, signal_version=1))
        store.save_exec("experiment", experiment_data("exp_001", 1))
        self.assertEqual(store.check_integrity(), [])
        # 引用不存在的 signal 版本 → 报错
        store.save_exec("experiment", experiment_data("exp_002", 99))
        errs = store.check_integrity()
        self.assertEqual(len(errs), 1)
        self.assertIn("signal_001", errs[0])

    def test_config_versioned(self):
        exec_cfg = {"id": "exec_default", "version": 1, "name": "默认执行",
                    "commission_open": 0.0005, "commission_close": 0.0015,
                    "t_plus_1": True, "limit_up_down": True, "min_lot": 100}
        p = store.save_config("execution", exec_cfg)
        self.assertIn("configs/execution/exec_default/v001.json", str(p))
        self.assertEqual(store.load_config("execution", "exec_default")["commission_open"], 0.0005)


if __name__ == "__main__":
    unittest.main()

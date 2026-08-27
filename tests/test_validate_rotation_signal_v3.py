from __future__ import annotations

import sys
import unittest
import json
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_rotation_signal_v3 as subject  # noqa: E402


class RotationSignalV3Tests(unittest.TestCase):
    def test_signed_flow_ratio_tracks_direction_without_future_rows(self) -> None:
        index = pd.date_range("2024-01-01", periods=6, freq="D")
        close = pd.DataFrame({"up": [1, 2, 3, 4, 5, 6], "down": [6, 5, 4, 3, 2, 1]}, index=index, dtype=float)
        amount = pd.DataFrame(100.0, index=index, columns=close.columns)

        flow = subject.signed_flow_ratio(close, amount, 3)

        self.assertGreater(flow.loc[index[-1], "up"], 0.0)
        self.assertLess(flow.loc[index[-1], "down"], 0.0)
        self.assertTrue(np.isnan(flow.loc[index[0], "up"]))

    def test_signal_panel_keeps_flow_separate_from_production_score(self) -> None:
        index = pd.date_range("2020-01-01", periods=320, freq="D")
        close = pd.DataFrame(
            {
                "leader": np.linspace(10.0, 30.0, len(index)),
                "repair": np.concatenate([np.linspace(20.0, 12.0, 250), np.linspace(12.0, 18.0, 70)]),
                "laggard": np.linspace(30.0, 10.0, len(index)),
            },
            index=index,
        )
        amount = pd.DataFrame(100.0, index=index, columns=close.columns)

        panel = subject.build_signal_panel(close, amount)

        self.assertIn("up_score", panel)
        self.assertIn("flow_score", panel)
        self.assertIn("flow_confirmed", panel)
        self.assertFalse(panel["up_score"].equals(panel["up_score_with_flow"]))

    def test_future_price_changes_do_not_rewrite_an_earlier_signal(self) -> None:
        index = pd.date_range("2020-01-01", periods=320, freq="D")
        base = np.linspace(10.0, 30.0, len(index))
        close = pd.DataFrame({"A": base, "B": base[::-1], "C": np.linspace(15.0, 18.0, len(index))}, index=index)
        amount = pd.DataFrame(100.0, index=index, columns=close.columns)
        changed = close.copy()
        changed.loc[index[-20]:, "A"] *= 3.0

        before = subject.build_signal_panel(close, amount)["up_score"]
        after = subject.build_signal_panel(changed, amount)["up_score"]

        pd.testing.assert_series_equal(before.loc[index[-30]], after.loc[index[-30]], check_names=False)

    def test_daily_candidates_returns_three_independent_views(self) -> None:
        index = pd.date_range("2024-01-01", periods=2, freq="D")
        panel = {
            "up_score": pd.DataFrame([[0.8, 0.2], [0.7, 0.3]], index=index, columns=["A", "B"]),
            "down_score": pd.DataFrame([[0.1, 0.9], [0.2, 0.8]], index=index, columns=["A", "B"]),
            "repair_score": pd.DataFrame([[0.4, 0.8], [0.5, 0.7]], index=index, columns=["A", "B"]),
            "flow_score": pd.DataFrame([[0.6, 0.5], [0.6, 0.5]], index=index, columns=["A", "B"]),
        }

        result = subject.daily_candidates(panel, index[-1], top_k=1)

        self.assertEqual(result["leaders"], ["A"])
        self.assertEqual(result["repair_candidates"], ["B"])
        self.assertEqual(result["fading_leaders"], ["B"])
        self.assertEqual(result["candidate_pairs"], [{"old_sector_id": "B", "new_sector_id": "A"}])

    def test_emerging_leader_artifact_keeps_flow_as_confirmation_and_has_guardrails(self) -> None:
        path = ROOT / "lab/strategies/style-rotation-emerging-leader-v3/versions/v001/strategy.json"
        artifact = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(artifact["strategy_id"], "style-rotation-emerging-leader-v3")
        self.assertEqual(artifact["version"], "v001")
        self.assertEqual(artifact["strategy_schema"]["signal_thresholds"]["up_score_min"], 0.80)
        self.assertTrue(artifact["backtest_result"]["guardrails"]["future_label_used_only_for_evaluation"])
        self.assertTrue(artifact["backtest_result"]["guardrails"]["flow_proxy_separated"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

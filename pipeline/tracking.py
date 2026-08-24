"""前向跟踪（测试点 S5）：候选种子 + 到期评分。

- seed：观察日收盘后，按 Signal DSL 扫出候选清单，写 pending 文件
- grade：数据窗口满足（观察日 + horizon 交易日）后，算候选等权收益与相对基准超额，
  产出 contracts/tracking.json 兼容快照并校验落盘；未到期保持 pending
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

import jsonschema

from lifecycle.store import validate as _noop  # noqa: F401  (保持导入顺序明确)
from pipeline.schemas import build_registry, load_schema

LAB_ROOT = Path(__file__).resolve().parent.parent / "lab"
TRACKING_DIR = LAB_ROOT / "tracking"


def seed(experiment_id: str, observation_date: str, candidates: list[dict],
         horizons=(5, 20)) -> Path:
    """写 pending 种子：{experiment_id, observation_date, horizons, candidates, graded: false}。"""
    d = TRACKING_DIR / experiment_id
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"pending_{observation_date}.json"
    path.write_text(json.dumps({
        "experiment_id": experiment_id, "observation_date": observation_date,
        "horizons": list(horizons),
        "candidates": [{"symbol": c["symbol"], "name": c.get("name", "")} for c in candidates],
        "graded": False,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def compute_tracking(candidate_returns: dict[str, float], benchmark_return: float | None) -> dict:
    """纯函数（可单测）：候选等权收益 + 相对基准超额 → tracking 契约数据。"""
    rets = list(candidate_returns.values())
    n = len(rets)
    if n == 0:
        raise ValueError("无候选收益")
    mean = float(np.mean(rets))
    median = float(np.median(rets))
    positive = float(np.mean([1 if r > 0 else 0 for r in rets]))
    rel_mean = mean - benchmark_return if benchmark_return is not None else None
    summary = [{
        "grade": "A", "sample_count": n, "mean_return": round(mean, 6),
        "median_return": round(median, 6), "positive_return_rate": round(positive, 6),
        "mean_relative_return": round(rel_mean, 6) if rel_mean is not None else None,
    }]
    return {
        "observation_date": "",  # 由调用方填
        "horizon_trading_days": 0,
        "sample_count": n,
        "mean_return": round(mean, 6),
        "median_return": round(median, 6),
        "positive_rate": round(positive, 6),
        "mean_relative_return": round(rel_mean, 6) if rel_mean is not None else None,
        "grade_summary": summary,
    }


def _window_return(closes: pd.Series, obs_idx: int, horizon: int) -> float | None:
    """obs 收盘 → obs+horizon 收盘收益；数据不足返回 None。"""
    if obs_idx + horizon >= len(closes):
        return None
    base = closes.iloc[obs_idx]
    end = closes.iloc[obs_idx + horizon]
    if pd.isna(base) or pd.isna(end) or base <= 0:
        return None
    return float(end / base - 1.0)


def grade(experiment_id: str, observation_date: str, closes_by_symbol: dict[str, pd.Series],
          bench: pd.Series, horizons=(5, 20), asof: str | None = None) -> list[Path]:
    """对到期 horizon 产出 tracking 快照（contracts/tracking.json 校验），返回产出路径。

    closes_by_symbol: symbol -> 收盘价 Series（DatetimeIndex 升序）
    bench: 基准收盘 Series
    """
    pending_path = TRACKING_DIR / experiment_id / f"pending_{observation_date}.json"
    if not pending_path.exists():
        raise FileNotFoundError(str(pending_path))
    pending = json.loads(pending_path.read_text(encoding="utf-8"))
    obs = pd.Timestamp(observation_date)
    outputs = []
    registry = build_registry()
    schema = load_schema("contracts/tracking")
    validator = jsonschema.Draft202012Validator(schema, registry=registry)

    for h in horizons:
        if bench.index[-1] < obs:
            continue
        bench_pos = bench.index.get_loc(obs) if obs in bench.index else None
        rets, rel = {}, None
        for c in pending["candidates"]:
            series = closes_by_symbol.get(c["symbol"])
            if series is None or obs not in series.index:
                continue
            pos = series.index.get_loc(obs)
            r = _window_return(series, pos, h)   # 观察日位置向后 h 个交易日（需要观察日之后的数据）
            if r is not None:
                rets[c["symbol"]] = r
        if not rets or (obs + pd.Timedelta(days=h * 2) > pd.Timestamp(asof or pd.Timestamp.now())):
            continue  # 窗口未到期（近似按日历天判断，配合交易日数据不足时也跳过）
        b_ret = None
        if bench_pos is not None:
            b_ret = _window_return(bench, bench_pos, h)
        data = compute_tracking(rets, b_ret)
        data["observation_date"] = observation_date
        data["horizon_trading_days"] = h
        errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
        if errors:
            raise jsonschema.ValidationError(f"tracking 校验失败: {errors[0].message}")
        out = TRACKING_DIR / experiment_id / f"{observation_date}_t{h}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        outputs.append(out)
    return outputs

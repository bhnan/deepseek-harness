"""生命周期 11 件套存储读写（策略生命周期文档 §4 布局）。

原则：
- Idea 可变（收件箱）；定义对象（signal/strategy/配置）版本化——新版本新文件，绝不覆盖；
- 执行对象（experiment/backtest_run/evaluation/conclusion）不可变——写定后重写即报错；
- 所有写入先过 schemas/lifecycle/*.json 校验（fail-fast）。
"""
import json
from pathlib import Path

import jsonschema

from pipeline.schemas import build_registry, load_schema

LAB_ROOT = Path(__file__).resolve().parent.parent / "lab"

DEF_KINDS = {"signal", "strategy"}
EXEC_KINDS = {"experiment", "backtest_run", "evaluation", "conclusion"}
CONFIG_KINDS = {"universe", "dataset", "execution", "portfolio_config"}

_registry = None


def _reg():
    global _registry
    if _registry is None:
        _registry = build_registry()
    return _registry


def validate(kind: str, data: dict) -> None:
    """按 schemas/lifecycle/{kind}.json 校验，不合法抛 jsonschema.ValidationError。"""
    schema = load_schema(f"lifecycle/{kind}")
    v = jsonschema.Draft202012Validator(schema, registry=_reg())
    errs = sorted(v.iter_errors(data), key=lambda e: list(e.absolute_path))
    if errs:
        e = errs[0]
        loc = "/".join(map(str, e.absolute_path)) or "<root>"
        raise jsonschema.ValidationError(f"{kind} 非法 @ {loc}: {e.message}")


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, allow_nan=False),
                   encoding="utf-8")
    tmp.replace(path)  # 原子


# ---------------- Idea（可变收件箱） ----------------
def idea_path(idea_id: str) -> Path:
    return LAB_ROOT / "ideas" / f"{idea_id}.json"


def save_idea(data: dict) -> Path:
    validate("idea", data)
    _write_json(idea_path(data["id"]), data)
    return idea_path(data["id"])


def load_idea(idea_id: str) -> dict:
    return json.loads(idea_path(idea_id).read_text(encoding="utf-8"))


def list_ideas() -> list[dict]:
    p = LAB_ROOT / "ideas"
    if not p.exists():
        return []
    return [json.loads(f.read_text(encoding="utf-8")) for f in sorted(p.glob("*.json"))]


def update_idea_status(idea_id: str, status: str, updated_at: str) -> Path:
    data = load_idea(idea_id)
    data["status"] = status
    data["updated_at"] = updated_at
    return save_idea(data)


# ---------------- 定义对象（版本化） ----------------
_KIND_DIRS = {"signal": "signals", "strategy": "strategies"}


def _version_dir(kind: str, obj_id: str) -> Path:
    return LAB_ROOT / _KIND_DIRS[kind] / obj_id


def _next_version(d: Path) -> int:
    if not d.exists():
        return 1
    nums = [int(p.stem[1:]) for p in d.glob("v*.json")]
    return max(nums, default=0) + 1


def save_definition(kind: str, data: dict) -> Path:
    """signal/strategy：新版本新文件（vNNN.json），旧版本永不覆盖。"""
    if kind not in DEF_KINDS:
        raise ValueError(f"kind 必须属于 {DEF_KINDS}")
    validate(kind, data)
    d = _version_dir(kind, data["id"])
    nxt = _next_version(d)
    if data.get("version") != nxt:
        raise ValueError(f"{kind} {data['id']} 下一版本应为 {nxt}，得到 {data.get('version')}")
    path = d / f"v{nxt:03d}.json"
    _write_json(path, data)
    return path


def load_definition(kind: str, obj_id: str, version: int | None = None) -> dict:
    d = _version_dir(kind, obj_id)
    if version is None:
        versions = sorted(d.glob("v*.json"))
        if not versions:
            raise FileNotFoundError(f"{kind} {obj_id} 无版本")
        return json.loads(versions[-1].read_text(encoding="utf-8"))
    path = d / f"v{version:03d}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def list_definition_versions(kind: str, obj_id: str) -> list[int]:
    d = _version_dir(kind, obj_id)
    if not d.exists():
        return []
    return sorted(int(p.stem[1:]) for p in d.glob("v*.json"))


# ---------------- 配置对象（版本化） ----------------
def save_config(kind: str, data: dict) -> Path:
    """universe/dataset/execution/portfolio_config：configs/{kind}/{id}/vNNN.json。"""
    if kind not in CONFIG_KINDS:
        raise ValueError(f"kind 必须属于 {CONFIG_KINDS}")
    validate(kind, data)
    d = LAB_ROOT / "configs" / kind / data["id"]
    nxt = _next_version(d)
    if data.get("version") != nxt:
        raise ValueError(f"{kind} {data['id']} 下一版本应为 {nxt}，得到 {data.get('version')}")
    path = d / f"v{nxt:03d}.json"
    _write_json(path, data)
    return path


def load_config(kind: str, obj_id: str, version: int | None = None) -> dict:
    d = LAB_ROOT / "configs" / kind / obj_id
    if version is None:
        versions = sorted(d.glob("v*.json"))
        if not versions:
            raise FileNotFoundError(f"{kind} {obj_id} 无版本")
        return json.loads(versions[-1].read_text(encoding="utf-8"))
    return json.loads((d / f"v{version:03d}.json").read_text(encoding="utf-8"))


# ---------------- 执行对象（不可变） ----------------
def exec_path(kind: str, data: dict) -> Path:
    if kind == "experiment":
        return LAB_ROOT / "experiments" / f"{data['id']}.json"
    if kind == "backtest_run":
        return LAB_ROOT / "runs" / data["experiment_id"] / f"{data['id']}.json"
    if kind == "evaluation":
        return LAB_ROOT / "evaluations" / f"{data['id']}.json"
    if kind == "conclusion":
        return LAB_ROOT / "conclusions" / f"{data['id']}.json"
    raise ValueError(f"kind 必须属于 {EXEC_KINDS}")


def save_exec(kind: str, data: dict) -> Path:
    """执行对象：写定后不可变，重复写入抛 FileExistsError。"""
    if kind not in EXEC_KINDS:
        raise ValueError(f"kind 必须属于 {EXEC_KINDS}")
    validate(kind, data)
    path = exec_path(kind, data)
    if path.exists():
        raise FileExistsError(f"执行对象不可变：{path} 已存在，禁止覆盖（生成新 run id 重跑）")
    _write_json(path, data)
    return path


def load_exec(kind: str, key: str, experiment_id: str | None = None) -> dict:
    if kind == "experiment":
        return json.loads((LAB_ROOT / "experiments" / f"{key}.json").read_text(encoding="utf-8"))
    if kind == "backtest_run":
        return json.loads((LAB_ROOT / "runs" / experiment_id / f"{key}.json").read_text(encoding="utf-8"))
    if kind == "evaluation":
        return json.loads((LAB_ROOT / "evaluations" / f"{key}.json").read_text(encoding="utf-8"))
    if kind == "conclusion":
        return json.loads((LAB_ROOT / "conclusions" / f"{key}.json").read_text(encoding="utf-8"))
    raise ValueError(kind)


# ---------------- 引用完整性 ----------------
def check_integrity() -> list[str]:
    """S1-④：strategy/experiment 引用的定义版本必须存在。返回问题清单（空=完整）。"""
    errors = []
    strat_dir = LAB_ROOT / "strategies"
    if strat_dir.exists():
        for d in sorted(strat_dir.iterdir()):
            for p in sorted(d.glob("v*.json")):
                s = json.loads(p.read_text(encoding="utf-8"))
                if s["signal_version"] not in list_definition_versions("signal", s["signal_id"]):
                    errors.append(f"{p.name}: 引用缺失 signal {s['signal_id']}@v{s['signal_version']}")
    exp_dir = LAB_ROOT / "experiments"
    if exp_dir.exists():
        for p in sorted(exp_dir.glob("*.json")):
            e = json.loads(p.read_text(encoding="utf-8"))
            if "signal_version" not in e:
                continue  # 非生命周期实验文件（legacy 资产），跳过
            if e["signal_version"] not in list_definition_versions("signal", e["signal_id"]):
                errors.append(f"{p.name}: 引用缺失 signal {e['signal_id']}@v{e['signal_version']}")
            if e.get("strategy_id") and e.get("strategy_version") not in list_definition_versions(
                    "strategy", e["strategy_id"]):
                errors.append(f"{p.name}: 引用缺失 strategy {e['strategy_id']}@v{e.get('strategy_version')}")
    return errors

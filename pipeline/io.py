"""资产写出：schema 校验 + 防变形 + 原子落盘。所有管道代码必须经 write_asset 落盘。

防变形清单（数据 schema 规范 §3）：
- allow_nan=False：NaN/Infinity 出现即抛错终止，绝不写出非法 JSON
- ensure_ascii=False + UTF-8
- 原子写：临时文件 + rename，崩溃不留半截文件
- schema 校验 fail-fast：不合法绝不落盘
"""
import hashlib
import json
import os
import tempfile
from pathlib import Path

import jsonschema

from .schemas import build_registry, load_schema

DATA_ROOT = Path(__file__).resolve().parent.parent / "data"
SCHEMA_VERSION = "1.0"

# 资产 → data/ 下子目录（数据需求文档 §3 布局）
ASSET_SUBDIR = {
    "index_spot": "market",
    "a_spot": "market",
    "sw_l1_spot": "sector",
    "announcements": "events",
    "portfolio": "portfolio",
    "signals": "signals",
    "review": "review",
}

_registry = None


def _get_registry():
    global _registry
    if _registry is None:
        _registry = build_registry()
    return _registry


def validate(asset: str, data: dict) -> None:
    """校验资产 data（顶层包 schema_version + data）。不合法抛 jsonschema.ValidationError。"""
    schema = load_schema(f"assets/{asset}")
    payload = {"schema_version": SCHEMA_VERSION, "data": data}
    validator = jsonschema.Draft202012Validator(schema, registry=_get_registry())
    errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.absolute_path))
    if errors:
        e = errors[0]
        loc = "/".join(str(p) for p in e.absolute_path) or "<root>"
        raise jsonschema.ValidationError(f"{asset} 数据非法 @ {loc}: {e.message}")


def write_asset(asset: str, trading_date: str, data: dict, subdir: str | None = None,
                data_quality: dict | None = None) -> Path:
    """校验并原子写入 data/<subdir>/<trading_date>/<asset>.json，返回落盘路径。

    data_quality: 可选缺失标注 {"missing": [...], "note": "..."}，写入顶层。
    """
    validate(asset, data)
    out_dir = DATA_ROOT / (subdir or ASSET_SUBDIR[asset]) / trading_date
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{asset}.json"

    payload = {"schema_version": SCHEMA_VERSION, "data": data}
    if data_quality:
        payload["data_quality"] = data_quality
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=1)

    fd, tmp = tempfile.mkstemp(dir=str(out_dir), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, out_path)  # 原子替换
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    _record_manifest(str(out_path.relative_to(DATA_ROOT)), out_path)
    return out_path


def read_asset(asset: str, trading_date: str, subdir: str | None = None) -> dict:
    """读回已落盘资产（含顶层信封）。"""
    path = DATA_ROOT / (subdir or ASSET_SUBDIR[asset]) / trading_date / f"{asset}.json"
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------- 数据完整性 manifest（测试点 SYS-6） ----------------
def _manifest_file() -> Path:
    return DATA_ROOT / ".manifest.json"   # 调用时求值（测试可 monkeypatch DATA_ROOT）


def _manifest() -> dict:
    if _manifest_file().exists():
        return json.loads(_manifest_file().read_text(encoding="utf-8"))
    return {"files": {}}


def _record_manifest(rel: str, path: Path) -> None:
    """落盘后登记 {size, sha256, written_at}。"""
    data = path.read_bytes()
    m = _manifest()
    m["files"][rel] = {
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "written_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    }
    _manifest_file().write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


def verify_manifest() -> list[str]:
    """重算全部登记文件的 sha256，返回不一致/缺失清单（空=完整）。"""
    problems = []
    m = _manifest()
    for rel, meta in m["files"].items():
        path = DATA_ROOT / rel
        if not path.exists():
            problems.append(f"{rel}: 缺失")
            continue
        if path.stat().st_size != meta["size"] or \
                hashlib.sha256(path.read_bytes()).hexdigest() != meta["sha256"]:
            problems.append(f"{rel}: 内容不一致（损坏或被修改）")
    return problems

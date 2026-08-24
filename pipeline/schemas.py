"""共享 JSON Schema 注册表：管道写出校验与契约测试共用同一来源，杜绝两侧 schema 漂移。"""
import json
from pathlib import Path

from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = ROOT / "schemas"


def build_registry() -> Registry:
    """把 schemas/ 下所有 JSON Schema 按 $id 注册进内存 Registry（$ref 不碰网络）。

    fixtures/ 下是数据样例不是 schema，不注册。
    """
    resources = []
    for path in sorted(SCHEMAS_DIR.rglob("*.json")):
        if "fixtures" in path.parts:
            continue
        schema = json.loads(path.read_text(encoding="utf-8"))
        key = schema.get("$id", str(path.relative_to(ROOT)))
        resources.append((key, Resource.from_contents(schema)))
    return Registry().with_resources(resources)


def load_schema(name: str) -> dict:
    """按 'assets/index_spot' 或完整路径加载 schema。"""
    path = SCHEMAS_DIR / name
    if path.suffix != ".json":
        path = path.with_suffix(".json")
    return json.loads(path.read_text(encoding="utf-8"))

"""Schema 契约测试与校验工具。

用法：
  # 1) 校验 schema 文件本身合法且 $ref 可解析（全部 schema）
  python scripts/validate_schemas.py --check-schemas

  # 2) 校验某个资产数据文件
  python scripts/validate_schemas.py --check-data schemas/assets/index_spot.json data/market/2026-08-14/index_spot.json

设计：JSON Schema 为唯一事实来源（schemas/），本脚本是 Python 侧的校验入口。
管道写出必须调用 pipeline.io.write_asset（内部走同一套 registry 校验），前端 zod 侧另备。
"""
import argparse
import json
import sys
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.schemas import SCHEMAS_DIR, build_registry, load_schema  # noqa: E402  共享注册表（单一事实来源）


def check_schemas() -> int:
    registry = build_registry()
    failures = 0
    for path in sorted(SCHEMAS_DIR.rglob("*.json")):
        if "fixtures" in path.parts:
            continue
        try:
            schema = json.loads(path.read_text(encoding="utf-8"))
            # 用自身 + registry 做一次自校验（$ref 解析 + 语法合法性）
            validator = jsonschema.Draft202012Validator(schema, registry=registry)
            validator.check_schema(schema)
            print(f"  OK  {path.relative_to(ROOT)}")
        except Exception as e:
            failures += 1
            print(f"FAIL  {path.relative_to(ROOT)}: {e}")
    print(f"schema 自检: {failures} 个失败")
    return 1 if failures else 0


def check_data(schema_ref: str, data_path: str) -> int:
    registry = build_registry()
    schema = load_schema(schema_ref.removeprefix("schemas/"))
    data = json.loads(Path(data_path).read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema, registry=registry)
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    if errors:
        for e in errors[:20]:
            loc = "/".join(str(p) for p in e.absolute_path) or "<root>"
            print(f"FAIL  {loc}: {e.message}")
        return 1
    print(f"OK    {data_path} 通过 {schema_ref}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check-schemas", action="store_true", help="自检全部 schema")
    parser.add_argument("--check-data", nargs=2, metavar=("SCHEMA", "DATA_JSON"), help="校验一个数据文件")
    args = parser.parse_args()
    if args.check_schemas:
        return check_schemas()
    if args.check_data:
        return check_data(*args.check_data)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())

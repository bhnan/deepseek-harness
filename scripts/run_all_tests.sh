#!/bin/bash
# 一键全量测试：Python(unittest) + Node(路由) + Schema 自检 + 契约样例
set -euo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate

echo "== 1/3 Python 单元测试 =="
python -m unittest discover -s tests

echo "== 2/3 Schema 自检 =="
python scripts/validate_schemas.py --check-schemas | tail -1

echo "== 3/3 Node 路由测试 =="
node tests/plugin_route.test.mjs | grep -E "^ℹ (pass|fail)"

echo "全部通过 ✓"

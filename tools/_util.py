"""tools 公共工具：数据根、信封读取、输出与退出码约定。

退出码约定（spec §3）：
  0  成功
  1  数据缺失/业务错误（DataError）
  2  参数错误（ParamError）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = REPO_ROOT / "data"
PYTHON = REPO_ROOT / ".venv" / "bin" / "python"


class DataError(Exception):
    """数据缺失/业务错误 → 退出码 1。"""


class ParamError(Exception):
    """参数错误 → 退出码 2。"""


def load_json(path: Path) -> dict:
    """读 JSON 文件，损坏/不存在抛 DataError。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise DataError(f"not_found: {path.relative_to(REPO_ROOT)}") from e
    except json.JSONDecodeError as e:
        raise DataError(f"corrupted: {path.relative_to(REPO_ROOT)} ({e})") from e


def read_asset(asset: str, trading_date: str, subdir: str | None = None) -> dict:
    """读已落盘资产信封（复用 pipeline.io 的布局；不做写、不做 schema 校验——读侧快速透传）。

    返回完整信封 {schema_version, data, data_quality?}；缺失抛 DataError。
    """
    from pipeline.io import ASSET_SUBDIR

    sub = subdir or ASSET_SUBDIR[asset]
    path = DATA_ROOT / sub / trading_date / f"{asset}.json"
    return load_json(path)


def read_file(path: Path) -> dict:
    """读任意 JSON 资产文件（含 data/ 根下的，如 watchlist.json）。"""
    return load_json(path)


def emit(obj: dict) -> None:
    """成功输出：JSON 到 stdout（allow_nan=False，NaN 出现即抛错，与管道约定一致）。"""
    print(json.dumps(obj, ensure_ascii=False, indent=1, allow_nan=False))


def fail(err: Exception | str, code: int) -> "None":
    """错误输出：{error: ...} 到 stderr，非零退出。"""
    print(json.dumps({"error": str(err)}, ensure_ascii=False), file=sys.stderr)
    sys.exit(code)

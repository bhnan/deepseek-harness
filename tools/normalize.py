"""代码规范化（tools 唯一入口，spec §5 红线）。

接受：裸代码（600519）、带前缀（sh600519）、后缀（600519.SH）、名称（贵州茅台）。
输出：统一 `sh/sz/bj+6位`；行业代码校验 `801xxx`。
"""
from __future__ import annotations

import re

from ._util import DATA_ROOT, DataError, ParamError

CODE_RE = re.compile(r"^(sh|sz|bj)(\d{6})$")
BARE_RE = re.compile(r"^(\d{6})$")
DOT_RE = re.compile(r"^(\d{6})\.(SH|SZ|BJ)$")
SECTOR_RE = re.compile(r"^801\d{3}$")


def to_symbol(code: str) -> str:
    """任意形态 → 带前缀 6 位代码；非法抛 ParamError。"""
    c = (code or "").strip()
    m = CODE_RE.match(c.lower())
    if m:
        return m.group(0)
    m = DOT_RE.match(c)
    if m:
        return m.group(2).lower() + m.group(1)
    m = BARE_RE.match(c)
    if m:
        digits = m.group(1)
        # 与真实数据前缀一致：6 开头→沪，4/8/9 开头→北（920 等北交所），其余→深
        if digits.startswith("6"):
            return "sh" + digits
        if digits.startswith(("4", "8", "9")):
            return "bj" + digits
        return "sz" + digits
    raise ParamError(f"bad_symbol: {code}")


def is_sector(code: str) -> bool:
    """行业代码（801xxx）校验。"""
    return bool(SECTOR_RE.match(str(code).strip()))


def _spot_quotes(date: str) -> dict[str, dict]:
    """当日精简行情表 code → {名称, 最新价, 涨跌幅}（quotes_subset 优先，回退 a_spot）。"""
    from ._util import read_asset

    try:
        q = read_asset("quotes_subset", date, subdir="market")
        return q["data"]["quotes"] or {}
    except DataError:
        pass
    a = read_asset("a_spot", date)
    stocks = a["data"].get("stocks") or []
    return {s["代码"]: {"名称": s["名称"], "最新价": s["最新价"], "涨跌幅": s["涨跌幅"]} for s in stocks}


def resolve_name(name: str, date: str | None = None) -> str:
    """名称 → 代码（查询当日精简行情表）。date 缺省用最近有数据交易日。"""
    from .dates import latest

    d = date or latest()
    if not d:
        raise DataError("no_data")
    for code, info in _spot_quotes(d).items():
        if info.get("名称") == name.strip():
            return code
    raise ParamError(f"unknown_name: {name}")


def normalize(code_or_name: str, date: str | None = None) -> str:
    """统一入口：名称→代码，代码→带前缀。"""
    c = (code_or_name or "").strip()
    if not c:
        raise ParamError("empty_symbol")
    if SECTOR_RE.match(c) or CODE_RE.match(c.lower()):
        return c.lower() if CODE_RE.match(c.lower()) else c
    if DOT_RE.match(c) or BARE_RE.match(c):
        return to_symbol(c)
    # 非纯代码 → 按名称解析
    return resolve_name(c, date)

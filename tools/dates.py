"""层 1 时间原语：dates(n|区间)、latest（I-01/I-02）。

"有数据"判定 = 该日 market/{date}/index_spot.json 已落盘（与 latestDate() 一致）。
"""
from __future__ import annotations

from datetime import datetime

from ._util import DATA_ROOT, load_json

CALENDAR_FILE = DATA_ROOT / "calendar" / "trade_dates.json"


def _calendar() -> list[str]:
    return sorted(load_json(CALENDAR_FILE))


def _has_data(d: str) -> bool:
    return (DATA_ROOT / "market" / d / "index_spot.json").exists()


def _today(asof: str | None = None) -> str:
    return asof or datetime.now().strftime("%Y-%m-%d")


def _pool(asof: str | None = None) -> list[str]:
    today = _today(asof)
    return [d for d in _calendar() if d <= today and _has_data(d)]


def latest(asof: str | None = None) -> str | None:
    """最近有数据交易日（含回退）；无数据返回 None。"""
    pool = _pool(asof)
    return pool[-1] if pool else None


def dates(n: int | None = None, start: str | None = None, end: str | None = None,
          asof: str | None = None) -> list[str]:
    """最近 n 个有数据交易日（缺省 5），或 [start, end] 区间内有数据日。

    返回升序日期列表；无数据返回空列表（不抛错）。
    """
    pool = _pool(asof)
    if start or end:
        s = start or pool[0] if pool else "0000-00-00"
        e = end or (pool[-1] if pool else "9999-12-31")
        return [d for d in pool if s <= d <= e]
    return pool[-(n or 5):]

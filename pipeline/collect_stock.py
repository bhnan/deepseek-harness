"""A7/A8/A9 个股数据：日线（on-demand + 本地缓存 + 增量）、估值序列、财务摘要。

原则：字段 = AKShare 原列名原样透传；日线用新浪（项目禁用 EM；腾讯半残，实测记录见数据需求文档）。
"""
import json
from pathlib import Path

import pandas as pd

from .io import DATA_ROOT

STOCK_DIR = DATA_ROOT / "stock"
DAILY_DIR = STOCK_DIR / "daily"
VALUATION_DIR = STOCK_DIR / "valuation"
FINANCIAL_DIR = STOCK_DIR / "financial"


def normalize_symbol(symbol: str) -> str:
    """600519 → sh600519；sh600519 → sh600519（源形态，新浪小写前缀）。"""
    s = symbol.strip().lower()
    if s[:2] in ("sh", "sz", "bj"):
        return s
    if s.startswith("6"):
        return "sh" + s
    return "sz" + s


def six_digit(symbol: str) -> str:
    return normalize_symbol(symbol)[2:]


def daily_path(symbol: str, adjust: str) -> Path:
    return DAILY_DIR / normalize_symbol(symbol) / f"{adjust}.parquet"


def fetch_daily(symbol: str, adjust: str = "hfq", start: str = "20050101") -> Path:
    """A7：个股日线。首次全量拉取；已有缓存则从最后日期+1 增量。"""
    import akshare as ak

    sym = normalize_symbol(symbol)
    path = daily_path(sym, adjust)
    today = pd.Timestamp.now().strftime("%Y%m%d")
    if path.exists():
        old = pd.read_parquet(path)
        if not old.empty and "date" in old.columns:
            last = str(old["date"].max())[:10].replace("-", "")
            if last >= today:
                return path
            start = str(int(last) + 1)
        else:
            start = "20050101"   # 旧缓存为空/损坏 → 全量重拉
    df = ak.stock_zh_a_daily(symbol=sym, start_date=start, end_date=today, adjust=adjust)
    if df is None or df.empty:
        raise ValueError(f"{sym} 数据源无数据（代码可能不存在或已退市）")
    if path.exists():
        old = pd.read_parquet(path)
        df = pd.concat([old, df], ignore_index=True).drop_duplicates("date").sort_values("date")
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    return path


def fetch_daily_factor(symbol: str, start: str = "20050101") -> Path:
    """B1 配套：后复权因子（qfq-factor/hfq-factor 双态之一）。"""
    import akshare as ak

    sym = normalize_symbol(symbol)
    path = DAILY_DIR / sym / "hfq_factor.parquet"
    today = pd.Timestamp.now().strftime("%Y%m%d")
    df = ak.stock_zh_a_daily(symbol=sym, start_date=start, end_date=today, adjust="hfq-factor")
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    return path


def fetch_valuation(symbol: str, indicators=("市盈率(TTM)", "市净率", "总市值")) -> Path:
    """A8：估值序列（百度股市通，date/value 历史序列，支持 PE Band）。"""
    import akshare as ak

    sym = six_digit(symbol)
    frames = []
    for ind in indicators:
        df = ak.stock_zh_valuation_baidu(symbol=sym, indicator=ind, period="全部")
        df["indicator"] = ind
        frames.append(df)
    path = VALUATION_DIR / f"{sym}.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.concat(frames, ignore_index=True).to_parquet(path, index=False)
    return path


def fetch_financial(symbol: str) -> Path:
    """A9：财务摘要（同花顺，按报告期，字段原样）。"""
    import akshare as ak

    sym = six_digit(symbol)
    df = ak.stock_financial_abstract_ths(symbol=sym, indicator="按报告期")
    path = FINANCIAL_DIR / f"{sym}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"symbol": sym, "rows": df.to_dict(orient="records")},
                   ensure_ascii=False, indent=1, default=str),
        encoding="utf-8")
    return path

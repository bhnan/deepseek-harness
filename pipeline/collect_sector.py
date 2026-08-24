"""A5/A6 申万行业：分类映射（L1+估值）、行业收盘快照（两源 join + derived 涨跌幅）、行业日线。

原则：两侧源字段原样透传（index_realtime_sw 与 sw_index_first_info），join 归管道内部，
derived.change_pct = 涨跌幅（源没有，管道自算）。
"""
import json
import time
from pathlib import Path

import pandas as pd

from .io import DATA_ROOT, write_asset

SECTOR_DIR = DATA_ROOT / "sector"
SW_L1_INFO = SECTOR_DIR / "sw_l1_info.json"
COMPONENTS_DIR = SECTOR_DIR / "components"
SW_DAILY = SECTOR_DIR / "sw_daily.parquet"

INFO_FIELDS = ["行业代码", "行业名称", "成份个数", "静态市盈率", "TTM(滚动)市盈率", "市净率", "静态股息率"]


def load_l1_info() -> list[dict]:
    return json.loads(SW_L1_INFO.read_text(encoding="utf-8"))["industries"]


def l1_codes() -> list[str]:
    return [str(r["行业代码"]).split(".")[0] for r in load_l1_info()]


def collect_sw_map() -> Path:
    """A5：申万一级行业映射（含行业估值），字段原样。月度更新。"""
    import akshare as ak

    df = ak.sw_index_first_info()
    SW_L1_INFO.parent.mkdir(parents=True, exist_ok=True)
    SW_L1_INFO.write_text(
        json.dumps({"industries": df.to_dict(orient="records")}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    return SW_L1_INFO


def collect_sw_components(limit: int | None = None, rate: float = 0.5) -> Path:
    """A5：逐行业成分股（含权重）。31 次调用，带限速。"""
    import akshare as ak

    COMPONENTS_DIR.mkdir(parents=True, exist_ok=True)
    for code in l1_codes()[:limit]:
        path = COMPONENTS_DIR / f"{code}.json"
        if path.exists():
            continue
        df = ak.index_component_sw(symbol=code)
        path.write_text(df.to_json(orient="records", force_ascii=False, indent=1),
                        encoding="utf-8")
        time.sleep(rate)
    return COMPONENTS_DIR


def merge_sw_spot(rt_rows: list[dict], info_rows: list[dict]) -> list[dict]:
    """两源 join（纯函数，可单测）：realtime 原字段 + first_info 原字段 + derived.change_pct。"""
    by_code = {str(r["行业代码"]).split(".")[0]: r for r in info_rows}
    out = []
    for row in rt_rows:
        code = str(row["指数代码"])
        merged = dict(row)
        info = by_code.get(code, {})
        for k in INFO_FIELDS:
            if k in info:
                merged[k] = info[k]
        prev, px = merged.get("昨收盘"), merged.get("最新价")
        if prev is None or px is None or prev <= 0:
            raise ValueError(f"行业 {code} 昨收盘/最新价缺失，无法算涨跌幅（fail-fast）")
        merged["derived"] = {"change_pct": round((px / prev - 1) * 100, 4)}
        out.append(merged)
    return out


def collect_sw_spot(trading_date: str) -> Path:
    """A6：申万一级行业收盘快照。index_realtime_sw('一级行业') 单次全量。"""
    import akshare as ak

    rt = ak.index_realtime_sw(symbol="一级行业")
    industries = merge_sw_spot(rt.to_dict(orient="records"), load_l1_info())
    return write_asset("sw_l1_spot", trading_date, {"industries": industries})


def collect_sw_daily(rate: float = 0.5) -> Path:
    """A6：行业日线（动量曲线用）。31 次调用限速；全量重写 parquet。"""
    import akshare as ak

    frames = []
    for code in l1_codes():
        df = ak.index_hist_sw(symbol=code, period="day")
        df["code"] = code
        frames.append(df[["code", "日期", "收盘", "开盘", "最高", "最低", "成交量", "成交额"]])
        time.sleep(rate)
    all_df = pd.concat(frames, ignore_index=True)
    all_df.to_parquet(SW_DAILY, index=False)
    return SW_DAILY


def collect_members_spot(trading_date: str) -> Path:
    """板块成分股当日行情快照（预计算）：sector/<date>/members_spot.json。

    前端板块页"领涨/领跌"直接加载本文件（KB~百 KB 级），不再下载 1.9MB
    全市场 a_spot 快照现算。结构：
      {"schema_version": "1.0", "data": {"by_sector": {"801080": [{代码,名称,涨跌幅,最新价}, ...], ...}}}
    依赖 market/<date>/a_spot.json 已落盘；无行情的成分股跳过（前端不显示 0）。
    """
    import json as _json

    a_spot_path = DATA_ROOT / "market" / trading_date / "a_spot.json"
    if not a_spot_path.exists():
        raise RuntimeError(f"a_spot 缺失，无法预计算成分股行情: {a_spot_path}")
    a_spot = _json.loads(a_spot_path.read_text(encoding="utf-8"))
    # 全市场 {6位代码: {名称, 涨跌幅, 最新价}}
    px = {}
    for s in a_spot["data"]["stocks"]:
        code = str(s["代码"])
        px[code[2:]] = {
            "代码": code[2:],
            "名称": s["名称"],
            "涨跌幅": s.get("涨跌幅"),
            "最新价": s.get("最新价"),
        }
    by_sector = {}
    for f in sorted(COMPONENTS_DIR.glob("*.json")):
        if f.name.startswith("._"):
            continue  # 跳过 macOS AppleDouble 元数据文件（._xxx.json）
        ticker = f.stem
        rows = []
        for m in _json.loads(f.read_text(encoding="utf-8")):
            q = px.get(str(m["证券代码"]))
            if q is None:
                continue  # 无行情（停牌/未上市）→ 跳过
            rows.append({"代码": q["代码"], "名称": q["名称"], "涨跌幅": q["涨跌幅"], "最新价": q["最新价"]})
        by_sector[ticker] = rows
    out_dir = DATA_ROOT / "sector" / trading_date
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "members_spot.json"
    payload = {"schema_version": "1.0", "data": {"by_sector": by_sector}}
    tmp = out.with_suffix(".tmp")
    tmp.write_text(_json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(out)  # 原子替换
    return out

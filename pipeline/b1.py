"""B1 股票池日线库：hfq + 复权因子双存，限速 + 断点续传 + 每日增量。

数据源：新浪 stock_zh_a_daily（实测唯一可靠日线源；腾讯半残、东财禁用——数据需求文档 §3.2）。
每只股票完成后立即记入 state，中断重跑不重复。
"""
import json
import time
from pathlib import Path

from .collect_stock import fetch_daily, fetch_daily_factor, normalize_symbol
from .io import DATA_ROOT

B1_STATE = DATA_ROOT / "stock" / "b1_state.json"


def load_state() -> dict:
    if B1_STATE.exists():
        return json.loads(B1_STATE.read_text(encoding="utf-8"))
    return {"done": [], "updated_at": None}


def save_state(state: dict) -> None:
    B1_STATE.parent.mkdir(parents=True, exist_ok=True)
    B1_STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def build(symbols: list[str], rate: float = 0.6, resume: bool = True) -> dict:
    """全量建库。resume=True 时跳过 state.done 中的标的（断点续传）；
    单只失败记入 state.failed 并继续（不阻塞整体）。"""
    state = load_state()
    done = set(state["done"])
    failed = state.setdefault("failed", [])
    built, skipped, errors = [], [], []
    for sym in symbols:
        s = normalize_symbol(sym)
        if resume and s in done:
            skipped.append(s)
            continue
        try:
            fetch_daily(s, adjust="hfq")
            fetch_daily_factor(s)
        except Exception as e:
            errors.append(s)
            failed.append(s)
            state["failed"] = failed
            save_state(state)
            print(f"[fail] {s}: {type(e).__name__} {str(e)[:80]}", flush=True)
            time.sleep(rate)
            continue
        done.add(s)
        state["done"] = sorted(done)
        save_state(state)          # 每只落盘，崩溃不丢进度
        built.append(s)
        time.sleep(rate)
    return {"built": built, "skipped": skipped, "failed": errors}


CDR_SYMBOLS = {"sh689009"}   # 文档明确：CDR 需专用接口，日线接口不可用（建库已知失败项）


def update(trading_date: str, rate: float = 0.6) -> dict:
    """每日增量：对已入库标的追加当日行（fetch_daily 自带增量逻辑）。单只失败不阻塞。"""
    state = load_state()
    count, failed = 0, []
    for s in state["done"]:
        if s in CDR_SYMBOLS:
            continue
        try:
            fetch_daily(s, adjust="hfq")
            count += 1
        except Exception as e:
            failed.append(s)
            print(f"[fail] {s}: {type(e).__name__} {str(e)[:80]}", flush=True)
        time.sleep(rate)
    state["updated_at"] = trading_date
    save_state(state)
    return {"updated": count, "failed": failed}

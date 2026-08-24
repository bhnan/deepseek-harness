"""A12 自选清单 + A10 公告/新闻事件。

- 自选清单：用户手动维护 data/watchlist.json；空清单是合法状态（前端显示引导态）
- 公告：巨潮 cninfo 按自选标的近 N 日全量（无条数限制）；derived 严重度为关键词初筛，
  明确标注"自动初筛，待 agent 复核"——LLM 复核后覆盖
- 快讯：财联社电报最近 20 条（覆盖窗口有限，coverage_note 说明）
"""
import json
from datetime import timedelta
from pathlib import Path

import pandas as pd

from .io import DATA_ROOT, write_asset

WATCHLIST_FILE = DATA_ROOT / "watchlist.json"

# 快讯补充源开关：cls 挂起已弃用；改用 ths/sina（子进程硬超时，worker 见 scripts/fetch_flashes.py）
FLASHES_ENABLED = True

# 关键词初筛（v0 规则版严重度；LLM 复核为最终口径）
SEVERITY_RULES = [
    ("high", ["立案", "退市", "终止上市", "处罚", "违约", "爆雷", "暂停上市", "风险警示", "特别处理", "破产"]),
    ("medium", ["减持", "质押", "问询", "关注函", "警示", "诉讼", "预亏", "亏损", "重组", "解禁"]),
]


def load_watchlist() -> dict:
    """自选清单；不存在则创建默认空清单。兼容 groups（组合）与旧 symbols 两种结构。"""
    if not WATCHLIST_FILE.exists():
        WATCHLIST_FILE.parent.mkdir(parents=True, exist_ok=True)
        WATCHLIST_FILE.write_text(json.dumps({"symbols": [], "note": "自选清单，用户手动维护"}, ensure_ascii=False, indent=1), encoding="utf-8")
    data = json.loads(WATCHLIST_FILE.read_text(encoding="utf-8"))
    # groups[].symbols 优先（新结构），回退顶层 symbols（旧结构）
    symbols = [s for g in data.get("groups", []) for s in g.get("symbols", [])]
    if not symbols:
        symbols = data.get("symbols", [])
    data["symbols"] = list(dict.fromkeys(symbols))   # 去重
    return data


def classify_severity(title: str) -> str:
    """关键词初筛严重度（纯函数，可单测）。"""
    text = str(title)
    for sev, keys in SEVERITY_RULES:
        if any(k in text for k in keys):
            return sev
    return "low"


def collect_events(trading_date: str, symbols: list[str] | None = None,
                   lookback_days: int = 7) -> Path:
    """A10：公告（自选范围）+ 快讯，一个文件落盘。"""
    import akshare as ak

    if symbols is None:
        symbols = load_watchlist().get("symbols", [])
    end = pd.Timestamp(trading_date)
    start = (end - timedelta(days=lookback_days)).strftime("%Y%m%d")
    end_s = end.strftime("%Y%m%d")

    announcements = []
    for sym in symbols:
        code = sym if sym.isdigit() else sym[-6:]
        try:
            df = ak.stock_zh_a_disclosure_report_cninfo(
                symbol=code, market="沪深京", start_date=start, end_date=end_s)
        except Exception as e:  # 单标的失败不阻塞整体
            print(f"[warn] 公告采集失败 {sym}: {e}")
            continue
        for _, row in df.iterrows():
            rec = {k: row[k] for k in ["代码", "简称", "公告标题", "公告时间", "公告链接"] if k in row}
            rec["derived"] = {
                "event_type": "announcement",
                "severity": classify_severity(row.get("公告标题", "")),
                "note": "自动初筛，待 agent 复核",
                "symbol": sym,
            }
            announcements.append(rec)

    flashes = []
    if FLASHES_ENABLED:
        flashes = _run_flashes()
    if FLASHES_ENABLED:
        coverage = (f"公告覆盖自选 {len(symbols)} 只、近 {lookback_days} 日（巨潮全量）；"
                    f"快讯来自同花顺/新浪财经快讯，最近约 {len(flashes)} 条（全局快讯，覆盖有限）")
    else:
        coverage = (f"公告覆盖自选 {len(symbols)} 只、近 {lookback_days} 日（巨潮全量）；"
                    f"快讯来自同花顺/新浪财经快讯（最近约 20 条）")
    return write_asset(
        "announcements", trading_date,
        {"announcements": announcements, "flashes": flashes,
         "derived": {"coverage_note": coverage}})


def fetch_flashes(timeout: int = 30) -> list[dict]:
    """快讯（补充源）：独立子进程硬超时（stdin/cron 均安全），ths 优先 sina 回退。"""
    import json as _json
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    worker = root / "scripts" / "fetch_flashes.py"
    python = root / ".venv" / "bin" / "python"
    try:
        r = subprocess.run([str(python), str(worker)], capture_output=True,
                           text=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[:200])
        return _json.loads(r.stdout.strip())
    except Exception as e:
        print(f"[warn] 快讯采集降级（补充源）: {type(e).__name__}")
        return []


def _run_flashes() -> list[dict]:
    try:
        return fetch_flashes()
    except Exception as e:
        print(f"[warn] 快讯采集降级（补充源，不影响主数据）: {type(e).__name__}")
        return []

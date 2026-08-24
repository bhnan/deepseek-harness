"""盘后管道主入口（每交易日 16:30 后，cron 触发或手动）。

顺序（数据需求文档 D3/测试点 D3）：
日历检查 → 市场快照（A2/A4）→ 申万（A5 映射 stale 检查 + A6 快照）→ 事件（A10）→
信号（A13）→ 复盘骨架（A14）→ B1 增量。单资产失败不阻塞其他（测试点 D3-②）。
"""
import argparse
import json
import sys
import traceback
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.collect_market import collect_calendar, latest_trading_date, run_market
from pipeline.io import DATA_ROOT


def is_trading_day(day: str) -> bool:
    cal = DATA_ROOT / "calendar" / "trade_dates.json"
    dates = json.loads(cal.read_text(encoding="utf-8"))
    return day in dates


def main(trading_date: str | None = None) -> dict:
    results = {}
    collect_calendar()
    day = trading_date or latest_trading_date()
    if not is_trading_day(day):
        return {"skipped": f"{day} 非交易日"}

    steps = [("market", lambda: run_market(day))]
    try:
        from pipeline.collect_signals import collect_index_daily
        steps.append(("index_daily", lambda: str(collect_index_daily(day))))
    except ImportError:
        pass
    try:
        from pipeline.collect_sector import (SW_L1_INFO, collect_sw_map, collect_sw_spot)
        if not SW_L1_INFO.exists():
            steps.append(("sw_map", collect_sw_map))
        steps.append(("sw_spot", lambda: str(collect_sw_spot(day))))
        # 板块成分股行情预计算（前端板块页领涨/领跌直接加载，不现算）
        from pipeline.collect_sector import collect_members_spot
        steps.append(("sector_members_spot", lambda: str(collect_members_spot(day))))
    except ImportError:
        pass
    steps += [
        ("events", lambda: str(_events(day))),
        ("signals", lambda: str(_signals(day))),
        ("review", lambda: str(_review(day))),
        ("tracking_grade", lambda: str(_grade())),
        ("b1_update", lambda: f"updated={_b1(day)}"),
    ]
    # 按需子集行情（watchlist + signals 成分；依赖 a_spot 与 signals.json 已落盘）
    try:
        from pipeline.collect_market import collect_quotes_subset
        steps.append(("quotes_subset", lambda: str(collect_quotes_subset(day))))
    except ImportError:
        pass
    for name, fn in steps:
        try:
            results[name] = fn()
            print(f"[ok] {name}: {results[name]}")
        except Exception as e:  # 单资产失败不阻塞（测试点 D3-②）
            results[name] = f"FAILED: {e}"
            print(f"[fail] {name}: {e}\n{traceback.format_exc(limit=2)}")
    return results


def _events(day):
    from pipeline.collect_events import collect_events
    return collect_events(day)


def _signals(day):
    from pipeline.collect_signals import collect_signals
    return collect_signals(day)


def _review(day):
    # 数字骨架落盘；复盘文字由独立 cron 任务（review-agent，headless agent LLM 生成）
    from pipeline.collect_review import collect_review
    return collect_review(day)


def _grade():
    from scripts.grade_tracking import main as grade_main
    return grade_main()


def _b1(day):
    from pipeline.b1 import update
    return update(day)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="盘后数据管道")
    parser.add_argument("--date", help="指定交易日 YYYY-MM-DD，缺省=最近交易日")
    args = parser.parse_args()
    print(main(args.date))

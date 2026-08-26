"""tools CLI 命令面（spec §3）。

用法：./.venv/bin/python -m tools <command> [options]
退出码：0 成功 / 1 数据错误 / 2 参数错误。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 保证可从仓库根 import pipeline/ 与 tools/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _add_date_args(p: argparse.ArgumentParser, with_start_end: bool = True) -> None:
    """公共日期参数：--asof（测试用锚点）与 --dates n / --start/--end。"""
    p.add_argument("--asof", help="按该日期取最近数据（默认今天，测试用）")
    if with_start_end:
        p.add_argument("--dates", type=int, metavar="N", help="最近 N 个交易日（缺省 5）")
        p.add_argument("--start", help="区间起点 YYYY-MM-DD（与 --end 同用）")
        p.add_argument("--end", help="区间终点 YYYY-MM-DD（与 --start 同用）")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m tools", description="A股数据访问 CLI（只读）")
    sub = p.add_subparsers(dest="cmd", required=True)

    # 层 1
    sp = sub.add_parser("dates", help="最近 N 个有数据交易日 / 区间")
    _add_date_args(sp)
    sp.add_argument("--json", action="store_true", help="输出 {dates:[...]} 而非裸数组")
    sp = sub.add_parser("latest", help="最近有数据交易日")
    sp.add_argument("--asof")

    # 层 2 快照
    sp = sub.add_parser("market", help="大盘快照（指数+宽度+量能）")
    sp.add_argument("--date", required=True)
    sp = sub.add_parser("sectors", help="申万一级行业快照/排名")
    sp.add_argument("--date", required=True)
    sp.add_argument("--top", type=int, help="前 N（按涨跌幅）")
    sp.add_argument("--bottom", type=int, help="后 N")
    sp = sub.add_parser("universe", help="股票集合单日快照")
    sp.add_argument("--date", required=True)
    sp.add_argument("--symbols", required=True, help="逗号分隔代码/名称")
    sp.add_argument("--weights", help="逗号分隔权重（缺省等权）")
    sp.add_argument("--label", default="组合")
    sp = sub.add_parser("stock", help="单只个股快照")
    sp.add_argument("--date", required=True)
    sp.add_argument("--code", required=True)
    sp = sub.add_parser("review", help="每日复盘")
    sp.add_argument("--date", required=True)
    sp = sub.add_parser("events", help="公告/快讯")
    sp.add_argument("--date", required=True)
    sp = sub.add_parser("signals", help="策略信号扫描结果")
    sp.add_argument("--date", required=True)

    # 层 2 个股专题
    sp = sub.add_parser("stock-news", help="个股相关新闻/公告（区间）")
    sp.add_argument("--code", required=True)
    _add_date_args(sp)
    sp = sub.add_parser("financials", help="个股 PIT 财报")
    sp.add_argument("--code", required=True)
    sp.add_argument("--reports", type=int, default=4, help="最近 N 期报告（缺省 4）")
    sp = sub.add_parser("valuation", help="个股估值（PE/PB/市值）")
    sp.add_argument("--code", required=True)
    _add_date_args(sp)

    # 层 3
    sp = sub.add_parser("series", help="周期统计 / K 线（stats|bars）")
    sp.add_argument("--view", required=True, help="JSON: {type:index|sector|stock|universe, symbols, weights?, label?}")
    _add_date_args(sp)
    sp.add_argument("--mode", choices=["stats", "bars"], default="stats")
    sp.add_argument("--granularity", choices=["day", "week", "month"], default="day")
    sp.add_argument("--top", type=int, default=5, help="universe set_top/bottom N")
    sp = sub.add_parser("review-digest", help="复盘周期汇总")
    _add_date_args(sp)
    sp = sub.add_parser("stock-profile", help="个股综合分析包（可选便利）")
    sp.add_argument("--code", required=True)
    _add_date_args(sp)
    sp.add_argument("--blocks", help="逗号分隔: price,bars,news,financials,valuation,snapshot（缺省全 5 块+snapshot）")

    return p


def _dates_from_args(args) -> list[str]:
    from tools import dates as dates_mod
    from tools._util import ParamError

    asof = getattr(args, "asof", None)
    start, end = getattr(args, "start", None), getattr(args, "end", None)
    n = getattr(args, "dates", None)
    if start or end:
        if not (start and end):
            raise ParamError("--start/--end 需成对使用")
        if n:
            raise ParamError("--dates 与 --start/--end 互斥")
        return dates_mod.dates(start=start, end=end, asof=asof)
    return dates_mod.dates(n=n, asof=asof)


def dispatch(args) -> dict:
    if args.cmd == "dates":
        ds = _dates_from_args(args)
        return {"dates": ds} if getattr(args, "json", False) else {"dates": ds}
    if args.cmd == "latest":
        from tools.dates import latest

        return {"date": latest(asof=args.asof)}
    if args.cmd == "market":
        from tools.snapshot import market

        return market(args.date)
    if args.cmd == "sectors":
        from tools.snapshot import sectors

        return sectors(args.date, top=args.top, bottom=args.bottom)
    if args.cmd == "universe":
        from tools.snapshot import universe

        return universe(args.date, args.symbols, weights=args.weights, label=args.label)
    if args.cmd == "stock":
        from tools.snapshot import stock

        return stock(args.date, args.code)
    if args.cmd == "review":
        from tools.snapshot import review

        return review(args.date)
    if args.cmd == "events":
        from tools.snapshot import events

        return events(args.date)
    if args.cmd == "signals":
        from tools.snapshot import signals

        return signals(args.date)
    if args.cmd == "stock-news":
        from tools.stock_extra import stock_news

        return stock_news(args.code, _dates_from_args(args))
    if args.cmd == "financials":
        from tools.stock_extra import financials

        return financials(args.code, reports=args.reports)
    if args.cmd == "valuation":
        from tools.stock_extra import valuation

        return valuation(args.code, _dates_from_args(args))
    if args.cmd == "series":
        from tools.series import series

        return series(args.view, _dates_from_args(args), mode=args.mode,
                      granularity=args.granularity, top_n=args.top)
    if args.cmd == "review-digest":
        from tools.series import review_digest

        return review_digest(_dates_from_args(args))
    if args.cmd == "stock-profile":
        from tools.series import stock_profile

        return stock_profile(args.code, _dates_from_args(args), blocks=args.blocks)
    raise ValueError(f"unknown command: {args.cmd}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    from tools._util import emit, fail, DataError, ParamError

    try:
        emit(dispatch(args))
        return 0
    except ParamError as e:
        fail(e, 2)
    except DataError as e:
        fail(e, 1)
    except Exception as e:  # 未预期错误：仍走 JSON 错误 + 退出码 1
        fail(f"internal: {e}", 1)
    return 1


if __name__ == "__main__":
    sys.exit(main())

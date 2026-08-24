"""快讯采集 worker（独立进程运行，供 collect_events 硬超时调用）。
数据源顺序：同花顺 stock_info_global_ths → 新浪 stock_info_global_sina（回退）。
输出：JSON 数组，每项含源字段（原样）+ derived 归因（严重度初筛/说明）。
"""
import json
import sys


def norm_ths(df):
    out = []
    for _, r in df.iterrows():
        published = str(r.get("发布时间", ""))
        date, _, time = published.partition(" ")
        out.append({
            "标题": str(r.get("标题", "")),
            "内容": str(r.get("内容", "")),
            "发布日期": date,
            "发布时间": time,
            "链接": str(r.get("链接", "")),
            "derived": {
                "event_type": "news",
                "severity": "low",
                "note": "同花顺财经快讯，覆盖窗口=最近 20 条",
            },
        })
    return out


def norm_sina(df):
    out = []
    for _, r in df.iterrows():
        stamp = str(r.get("时间", ""))
        date, _, time = stamp.partition(" ")
        content = str(r.get("内容", ""))
        out.append({
            "标题": content[:60],
            "内容": content,
            "发布日期": date,
            "发布时间": time,
            "derived": {
                "event_type": "news",
                "severity": "low",
                "note": "新浪 7×24 快讯，覆盖窗口=最近 20 条",
            },
        })
    return out


def main() -> int:
    import akshare as ak
    try:
        df = ak.stock_info_global_ths()
        out = norm_ths(df)
        if not out:
            raise ValueError("ths 空结果")
    except Exception:
        try:
            out = norm_sina(ak.stock_info_global_sina())
        except Exception as e:
            print(json.dumps({"error": f"快讯源均不可用: {e}"}, ensure_ascii=False))
            return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

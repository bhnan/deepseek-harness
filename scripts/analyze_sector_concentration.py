"""A 股板块资金/涨幅集中度分析（回答：资金历来集中在少数板块，还是泛化？）。

- 数据：data/sector/sw_daily.parquet（2014-01-02 ~ 2026-08-18，31 申万一级行业）
- 三个角度：
  ① 成交额集中度：每月 Top1/3/5 板块成交额占 31 板块总成交额比重（代理"资金聚集度"）
  ② 涨幅集中度：每月 Top1/3/5 板块区间涨幅占比（以等权基准归一）
  ③ 宽度（breadth）：每月跑赢等权均值的板块数量（赢家是否泛化）
- 输出：lab/backtests/sector_momentum_validation/concentration.json + csv
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SW_DAILY = ROOT / "data" / "sector" / "sw_daily.parquet"
SW_INFO = ROOT / "data" / "sector" / "sw_l1_info.json"
OUT = ROOT / "lab" / "backtests" / "sector_momentum_validation" / "concentration.json"
START = "2014-01-01"


def load():
    df = pd.read_parquet(SW_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    df = df[df["日期"] >= START].sort_values("日期")
    close = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    amount = df.pivot_table(index="日期", columns="code", values="成交额", aggfunc="last").sort_index()
    info = json.loads(SW_INFO.read_text(encoding="utf-8"))["industries"]
    names = {str(r["行业代码"]).split(".")[0]: r["行业名称"] for r in info}
    return close, amount, names


def main():
    close, amount, names = load()
    idx = close.index
    per = idx.to_period("M")
    lasts = pd.Series(idx, index=idx).groupby(per).last()
    firsts = pd.Series(idx, index=idx).groupby(per).first()

    rows = []
    for p in sorted(lasts.index):
        fe, le = firsts.loc[p], lasts.loc[p]
        amt_m = amount.loc[fe:le].sum()  # 板块当月成交额
        total = amt_m.sum()
        if total <= 0:
            continue
        amt_rank = amt_m.sort_values(ascending=False)
        share1 = float(amt_rank.iloc[0] / total)
        share3 = float(amt_rank.iloc[:3].sum() / total)
        share5 = float(amt_rank.iloc[:5].sum() / total)
        # 当月涨幅（月末/月初-1），只算有数据的板块
        ret = (close.loc[le] / close.loc[fe] - 1.0).dropna()
        if len(ret) < 5:
            continue
        ew = ret.mean()
        ret_rank = ret.sort_values(ascending=False)
        gain1 = float(ret_rank.iloc[0])
        gain3 = float(ret_rank.iloc[:3].mean())
        gain5 = float(ret_rank.iloc[:5].mean())
        # 涨幅集中：Top3 相对等权（>1 表示头部分散化程度低）
        conc3 = float(ret_rank.iloc[:3].mean() / ew) if ew != 0 else np.nan
        # 宽度：跑赢等权均值的板块数
        breadth = int((ret > ew).sum())
        rows.append({"month": str(p), "share_top1": share1, "share_top3": share3,
                     "share_top5": share5, "ret_top1": gain1, "ret_top3": gain3,
                     "ret_top5": gain5, "top3_vs_ew_ratio": conc3, "breadth": breadth})

    df = pd.DataFrame(rows)
    df["year"] = df["month"].str[:4]
    # 分年度汇总
    by_year = df.groupby("year").agg(
        share_top1=("share_top1", "mean"), share_top3=("share_top3", "mean"),
        share_top5=("share_top5", "mean"), breadth=("breadth", "mean"),
        top3_vs_ew_ratio=("top3_vs_ew_ratio", "mean")).round(3)
    summary = {
        "n_months": int(len(df)),
        "overall": {
            "share_top1_mean": float(df["share_top1"].mean()),
            "share_top1_median": float(df["share_top1"].median()),
            "share_top3_mean": float(df["share_top3"].mean()),
            "share_top5_mean": float(df["share_top5"].mean()),
            "breadth_mean": float(df["breadth"].mean()),
            "breadth_median": float(df["breadth"].median()),
            "breadth_pct": float(df["breadth"].mean() / 31),   # 跑赢均值的板块占比
            "top3_vs_ew_ratio_mean": float(df["top3_vs_ew_ratio"].mean()),
        },
        "period_early_2014_2018": df[df["year"] <= "2018"].mean(numeric_only=True).round(3).to_dict(),
        "period_mid_2019_2022": df[(df["year"] >= "2019") & (df["year"] <= "2022")].mean(numeric_only=True).round(3).to_dict(),
        "period_recent_2023_2026": df[df["year"] >= "2023"].mean(numeric_only=True).round(3).to_dict(),
        "by_year": by_year.reset_index().to_dict(orient="records"),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    df.to_csv(OUT.parent / "concentration_monthly.csv", index=False)

    print("=== 资金/涨幅集中度（2014-01 ~ 2026-08）===")
    o = summary["overall"]
    print(f"成交额集中度: Top1 板块均占 {o['share_top1_mean']*100:.1f}% | Top3 均占 {o['share_top3_mean']*100:.1f}% | Top5 均占 {o['share_top5_mean']*100:.1f}%")
    print(f"宽度: 每月跑赢等权均值的板块数均值 {o['breadth_mean']:.1f} / 31 ({o['breadth_pct']*100:.0f}%)")
    print(f"涨幅集中: Top3 平均涨幅 / 等权均值 = {o['top3_vs_ew_ratio_mean']:.2f}x")
    print("\n分年度:")
    print(by_year.to_string())
    print("\n输出:", OUT)


if __name__ == "__main__":
    main()

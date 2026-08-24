"""板块资金流持续性验证（idea_027）。

假设：板块成交额占比（资金分配代理）的净流入/净流出有持续性，且预示未来收益。

代理（东财主力资金接口禁用，占比变化是最干净的资金分配代理）：
  share_t = amount_sector,t / Σ amount_all,t
  flow_t  = share_t - share_{t-1}（日资金流；也可用 5 日均值差）

检验：
  A. 自相关：flow 的 lag 1/5/10 自相关（面板平均）——持续性存在性
  B. 延续概率：连续 K 日流入（K=2/3/5）后次日继续流入的概率 vs 无条件基准
  C. 收益预测：连续流入板块未来 5/20 日收益 vs 全部板块均值（超额）；
     连续流出板块对称
  D. 信号强度：流入组 - 流出组未来收益差（t 检验）

用法：python scripts/validate_fund_flow_persistence.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SECTOR_DAILY = ROOT / "data" / "sector" / "sw_daily.parquet"
START = "2014-01-01"          # 结构性长历史（28/31 板块齐备）
FUTURE = (5, 20)


def load() -> pd.DataFrame:
    df = pd.read_parquet(SECTOR_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    df = df[df["日期"] >= START]
    amount = df.pivot_table(index="日期", columns="code", values="成交额", aggfunc="last").sort_index()
    close = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    amount.columns = amount.columns.astype(str)
    close.columns = close.columns.astype(str)
    return amount, close


def t_report(diff_mean, diff_std, n, label):
    t = diff_mean / (diff_std / np.sqrt(n)) if diff_std > 0 and n > 1 else 0.0
    return f"{label}: 均值 {diff_mean*100:.3f}% / t={t:.2f} / n={n}"


def main():
    amount, close = load()
    total = amount.sum(axis=1)
    share = amount.div(total, axis=0)
    flow = share.diff()                     # 日资金流（占比变化）
    flow5 = share - share.shift(5)          # 5 日资金流
    ret = close.pct_change()
    out = {}

    print(f"样本: {share.index[0].date()} ~ {share.index[-1].date()}，{len(share)} 交易日，{share.shape[1]} 板块\n")

    # ---- 检验 A：自相关 ----
    print("【A】资金流（占比日变化）自相关（面板均值）")
    ac = {}
    for lag in (1, 5, 10, 20):
        v = flow.corrwith(flow.shift(lag)).mean()
        ac[lag] = round(v, 4)
        print(f"  lag-{lag}: {v:.4f}")
    out["autocorr"] = ac

    # ---- 检验 B：延续概率 ----
    print("\n【B】连续流入后次日继续流入的概率 vs 无条件基准")
    base = (flow > 0).mean().mean()
    print(f"  无条件流入概率: {base*100:.1f}%")
    prob_rows = []
    for K in (2, 3, 5):
        streak_in = (flow > 0).rolling(K).sum() >= K
        next_in = (flow.shift(-1) > 0)
        valid = streak_in & next_in.notna()
        # 延续概率 = 连续K日流入后 次日仍流入 的天数 / 连续K日流入 天数
        hit = (valid & next_in).sum().sum()
        tot = valid.sum().sum()
        p = hit / tot if tot else float("nan")
        print(f"  连续 {K} 日流入后次日继续流入: {p*100:.1f}% (n={int(tot)})")
        prob_rows.append({"k": K, "p_next_in": round(p, 4), "n": int(tot)})
    out["streak_probs"] = prob_rows

    # ---- 检验 C：收益预测（连续流入/流出 → 未来收益超额） ----
    print("\n【C】连续流入/流出板块未来收益超额（vs 全部板块当日均值）")
    bench = ret.mean(axis=1)                 # 全部板块等权
    excess = ret.sub(bench, axis=0)          # 板块超额（横截面）
    c_rows = []
    for K in (2, 3, 5):
        streak_in = (flow > 0).rolling(K).sum() >= K
        streak_out = (flow < 0).rolling(K).sum() >= K
        for H in FUTURE:
            fwd = excess.shift(-H).rolling(H).mean()   # 未来 H 日平均超额（按信号日对齐）
            gi = fwd[streak_in].stack().dropna()
            go = fwd[streak_out].stack().dropna()
            if len(gi) < 30 or len(go) < 30:
                continue
            mi, mo = gi.mean(), go.mean()
            diff = mi - mo
            t = diff / np.sqrt(gi.var()/len(gi) + go.var()/len(go)) if len(gi) > 1 else 0.0
            print(f"  流入{int(K)}日 → 未来{H}日日均超额 {mi*100:.3f}% (n={len(gi)}) | "
                  f"流出{int(K)}日 → {mo*100:.3f}% (n={len(go)}) | 差 {diff*100:.3f}% t={t:.2f}")
            c_rows.append({"k": K, "h": H, "in_excess_bps": round(mi*10000, 1), "out_excess_bps": round(mo*10000, 1),
                           "diff_bps": round(diff*10000, 1), "t": round(float(t), 2), "n_in": len(gi), "n_out": len(go)})
    out["return_predictions"] = c_rows

    # ---- 检验 D：5 日资金流信号（更平滑） ----
    print("\n【D】5 日资金流（占比 5 日变化）方向 → 未来 20 日超额")
    f5_in = flow5 > 0
    f5_out = flow5 < 0
    for H in FUTURE:
        fwd = excess.shift(-H).rolling(H).mean()
        gi = fwd[f5_in].stack().dropna()
        go = fwd[f5_out].stack().dropna()
        if len(gi) < 30 or len(go) < 30:
            continue
        diff = gi.mean() - go.mean()
        t = diff / np.sqrt(gi.var()/len(gi) + go.var()/len(go))
        print(f"  5日流入 → 未来{H}日 {gi.mean()*100:.3f}% (n={len(gi)}) | 5日流出 → {go.mean()*100:.3f}% | 差 {diff*100:.3f}% t={t:.2f}")
        out.setdefault("flow5_signals", []).append({"h": H, "in": round(gi.mean()*10000, 1), "out": round(go.mean()*10000, 1),
                                                    "diff": round(diff*10000, 1), "t": round(float(t), 2)})

    out_dir = ROOT / "lab" / "backtests" / "fund-flow-persistence"
    out_dir.mkdir(parents=True, exist_ok=True)
    import json
    (out_dir / "summary.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n报告已存 lab/backtests/fund-flow-persistence/summary.json")


if __name__ == "__main__":
    main()

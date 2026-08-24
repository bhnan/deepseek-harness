"""板块资金流口径对照：绝对量 vs 相对量（去除大盘影响）——idea_027 方法论补充。

用户问题：判断资金缩量/流入流出，要不要去除大盘带动的影响？
- 绝对量代理 abs_flow：Δlog(板块成交额)——含大盘系统性成分（大盘缩量时所有板块"净流出"）
- 相对量代理 rel_flow：Δlog(板块成交额/全市场成交额)——去除大盘，纯板块间再分配

对照检验（两代理同口径）：
  A. 自相关（lag 1/5/10）——持续性存在性
  B. 连续 3 日"流入"后次日继续流入概率 vs 无条件基准
  C. 连续 3 日流入/流出 → 未来 5/20 日收益超额（vs 全部板块均值）

结论判定：
- abs 有延续而 rel 无 → 用户观察的"资金流"主要是大盘成分（全市场资金运动），
  板块间相对再分配无延续性
- 两者都无 → 资金流无延续性成立（无论口径）
- rel 有而 abs 无 → 相对再分配有延续性（用户方向对，用相对口径）

用法：python scripts/validate_fund_flow_abs_vs_rel.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SECTOR_DAILY = ROOT / "data" / "sector" / "sw_daily.parquet"
START = "2014-01-01"
FUTURE = (5, 20)


def load() -> tuple[pd.DataFrame, pd.DataFrame]:
    df = pd.read_parquet(SECTOR_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    df = df[df["日期"] >= START]
    amount = df.pivot_table(index="日期", columns="code", values="成交额", aggfunc="last").sort_index()
    close = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    amount.columns = amount.columns.astype(str)
    close.columns = close.columns.astype(str)
    return amount, close


def autcorr(flow: pd.DataFrame, lag: int) -> float:
    return round(float(flow.corrwith(flow.shift(lag)).mean()), 4)


def streak_next_prob(flow: pd.DataFrame, k: int) -> tuple[float, int]:
    """连续 k 日 >0 后，次日仍 >0 的概率。"""
    streak = (flow > 0).rolling(k).sum() >= k
    nxt = flow.shift(-1) > 0
    valid = streak & nxt.notna()
    hit = int((valid & nxt).sum().sum())
    tot = int(valid.sum().sum())
    return (hit / tot if tot else float("nan")), tot


def future_excess(streak_in: pd.DataFrame, streak_out: pd.DataFrame, excess: pd.DataFrame, h: int):
    fwd = excess.shift(-h).rolling(h).mean()
    gi = fwd[streak_in].stack().dropna()
    go = fwd[streak_out].stack().dropna()
    if len(gi) < 30 or len(go) < 30:
        return None
    diff = gi.mean() - go.mean()
    t = diff / np.sqrt(gi.var() / len(gi) + go.var() / len(go)) if len(gi) > 1 else 0.0
    return {"n_in": len(gi), "n_out": len(go), "in_bps": round(gi.mean() * 10000, 1),
            "out_bps": round(go.mean() * 10000, 1), "diff_bps": round(diff * 10000, 1),
            "t": round(float(t), 2)}


def main():
    amount, close = load()
    total = amount.sum(axis=1)
    log_a = np.log(amount)
    log_A = np.log(total)

    abs_flow = log_a.diff()                       # Δlog(板块成交额) —— 含大盘成分
    rel_flow = log_a.sub(log_A, axis=0).diff()    # Δlog(share) —— 去除大盘

    ret = close.pct_change()
    bench = ret.mean(axis=1)
    excess = ret.sub(bench, axis=0)

    print(f"样本: {amount.index[0].date()} ~ {amount.index[-1].date()}，{len(amount)} 交易日，{amount.shape[1]} 板块\n")
    out = {}

    for name, flow in (("绝对量 Δlog(板块成交额)", abs_flow), ("相对量 Δlog(占比)", rel_flow)):
        print(f"===== {name} =====")
        row = {"name": name}
        # A. 自相关
        ac = {lag: autcorr(flow, lag) for lag in (1, 5, 10)}
        print(f"  [A] 自相关: lag-1 {ac[1]} | lag-5 {ac[5]} | lag-10 {ac[10]}")
        row["autocorr"] = ac
        # B. 延续概率
        base = float((flow > 0).mean().mean())
        p3, n3 = streak_next_prob(flow, 3)
        p5, n5 = streak_next_prob(flow, 5)
        print(f"  [B] 无条件流入 {base*100:.1f}% | 连3日流入后次日 {p3*100:.1f}% (n={n3}) | 连5日 {p5*100:.1f}% (n={n5})")
        row["base_in_pct"] = round(base * 100, 1)
        row["streak3_next"] = round(p3 * 100, 1)
        row["streak5_next"] = round(p5 * 100, 1)
        # C. 收益预测
        print("  [C] 连续 3 日流入/流出 → 未来收益超额")
        c_rows = []
        for k in (3, 5):
            sin = (flow > 0).rolling(k).sum() >= k
            sout = (flow < 0).rolling(k).sum() >= k
            for h in FUTURE:
                r = future_excess(sin, sout, excess, h)
                if r:
                    print(f"    流入{k}日→未来{h}日 {r['in_bps']}bp | 流出{k}日 {r['out_bps']}bp | 差 {r['diff_bps']}bp t={r['t']} (n={r['n_in']}/{r['n_out']})")
                    c_rows.append({"k": k, "h": h, **r})
        row["return_predictions"] = c_rows
        out[name] = row
        print()

    out_dir = ROOT / "lab" / "backtests" / "fund-flow-abs-vs-rel"
    out_dir.mkdir(parents=True, exist_ok=True)
    import json
    (out_dir / "summary.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("报告已存 lab/backtests/fund-flow-abs-vs-rel/summary.json")


if __name__ == "__main__":
    main()

"""缩量上涨 = 见顶？验证量价背离说法（个股，B1 池）。

说法：缩量上涨（价格涨但量能萎缩）意味着上涨动能衰竭、马上到头。

设计（B1 池 499 只，2014~2026，hfq 日线）：
- 上涨：近 5 日收益 > +2%（阈值敏感性另测）
- 缩量：近 5 日均量 / 前 20 日均量 < 0.8（vol_ratio）
- 对照：放量上涨（vol_ratio > 1.2）、缩量下跌、无条件基准
- 未来收益：信号日收盘后 t+1~t+5 / t+1~t+20 累计收益（close[t+H]/close[t] - 1）
- 统计：面板均值、t 检验、胜率（>0 比例）、相对基准超额

用法：python scripts/validate_shrink_up.py
"""
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
STOCK_DIR = ROOT / "data" / "stock" / "daily"
B1_STATE = ROOT / "data" / "stock" / "b1_state.json"
START = "2014-01-01"
FUTURE = (5, 20)
RET_THRESH = 0.02        # 上涨阈值
VOL_SHRINK = 0.8         # 缩量阈值
VOL_EXPAND = 1.2         # 放量阈值


def load_pool() -> list[str]:
    state = json.loads(B1_STATE.read_text(encoding="utf-8"))
    return [s for s in state.get("done", []) if s not in state.get("failed", [])]


def load_panel(symbols: list[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    closes, vols = {}, {}
    for sym in symbols:
        p = STOCK_DIR / sym / "hfq.parquet"
        if not p.exists():
            continue
        df = pd.read_parquet(p)
        if df.empty or "close" not in df.columns:
            continue
        df["date"] = pd.to_datetime(df["date"])
        df = df[df["date"] >= START]
        closes[sym] = df.set_index("date")["close"].astype(float)
        vols[sym] = df.set_index("date")["volume"].astype(float)
    c = pd.DataFrame(closes).sort_index()
    v = pd.DataFrame(vols).sort_index()
    return c, v


def panel_stats(fwd: pd.DataFrame, mask: pd.DataFrame, bench: pd.DataFrame):
    """信号日未来收益面板 vs 基准。返回 {n, mean_bps, bench_bps, excess_bps, t, win_rate}。"""
    s = fwd[mask].stack().dropna()
    b = fwd[bench].stack().dropna()
    if len(s) < 30 or len(b) < 30:
        return None
    diff = s.mean() - b.mean()
    t = diff / np.sqrt(s.var() / len(s) + b.var() / len(b)) if len(s) > 1 else 0.0
    return {"n": len(s), "mean_bps": round(s.mean() * 10000, 1), "bench_bps": round(b.mean() * 10000, 1),
            "excess_bps": round(diff * 10000, 1), "t": round(float(t), 2),
            "win_rate": round(float((s > 0).mean()) * 100, 1)}


def main():
    pool = load_pool()
    closes, vols = load_panel(pool)
    print(f"B1 池 {len(pool)} 只，可用 {closes.shape[1]} 只，{closes.index[0].date()} ~ {closes.index[-1].date()}\n")

    ret5 = closes / closes.shift(5) - 1.0
    vol_ma5 = vols.rolling(5).mean()
    vol_ma20 = vols.rolling(20).mean()
    vol_ratio = vol_ma5 / vol_ma20

    masks = {
        "缩量上涨": (ret5 > RET_THRESH) & (vol_ratio < VOL_SHRINK),
        "放量上涨": (ret5 > RET_THRESH) & (vol_ratio > VOL_EXPAND),
        "缩量下跌": (ret5 < -RET_THRESH) & (vol_ratio < VOL_SHRINK),
        "放量下跌": (ret5 < -RET_THRESH) & (vol_ratio > VOL_EXPAND),
        "温和上涨": (ret5 > RET_THRESH) & (vol_ratio >= VOL_SHRINK) & (vol_ratio <= VOL_EXPAND),
    }
    # 信号日数量
    print("信号日统计:")
    for name, m in masks.items():
        print(f"  {name}: {int(m.sum().sum())} 日")

    out = {}
    for H in FUTURE:
        fwd = closes.shift(-H) / closes - 1.0          # t+1~t+H 累计收益
        print(f"\n===== 未来 {H} 日累计收益（信号日收盘后） =====")
        row = {}
        for name, m in masks.items():
            r = panel_stats(fwd, m, pd.DataFrame(True, index=fwd.index, columns=fwd.columns))
            if r:
                print(f"  {name}: {r['mean_bps']}bp (基准 {r['bench_bps']}bp) | 超额 {r['excess_bps']}bp t={r['t']} | 胜率 {r['win_rate']}% (n={r['n']})")
                row[name] = r
        out[f"H{H}"] = row

    # 缩量上涨 vs 放量上涨 直接差
    print("\n===== 缩量上涨 − 放量上涨（直接对照） =====")
    out["shrink_vs_expand"] = {}
    for H in FUTURE:
        fwd = closes.shift(-H) / closes - 1.0
        a = fwd[masks["缩量上涨"]].stack().dropna()
        b = fwd[masks["放量上涨"]].stack().dropna()
        if len(a) > 30 and len(b) > 30:
            diff = a.mean() - b.mean()
            t = diff / np.sqrt(a.var() / len(a) + b.var() / len(b))
            print(f"  H={H}: 缩涨 {a.mean()*10000:.1f}bp vs 放涨 {b.mean()*10000:.1f}bp | 差 {diff*10000:.1f}bp t={t:.2f} (n={len(a)}/{len(b)})")
            out["shrink_vs_expand"][f"H{H}"] = {"diff_bps": round(diff * 10000, 1), "t": round(float(t), 2)}

    out_dir = ROOT / "lab" / "backtests" / "shrink-up-top"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "summary.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n报告已存 lab/backtests/shrink-up-top/summary.json")


if __name__ == "__main__":
    main()

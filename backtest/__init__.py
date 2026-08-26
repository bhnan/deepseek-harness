"""回测引擎（pandas 主引擎，qlib 评估文档 D3 定案）。

护栏（backtester-boundary-and-guardrails 文档）：
- as_of 数据访问器：策略代码唯一数据入口，物理上拿不到未来数据
- 两阶段时间轴：t 日收盘后算信号 → t+1 开盘成交
- fail-fast 断言：T+1 卖出违规抛异常，不静默跳过
- 已知答案测试见 tests/test_backtest_known_answers.py（先写测试再动引擎，护栏 §3.5）
"""

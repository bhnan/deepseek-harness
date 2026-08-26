"""A 股数据访问工具（tools 包）。

只读数据访问 CLI（docs/spec.md / docs/plan.md）：
- 只读：任何命令不得写 data/ 或 lab/；
- 复用 pipeline/io.py、pipeline/collect_market、scripts/export_*.py；
- 输出统一 JSON 到 stdout，错误走 stderr + 非零退出码。
"""

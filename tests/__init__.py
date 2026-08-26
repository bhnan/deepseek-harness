"""管道基础设施测试：write_asset 校验/防 NaN/原子性 + 市场宽度计算 + 幂等。

框架说明：测试框架选用标准库 unittest（零安装依赖，任何环境可跑，agent 会话内
`python -m unittest discover -s tests` 即可触发）。
"""

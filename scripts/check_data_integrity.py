"""数据完整性校验（测试点 SYS-6）：对照 .manifest.json 重算 sha256。
用法：python scripts/check_data_integrity.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.io import verify_manifest


def main() -> int:
    problems = verify_manifest()
    if problems:
        print(f"发现 {len(problems)} 个问题:")
        for p in problems:
            print(" -", p)
        return 1
    print("数据完整性 ✓（全部登记文件一致）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

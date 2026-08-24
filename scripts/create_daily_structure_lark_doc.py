#!/usr/bin/env python3
"""Create a Lark doc from the daily-structure Markdown report."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from pathlib import Path


REPORT_PATH = Path("docs/research/sw-sector-daily-structure-analysis-report.md")
CHUNK_DIR = Path("lab/backtests/sw_sector_daily_structure_analysis/lark_markdown_chunks")
RESULT_PATH = CHUNK_DIR / "create_results.json"


def extract_json(text: str) -> dict:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"no JSON in output: {text[:500]}")
    return json.loads(text[start : end + 1])


def run_lark(args: list[str], *, retries: int = 2) -> dict:
    env = os.environ.copy()
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    command = ["lark-cli", *args]
    last = ""
    for attempt in range(retries + 1):
        proc = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
        last = f"{proc.stdout}\n{proc.stderr}".strip()
        if proc.returncode == 0:
            result = extract_json(last)
            if result.get("ok") is True:
                return result
        if attempt < retries:
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f"command failed: {' '.join(command)}\n{last}")


def split_report(report_path: Path) -> list[Path]:
    text = report_path.read_text(encoding="utf-8")
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    for old in CHUNK_DIR.glob("chunk_*.md"):
        old.unlink()
    lines = text.splitlines()
    start_indices = [0]
    for i, line in enumerate(lines):
        if i == 0:
            continue
        if line.startswith("## ") and re.search(r"（801\d{3}）$", line):
            start_indices.append(i)
        elif line == "## 输出文件":
            start_indices.append(i)
    start_indices = sorted(set(start_indices))
    chunks = []
    for n, start in enumerate(start_indices):
        end = start_indices[n + 1] if n + 1 < len(start_indices) else len(lines)
        chunk_text = "\n".join(lines[start:end]).strip() + "\n"
        path = CHUNK_DIR / f"chunk_{n:03d}.md"
        path.write_text(chunk_text, encoding="utf-8")
        chunks.append(path)
    return chunks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default=str(REPORT_PATH))
    args = parser.parse_args()

    chunks = split_report(Path(args.report))
    results = []
    print(f"create {chunks[0].name}")
    created = run_lark(
        [
            "docs",
            "+create",
            "--as",
            "user",
            "--doc-format",
            "markdown",
            "--content",
            f"@{chunks[0]}",
            "--format",
            "json",
        ],
        retries=3,
    )
    document = created["data"]["document"]
    doc_id = document["document_id"]
    results.append({"chunk": str(chunks[0]), "revision_id": document.get("revision_id"), "status": "created", "doc_id": doc_id, "url": document.get("url")})
    RESULT_PATH.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    for path in chunks[1:]:
        print(f"append {path.name}")
        result = run_lark(
            [
                "docs",
                "+update",
                "--as",
                "user",
                "--doc",
                doc_id,
                "--command",
                "append",
                "--doc-format",
                "markdown",
                "--content",
                f"@{path}",
                "--format",
                "json",
            ],
            retries=3,
        )
        results.append({"chunk": str(path), "revision_id": result["data"]["document"].get("revision_id"), "status": "appended"})
        RESULT_PATH.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(0.5)

    print(json.dumps({"doc_id": doc_id, "url": document.get("url"), "chunks": len(chunks)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

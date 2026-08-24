#!/usr/bin/env python3
"""Insert rendered SW sector K-line charts into a Lark doc."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


DOC_TOKEN = "YsskdA5H7oDIaMxIefScEiqTnUb"
MANIFEST_PATH = Path("lab/backtests/sw_sector_cycle_analysis/kline_charts/chart_manifest.json")
RESULT_PATH = Path("lab/backtests/sw_sector_cycle_analysis/kline_charts/lark_insert_results.json")


def extract_json(text: str) -> dict:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"no JSON object found in output: {text[:500]}")
    return json.loads(text[start : end + 1])


def run_lark(args: list[str], *, retries: int = 2) -> dict:
    env = os.environ.copy()
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    command = ["lark-cli", *args]
    last_output = ""
    for attempt in range(retries + 1):
        proc = subprocess.run(command, text=True, capture_output=True, env=env, check=False)
        output = f"{proc.stdout}\n{proc.stderr}".strip()
        last_output = output
        if proc.returncode == 0:
            result = extract_json(output)
            if result.get("ok") is True:
                return result
        if attempt < retries:
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f"command failed: {' '.join(command)}\n{last_output}")


def fetch_heading_map(doc: str) -> dict[str, str]:
    result = run_lark(
        [
            "docs",
            "+fetch",
            "--as",
            "user",
            "--doc",
            doc,
            "--scope",
            "outline",
            "--max-depth",
            "2",
            "--detail",
            "with-ids",
            "--format",
            "json",
        ],
        retries=1,
    )
    content = result["data"]["document"]["content"]
    pattern = re.compile(r'<h2 id="([^"]+)">([^<]+)</h2>')
    return {title: block_id for block_id, title in pattern.findall(content)}


def load_results() -> list[dict]:
    if RESULT_PATH.exists():
        return json.loads(RESULT_PATH.read_text(encoding="utf-8"))
    return []


def save_results(rows: list[dict]) -> None:
    RESULT_PATH.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def insert_one(doc: str, item: dict, heading_id: str) -> dict:
    media = run_lark(
        [
            "docs",
            "+media-insert",
            "--as",
            "user",
            "--doc",
            doc,
            "--file",
            item["file"],
            "--align",
            "center",
            "--width",
            "1100",
            "--caption",
            item["caption"],
            "--format",
            "json",
        ],
        retries=2,
    )
    block_id = media["data"]["block_id"]
    move = run_lark(
        [
            "docs",
            "+update",
            "--as",
            "user",
            "--doc",
            doc,
            "--command",
            "block_move_after",
            "--block-id",
            heading_id,
            "--src-block-ids",
            block_id,
            "--format",
            "json",
        ],
        retries=2,
    )
    return {
        "code": item["code"],
        "name": item["name"],
        "file": item["file"],
        "heading_id": heading_id,
        "image_block_id": block_id,
        "file_token": media["data"].get("file_token"),
        "revision_id": move["data"]["document"].get("revision_id"),
        "status": "inserted",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--doc", default=DOC_TOKEN)
    parser.add_argument("--skip-code", action="append", default=[])
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    heading_map = fetch_heading_map(args.doc)
    results = load_results()
    completed = {row["code"] for row in results if row.get("status") == "inserted"}
    completed.update(args.skip_code)

    for item in manifest:
        code = item["code"]
        title = f"{item['name']}（{code}）"
        if code in completed:
            print(f"skip {title}")
            continue
        heading_id = heading_map.get(title)
        if not heading_id:
            raise KeyError(f"heading not found: {title}")
        print(f"insert {title}")
        row = insert_one(args.doc, item, heading_id)
        results.append(row)
        completed.add(code)
        save_results(results)
        time.sleep(0.8)

    print(f"inserted_or_skipped {len(completed)} charts")
    print(RESULT_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())

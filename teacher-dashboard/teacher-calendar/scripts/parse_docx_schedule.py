#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解析教师工作手册 docx → 周课表 JSON（供 import-docx-schedule.mjs 使用）

用法: python3 parse_docx_schedule.py <课表.docx> [输出.json]
输出结构:
  [{ "week": 11, "parity": "单", "dates": ["4.21", ...7], "slots": [{"slot": "第一节8:15 ——8:55", "cells": [7格]}] }]
"""
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}


def cell_text(tc):
    return ''.join(t.text or '' for t in tc.iter('{%s}t' % NS['w'])).strip().replace('\n', ' ')


def parse(docx_path):
    with zipfile.ZipFile(docx_path) as z:
        xml = z.read('word/document.xml')
    root = ET.fromstring(xml)
    body = root.find('w:body', NS)
    all_rows = []
    for child in body:
        if child.tag != '{%s}tbl' % NS['w']:
            continue
        for tr in child.findall('w:tr', NS):
            all_rows.append([cell_text(tc) for tc in tr.findall('w:tc', NS)])
    weeks = []
    i = 0
    while i < len(all_rows):
        r = all_rows[i]
        m = re.search(r'第\s*(\d+)\s*周（(单|双)）', r[0] or '')
        if not m:
            i += 1
            continue
        week_no = int(m.group(1))
        parity = m.group(2)
        dates = []
        for h in r[1:8]:
            dm = re.search(r'(\d+)\.(\d+)', h)
            dates.append(f'{dm.group(1)}.{dm.group(2)}' if dm else '')
        slots = []
        j = i + 1
        while j < len(all_rows) and not re.search(r'第\s*\d+\s*周', all_rows[j][0] or ''):
            row = all_rows[j]
            cells = row[1:8] + [''] * max(0, 7 - len(row[1:8]))
            slots.append({'slot': row[0], 'cells': cells})
            j += 1
        weeks.append({'week': week_no, 'parity': parity, 'dates': dates, 'slots': slots})
        i = j
    weeks.sort(key=lambda w: w['week'])
    return weeks


def main():
    if len(sys.argv) < 2:
        print('用法: parse_docx_schedule.py <课表.docx> [输出.json]', file=sys.stderr)
        sys.exit(1)
    weeks = parse(sys.argv[1])
    if len(sys.argv) >= 3:
        with open(sys.argv[2], 'w', encoding='utf-8') as f:
            json.dump(weeks, f, ensure_ascii=False, indent=1)
    else:
        print(json.dumps(weeks, ensure_ascii=False))
    print(f'# 解析完成: {len(weeks)} 周, 周次 {[w["week"] for w in weeks]}', file=sys.stderr)


if __name__ == '__main__':
    main()

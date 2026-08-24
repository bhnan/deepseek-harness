import { fixedInWeek } from './merge.js';

// R3 授课内容序列顺延（纯函数，单班内容序列维度）
// 语义（规则护栏文档 §2.3 SH1–SH8）：
// - 某班某课时位内容被替换 → 该位置之后的内容链式后移一个课时位
// - 顺延目标 = 该班固定排课中的下一个课时位（跨天/跨周）
// - 整条链为单个原子操作：任何一环无法落位 → 整次替换不生效（返回拒绝）
// - 仅影响该班内容序列，其他班级与课时槽位概不涉及（由调用方保证）

/**
 * defer_content(slots, items, pos) —— 停课顺延（R3 扩展）
 * 语义：某课时位因停课（运动会/考试等）不上 → 该班从该课时位起的内容整体后移一位，
 *       该课时位置空（当天停课）；被挤出的最后一条自然落入学期末尾的空课时位。
 * 与 shiftContent 的区别：shift 在 pos 放新内容（内容数 +1）；defer 在 pos 留空（内容数不变）。
 * 原子性：末尾无后继空课时位 → 整次拒绝（与 SH7 一致）。
 * @param slots 该班全部课时位（按上课时间升序）
 * @param items 该班内容序列 [{slotIndex, content, id?}]，升序
 * @param pos 停课课时位在 items 中的索引（0 起）
 * @returns { ok: true, items: [...] } | { ok: false, reason }
 * 效果：items=[{0,A},{1,B},{2,C},{3,D}]（slots 5 个），defer(pos=1) →
 *       [{0,A},{2,B},{3,C},{4,D}]：pos=1 置空，B/C/D 各后移一位，D 落入 slot 4（原空位）
 */
export function deferContent(slots, items, pos) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { ok: false, reason: '课时位列表为空' };
  }
  if (!Array.isArray(items) || pos < 0 || pos >= items.length) {
    return { ok: false, reason: `停课位置越界: pos=${pos}, 内容数=${items ? items.length : 0}` };
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !Number.isInteger(it.slotIndex) || it.slotIndex < 0 || it.slotIndex >= slots.length) {
      return { ok: false, reason: `第 ${i} 项 slotIndex 非法: ${it && it.slotIndex}` };
    }
    if (i > 0 && items[i].slotIndex <= items[i - 1].slotIndex) {
      return { ok: false, reason: `第 ${i} 项 slotIndex 未按升序或重复` };
    }
  }
  // 末尾必须有后继空课时位承载被挤出的最后一条（内容数不变，最后一条后移一位）
  const lastItem = items[items.length - 1];
  if (lastItem.slotIndex + 1 >= slots.length) {
    return { ok: false, reason: '停课顺延超出该班课时位范围（学期内无后继课时位），整次顺延被拒绝' };
  }
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (i < pos) {
      out.push({ ...items[i] });                                    // 停课位之前：原样
    } else {
      out.push({ ...items[i], slotIndex: items[i].slotIndex + 1 }); // 从停课位起：整体后移一位
    }
  }
  return { ok: true, items: out };
}

/**
 * undefer_content(slots, items, pos) —— 取消停课顺延（defer 的逆操作）
 * 语义：恢复被 defer 空出的课时位 —— 从该位（含）之后的内容整体前移一位，
 *       被挤到后面的最后一条内容回落到原课时位，恢复顺延前的位置。
 * 注意：defer 之后 pos 位置无内容（被置空），本函数把 pos+1 起的内容前移，
 *       pos 位置被 pos+1 的内容填回，原最后一条前移后释放末尾空位。
 * @param slots 该班全部课时位（按上课时间升序）
 * @param items 当前内容序列（defer 后状态），升序
 * @param pos 被顺延空出的课时位在 items 中的索引（0 起）
 * @returns { ok: true, items: [...] } | { ok: false, reason }
 * 效果：items=[{0,A},{2,B},{3,C},{4,D}]（slots 5 个），undefer(pos=1) →
 *       [{0,A},{1,B},{2,C},{3,D}]：pos=1 被填回 B，B/C/D 各前移一位，D 释放 slot 4
 */
export function undeferContent(slots, items, pos) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { ok: false, reason: '课时位列表为空' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: '该班没有内容可恢复' };
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !Number.isInteger(it.slotIndex) || it.slotIndex < 0 || it.slotIndex >= slots.length) {
      return { ok: false, reason: `第 ${i} 项 slotIndex 非法: ${it && it.slotIndex}` };
    }
    if (i > 0 && items[i].slotIndex <= items[i - 1].slotIndex) {
      return { ok: false, reason: `第 ${i} 项 slotIndex 未按升序或重复` };
    }
  }
  // pos 是"被空出的课时位"在 items 中的逻辑位置：找到第一个 slotIndex >= pos 的条目
  // （defer 后 pos 位置无内容，所以 items[pos] 实际指向 slotIndex > pos 的条目）
  // 用 slotIndex 定位更稳：找到 slotIndex === pos 的条目（若存在说明没被顺延，拒绝）
  const occupied = items.some((it) => it.slotIndex === pos);
  if (occupied) {
    return { ok: false, reason: '该课时位已有内容，无需恢复顺延（未被顺延过或已被重新填写）' };
  }
  // 找到第一个 slotIndex > pos 的条目（即被后移的内容起点）
  const firstAfter = items.findIndex((it) => it.slotIndex > pos);
  if (firstAfter === -1) {
    return { ok: false, reason: '该课时位之后没有内容可回移（顺延记录不存在）' };
  }
  const out = items.map((it) => (it.slotIndex > pos ? { ...it, slotIndex: it.slotIndex - 1 } : { ...it }));
  return { ok: true, items: out };
}

/**
 * shift_content(items, newContent, pos) —— 基于 seq_index 的序列顺延
 * 语义：替换某班序列中第 N 条内容，原内容及后续内容整体后移一位，
 *       最后一条被推到序列末尾的新位置（seq_index + 1）。
 * 物理位置（week/weekday/period）由调用方根据新 seq_index 从固定排课重新计算。
 *
 * @param items 该班内容序列，按 seq_index 升序 [{ seq_index, content, id }]
 * @param newContent 替换内容（字符串，非空）
 * @param pos 替换位置索引（0 起，指向 items 数组中的位置）
 * @returns { ok: true, items: [...] } | { ok: false, reason }
 *
 * 效果：items=[{seq:0,A},{seq:1,B},{seq:2,C},{seq:3,D}]，shift(newContent='复习', pos=1) →
 *       [{seq:0,A},{seq:1,复习},{seq:2,B},{seq:3,C},{seq:4,D}]（D 的 seq 从 3→4）
 */
export function shiftContent(items, newContent, pos) {
  if (!Array.isArray(items) || pos < 0 || pos >= items.length) {
    return { ok: false, reason: `替换位置越界: pos=${pos}, 内容数=${items ? items.length : 0}` };
  }
  if (typeof newContent !== 'string' || newContent.trim() === '') {
    return { ok: false, reason: '新内容不能为空' };
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.seq_index !== 'number' || it.seq_index < 0) {
      return { ok: false, reason: `第 ${i} 项 seq_index 非法: ${it && it.seq_index}` };
    }
    if (i > 0 && items[i].seq_index <= items[i - 1].seq_index) {
      return { ok: false, reason: `第 ${i} 项 seq_index 未按升序或重复` };
    }
  }
  const lastItem = items[items.length - 1];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (i < pos) {
      out.push({ ...items[i] });                                  // 替换位之前：原样
    } else if (i === pos) {
      out.push({ content: newContent, seq_index: items[i].seq_index, id: null }); // 替换位：新内容（新 id）
    } else {
      out.push({ ...items[i - 1], seq_index: items[i - 1].seq_index + 1 }); // 前一内容后移一位（seq_index+1）
    }
  }
  // 原最后一条：追加到末尾新位置
  out.push({ ...lastItem, seq_index: lastItem.seq_index + 1, id: null });
  return { ok: true, items: out };
}

/**
 * 由固定排课生成某班课时位列表（跨周累计）
 * @param fixedCourses 该班固定排课模板：[{ weekday, period, week? }]，week 缺省=每周；'odd'=单周；'even'=双周；数字=仅该周
 * @param totalWeeks 学期总周数
 * @returns [{week, weekday, period}] 按时间升序
 */
export function buildSlots(fixedCourses, totalWeeks) {
  const slots = [];
  for (let week = 1; week <= totalWeeks; week++) {
    for (const fc of fixedCourses) {
      if (!fixedInWeek(fc, week)) continue;
      slots.push({ week, weekday: fc.weekday, period: fc.period });
    }
  }
  return slots;
}

/**
 * 由存储内容生成 items（slotIndex 绑定）
 * @param contents 存储内容：[{ week, weekday?, period?, content, id }]
 * @param slots 课时位列表（buildSlots 输出）
 * @returns [{slotIndex, content, id}]；找不到对应课时位的条目被忽略并计数
 */
export function bindItems(contents, slots) {
  const keyOf = (s) => `${s.week}-${s.weekday || 1}-${s.period || 1}`;
  const slotIndexByKey = new Map();
  slots.forEach((s, i) => {
    const k = keyOf(s);
    if (!slotIndexByKey.has(k)) slotIndexByKey.set(k, i);
  });
  const items = [];
  let skipped = 0;
  for (const c of contents) {
    const idx = slotIndexByKey.get(keyOf(c));
    if (idx === undefined) { skipped++; continue; }
    items.push({ slotIndex: idx, content: c.content, id: c.id, seq_index: c.seq_index });
  }
  items.sort((a, b) => a.slotIndex - b.slotIndex);
  return { items, skipped };
}

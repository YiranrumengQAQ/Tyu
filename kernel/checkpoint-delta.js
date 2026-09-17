/* ================================================================
 * JLC 0.6.1 — Checkpoint 2.0 / Delta Snapshot（kernel/checkpoint-delta.js）
 *
 * 0.6 每个检查点都完整复制全部 state；大型项目里这就是「内存 × N」。
 * 0.6.1 引入 delta 快照（结构共享）：
 *
 *   Checkpoint N = base(Checkpoint N-1) + 变化部分
 *
 * 只有变化的信号进新条目，其余共享上一份的引用——不深拷贝。
 * 回滚时沿 base 链物化完整状态；最旧的检查点被淘汰时，依赖它的
 * 条目自动升级为完整快照，保证链条永远可解。
 * ================================================================ */

/** 计算相对上一个完整状态的差异键集合。 */
export function diffSignals(current, previous) {
  const changed = Object.create(null);
  if (!previous) return null; // 没有可对比的基准 → 只能拍全量
  for (const [name, value] of Object.entries(current)) {
    if (!(name in previous) || !Object.is(previous[name], value)) changed[name] = value;
  }
  for (const name of Object.keys(previous)) {
    if (!(name in current)) changed[name] = undefined; // 删除也是变化
  }
  return changed;
}

/** 沿 base 链把 delta 检查点物化成完整 signal 映射。 */
export function materializeSignals(entriesByLabel, entry) {
  if (!entry) return Object.create(null);
  if (!entry.base) return { ...(entry.signals ?? Object.create(null)) };
  const chain = [];
  let current = entry;
  while (current) {
    chain.unshift(current);
    if (!current.base) break;
    current = entriesByLabel.get(current.base) ?? null;
    if (!current) throw new Error("检查点 delta 链断裂：base 已被淘汰但未升级");
  }
  const merged = Object.create(null);
  for (const node of chain) {
    if (node.signals) Object.assign(merged, node.signals);
    if (node.changed) Object.assign(merged, node.changed);
  }
  return merged;
}

/** 某条目被淘汰时，把直接依赖它的 delta 条目升级为完整快照。 */
export function promoteDependents(entriesByLabel, evictedLabel) {
  for (const candidate of entriesByLabel.values()) {
    if (candidate.base !== evictedLabel) continue;
    const full = materializeSignals(entriesByLabel, candidate);
    candidate.signals = Object.freeze(full);
    candidate.signalNames = Object.freeze(Object.keys(full));
    candidate.changed = null;
    candidate.base = null;
    candidate.promoted = true;
  }
}

/** 估算一个检查点条目自身占用的字节数（供 Memory Accountant 记账）。 */
export function estimateEntryBytes(entry) {
  let bytes = 96;
  const source = entry.changed ?? entry.signals ?? Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    bytes += 16 + name.length * 2;
    if (typeof value === "string") bytes += value.length * 2;
    else if (Array.isArray(value)) bytes += value.length * 16;
    else if (value && typeof value === "object") bytes += 64;
    else bytes += 8;
  }
  return bytes;
}

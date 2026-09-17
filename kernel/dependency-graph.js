/* ================================================================
 * JLC 0.6.1 — Effect Dependency Graph（kernel/dependency-graph.js）
 *
 * 0.6 的依赖追踪已经是图（Signal.subscribers ↔ Effect.dependencies），
 * 0.6.1 把它变成一等公民：可以整图导出、可以按状态名查「谁会因此跑」。
 *
 *   state.count → derive.total → effect.summary → view.counter
 *
 * 修改与路径无关的 state.name 时，上面这条链一个都不跑——
 * 「不是有状态变化就跑 effect，而是依赖路径受影响才跑」。
 * ================================================================ */

/** 导出整张响应式依赖图（只读）。 */
export function describeDependencyGraph(runtime) {
  const signals = [];
  const effects = [];
  const edges = [];
  const effectIds = new Map();
  const registry = runtime?.effectRegistry;
  if (registry) {
    for (const effect of registry) {
      if (effect.disposed) continue;
      effectIds.set(effect, effects.length);
      effects.push(Object.freeze({
        id: effect.id,
        scope: effect.scope?.label ?? null,
        signal: effect.signal?.name ?? null,
        queued: effect.queued,
        dependencies: effect.dependencies.size,
      }));
    }
    for (const effect of registry) {
      if (effect.disposed) continue;
      for (const dependency of effect.dependencies) {
        edges.push(Object.freeze({ signal: dependency.name, effect: effectIds.get(effect) }));
      }
    }
  }
  for (const [name, slot] of runtime?.globals?.names ?? []) {
    const binding = runtime.globals.bindings[slot];
    if (binding?.kind !== "signal") continue;
    signals.push(Object.freeze({
      name,
      writable: binding.signal.writable,
      subscribers: binding.signal.subscribers.size,
    }));
  }
  return Object.freeze({ signals: Object.freeze(signals), effects: Object.freeze(effects), edges: Object.freeze(edges) });
}

/**
 * 查「改这个状态会牵动谁」：从信号出发沿订阅边做可达性分析，
 * 返回受影响的 effect 列表（含经由派生状态传导的间接依赖）。
 */
export function dependentsOf(runtime, name) {
  const binding = runtime?.globals?.resolve?.(name);
  if (binding?.kind !== "signal") return Object.freeze([]);
  const visitedSignals = new Set([binding.signal]);
  const queue = [binding.signal];
  const touched = [];
  while (queue.length) {
    const signal = queue.shift();
    for (const subscriber of signal.subscribers) {
      if (subscriber.disposed) continue;
      touched.push(Object.freeze({
        effect: subscriber.id,
        scope: subscriber.scope?.label ?? null,
        via: signal.name,
      }));
      // 派生状态本身也是信号：它的订阅者要被间接牵动。
      if (subscriber.signal && !visitedSignals.has(subscriber.signal)) {
        visitedSignals.add(subscriber.signal);
        queue.push(subscriber.signal);
      }
    }
  }
  return Object.freeze(touched);
}

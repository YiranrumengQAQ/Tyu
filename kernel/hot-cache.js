/* ================================================================
 * JLC 0.6.1 — Hot Path Cache（kernel/hot-cache.js）
 *
 * VM 优化的三件套（不新增指令、不改 ABI，只是把重复查找固定下来）：
 *
 *   Global Lookup Cache   name → slot 固化：模块链接完成后全局表不再
 *                         变化，GET_GLOBAL / SET_GLOBAL 从
 *                         「bindings[links[ref]]」两级跳变成一级直达。
 *   Function Metadata     高频 runFunction 的函数对象按索引缓存。
 *   Constant Pool         常量池本身就是平铺数组（pool[index] 一级直达），
 *                         这里只记命中数，供 Profile 2.0 观察。
 *
 * 三个缓存都是定长数组 + 懒填充：关闭 profile 时同样生效且接近零开销，
 * 因为替代的本就是每次派发都要做的数组间接寻址。
 * ================================================================ */

const EMPTY = Symbol("hot-cache:empty");

export class HotPathCache {
  constructor(module) {
    const globals = module?.globalRefs?.length ?? 0;
    const functions = module?.functions?.length ?? 0;
    this.globalSlots = new Array(globals).fill(EMPTY); // ref → binding
    this.funcSlots = new Array(functions).fill(EMPTY); // funcIndex → func
    this.stats = {
      globalHits: 0, globalMisses: 0,
      funcHits: 0, funcMisses: 0,
      constantReads: 0,
    };
  }

  /** ref → 全局 binding；miss 时由调用方回源并回填。 */
  global(ref) {
    const cached = this.globalSlots[ref];
    if (cached !== EMPTY) {
      this.stats.globalHits += 1;
      return cached;
    }
    this.stats.globalMisses += 1;
    return null;
  }

  putGlobal(ref, binding) {
    this.globalSlots[ref] = binding;
    return binding;
  }

  func(funcIndex) {
    const cached = this.funcSlots[funcIndex];
    if (cached !== EMPTY) {
      this.stats.funcHits += 1;
      return cached;
    }
    this.stats.funcMisses += 1;
    return null;
  }

  putFunc(funcIndex, func) {
    this.funcSlots[funcIndex] = func;
    return func;
  }

  noteConstant() {
    this.stats.constantReads += 1;
  }

  invalidate() {
    this.globalSlots.fill(EMPTY);
    this.funcSlots.fill(EMPTY);
  }

  statsView() {
    const { globalHits, globalMisses, funcHits, funcMisses, constantReads } = this.stats;
    return Object.freeze({
      globalHits,
      globalMisses,
      globalHitRate: globalHits + globalMisses > 0 ? globalHits / (globalHits + globalMisses) : 0,
      funcHits,
      funcMisses,
      constantReads,
    });
  }
}

/*
 * JLC OS 0.5 · 全屏（Fullscreen API）
 * capability 必须同步：requestFullscreen 返回的 Promise 在这里 fire-and-forget，
 * 返回值是「目标状态」，方便应用在界面上切换图标。
 */

export const supported = () => Boolean(document.documentElement?.requestFullscreen);

export const active = () => Boolean(document.fullscreenElement);

/** @returns {boolean} 操作后的目标状态 */
export function toggle(on) {
  if (!supported()) return false;
  const current = active();
  const next = on === undefined || on === null ? !current : Boolean(on);
  try {
    if (next && !current) {
      document.documentElement.requestFullscreen?.().catch((error) => console.warn("[0.5 host] 进入全屏失败：", error?.message ?? error));
    } else if (!next && current) {
      document.exitFullscreen?.().catch((error) => console.warn("[0.5 host] 退出全屏失败：", error?.message ?? error));
    }
  } catch (error) {
    console.warn("[0.5 host] 全屏切换失败：", error?.message ?? error);
    return current;
  }
  return next;
}

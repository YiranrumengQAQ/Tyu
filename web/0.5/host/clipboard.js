/*
 * JLC OS 0.5 · 剪贴板
 * 写：capability clipboardWrite（用户手势内 fire-and-forget）
 * 读：jlc://clipboard/read（宿主注入的 fetch 异步应答）
 */

export async function readText() {
  if (!navigator.clipboard?.readText) throw new Error("当前浏览器不支持剪贴板读取");
  return await navigator.clipboard.readText();
}

export function writeText(text) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    navigator.clipboard.writeText(String(text ?? "")).catch((error) => console.warn("[0.5 host] 剪贴板写入失败：", error?.message ?? error));
    return true;
  } catch {
    return false;
  }
}

export const supported = () => Boolean(navigator.clipboard);

/*
 * JLC OS 0.5 · 系统通知（Notification API）
 * permission === "default" 时在用户手势内 requestPermission（capability 调用恰好发生在手势里）。
 */

export function notifySupported() {
  return typeof Notification === "function";
}

export function notifyStatus() {
  if (!notifySupported()) return "unavailable";
  return Notification.permission; // granted | denied | default
}

/** @returns {Promise<boolean>} 是否已（或已排队）投递 */
export async function notify(message, tag) {
  if (!notifySupported()) return false;
  try {
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return false;
    const note = new Notification("JLC OS", { body: String(message ?? ""), tag: tag ? String(tag) : undefined });
    note.onclick = () => {
      window.focus();
      note.close();
    };
    return true;
  } catch (error) {
    console.warn("[0.5 host] 通知失败：", error?.message ?? error);
    return false;
  }
}

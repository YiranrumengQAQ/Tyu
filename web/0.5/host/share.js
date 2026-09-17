/*
 * JLC OS 0.5 · 系统分享（Web Share API，无服务器）
 * 不支持时降级为「写入剪贴板 + 提示」。
 */

import { writeText } from "./clipboard.js";

export function shareSupported() {
  return typeof navigator.share === "function";
}

/** @returns {Promise<"shared"|"copied"|"unavailable">} */
export async function share({ title, text, url }, ui) {
  const payload = {};
  if (title) payload.title = String(title);
  if (text) payload.text = String(text);
  if (url) payload.url = String(url);
  if (shareSupported() && Object.keys(payload).length) {
    try {
      await navigator.share(payload);
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
      throw error;
    }
  }
  const fallback = text || url || title || "";
  if (fallback && writeText(fallback)) {
    ui?.toast?.("当前浏览器不支持系统分享，已复制到剪贴板");
    return "copied";
  }
  ui?.toast?.("当前浏览器不支持分享，也没有可用的剪贴板");
  return "unavailable";
}

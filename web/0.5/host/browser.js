/*
 * JLC OS 0.5 · 浏览器 / 平台信息（只读） */

function detectPlatform() {
  const ua = navigator.userAgent ?? "";
  if (/Android/u.test(ua)) return "android";
  if (/iPhone|iPad|iPod/u.test(ua)) return "ios";
  if (/Macintosh|Mac OS/u.test(ua)) return "macos";
  if (/Windows/u.test(ua)) return "windows";
  if (/CrOS/u.test(ua)) return "chromeos";
  if (/Linux/u.test(ua)) return "linux";
  return "unknown";
}

export function browserInfo(extra = {}) {
  const platform = detectPlatform();
  return {
    ua: navigator.userAgent ?? "",
    platform,
    mobile: platform === "android" || platform === "ios",
    online: navigator.onLine !== false,
    language: navigator.language ?? "",
    ...extra,
  };
}

export const platformLabel = {
  android: "Android",
  ios: "iOS",
  macos: "macOS",
  windows: "Windows",
  chromeos: "ChromeOS",
  linux: "Linux",
  unknown: "unknown",
};

/** capability 同步返回的平台名（英文短名，便于应用做分支）。 */
export function detectPlatformLabel() {
  return platformLabel[detectPlatform()] ?? "unknown";
}

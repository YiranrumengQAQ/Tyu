/*
 * JLC OS 0.5 · 文件能力（Browser File Picker + 下载）
 *
 * 浏览器没有「打开文件对话框」的同步 API，所以流程是两段式：
 *   1) capability fileOpen(accept, multiple)  —— 在用户手势里同步弹出选择器，
 *      立即返回一个 token（数字）；
 *   2) 应用把 token 写进 state → resource 重新请求
 *      jlc://files/result/<token>（宿主注入的 fetch 在这里等文件读完后应答）。
 *
 * 文本类文件按 text 返回；二进制文件（图片等）包成 { name, size, type, url: data:URL }，
 * 应用拿 data: URL 直接当 img src / iframe srcdoc 用（open 档允许 data: URL）。
 */

const TEXT_TYPES = /^(text\/|application\/json|application\/xml|application\/javascript|application\/x-ndjson)/u;
const TEXT_EXT = /\.(txt|md|json|jlc|jbc|csv|ndjson|html|htm|css|js|ts|ya?ml|log|xml)$/iu;
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // 超过 4 MB 不再内联 text，只给元数据

export class FileHost {
  constructor(store) {
    this.store = store;
    this.token = 0;
    this.pending = new Map(); // token -> { files: File[] }
    this.recents = [];
    this.ready = null;
  }

  async loadRecents() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.recents = (await this.store.singletonGet("recents", [])) ?? [];
      return this;
    })();
    return this.ready;
  }

  async noteRecent(file) {
    await this.loadRecents();
    const entry = {
      name: file.name ?? "untitled",
      size: Number(file.size ?? 0),
      type: file.type ?? "",
      ts: Date.now(),
    };
    this.recents = [entry, ...this.recents].slice(0, 20);
    await this.store.singletonSet("recents", this.recents);
    return entry;
  }

  async clearRecents() {
    await this.loadRecents();
    this.recents = [];
    await this.store.singletonSet("recents", []);
  }

  /** 用户手势内调用：建 <input type=file> 并 click()，返回 token。 */
  open(accept, multiple) {
    this.token += 1;
    const token = this.token;
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = String(accept);
    input.multiple = Boolean(multiple);
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length) {
        this.pending.set(token, { files });
        for (const file of files) {
          this.noteRecent(file).catch(() => {});
        }
      } else {
        // 用户取消：token 保持「未就绪」，result 路由会 404。
        this.pending.set(token, { files: [] });
      }
    });
    input.click();
    return token;
  }

  hasResult(token) {
    return this.pending.has(token);
  }

  /** 读取 token 对应文件 → 信封对象（见 localapi 注释）。 */
  async result(token) {
    const entry = this.pending.get(token);
    if (!entry) return null;
    if (!entry.files.length) return { kind: "cancelled" };
    if (entry.files.length > 1) {
      const items = [];
      for (const file of entry.files) items.push(await this.describe(file));
      return { kind: "multi", items };
    }
    return this.describe(entry.files[0]);
  }

  async describe(file) {
    const base = {
      name: file.name ?? "untitled",
      size: Number(file.size ?? 0),
      type: file.type ?? "",
    };
    const looksText = TEXT_TYPES.test(base.type) || TEXT_EXT.test(base.name);
    if (looksText && base.size <= MAX_INLINE_BYTES) {
      try {
        const text = await file.text();
        return { kind: base.type === "application/json" ? "json" : "text", ...base, text };
      } catch {
        /* 读失败 → 走二进制 */
      }
    }
    try {
      const url = await blobToDataUrl(file);
      return { kind: "binary", ...base, url };
    } catch {
      return { kind: "binary", ...base, url: null };
    }
  }

  /** 同步触发浏览器下载（Blob + <a download>）。 */
  download(name, content, mime) {
    try {
      const blob = new Blob([String(content ?? "")], { type: mime || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = String(name || "jlc-export");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch (error) {
      console.warn("[0.5 host] 下载失败：", error);
      return false;
    }
  }
}

async function blobToDataUrl(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const head = `data:${file.type || "application/octet-stream"};base64,`;
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return head + btoa(binary);
}

export function createFileHost(store) {
  return new FileHost(store);
}

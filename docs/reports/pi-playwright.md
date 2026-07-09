# Pi + Playwright: 持久浏览器方案

## 问题

Pi 没有 MCP，无法像 Copilot/Claude 那样连 Playwright MCP server。用 CLI（`npx playwright ...`）的问题是每次工具调用都启动一个新浏览器进程，执行完就关，导致：

1. **慢** — 每次冷启动 Chromium ~1-2s
2. **无法保持状态** — 登录态、cookie、localStorage 全部丢失
3. **无法跨工具调用共享上下文** — navigate 和 click 是两次独立的浏览器实例

## 正确方案：Pi Extension 持久 Browser

利用 pi 的 extension 系统和 `session_start` / `session_shutdown` 生命周期，在 session 内保持一个 browser 实例。

### 安装

```bash
mkdir -p ~/.pi/agent/extensions/playwright-browser
cd ~/.pi/agent/extensions/playwright-browser
npm init -y
npm install playwright
```

### 完整实现

```typescript
// ~/.pi/agent/extensions/playwright-browser/index.ts
import { chromium, type Browser, type Page } from "playwright";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

// ── 状态 ──
let browser: Browser | null = null;
let page: Page | null = null;

// ── 工具参数 schema ──
const NavigateSchema = Type.Object({
  url: Type.String({ description: "Full URL to navigate to" }),
});
const ClickSchema = Type.Object({
  selector: Type.String({ description: "CSS selector or text to click" }),
});
const TypeSchema = Type.Object({
  selector: Type.String({ description: "CSS selector for the input field" }),
  text: Type.String({ description: "Text to type" }),
});
const ScreenshotSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Filename (saved to /tmp)" })),
});

export default function (pi: ExtensionAPI) {
  // ── 生命周期：session 开始时启动浏览器 ──
  pi.on("session_start", async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  // ── 生命周期：session 结束时关闭浏览器 ──
  pi.on("session_shutdown", async () => {
    await browser?.close();
    browser = null;
    page = null;
  });

  // ── navigate ──
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the persistent browser to a URL",
    parameters: NavigateSchema,
    async execute(_id, params) {
      if (!page) return err("Browser not started");
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const title = await page.title();
      const url = page.url();
      return ok(`Navigated to: ${title}\nURL: ${url}`);
    },
  });

  // ── snapshot：获取页面内容（给 LLM 看） ──
  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Get the current page's text content and interactive elements. " +
      "Use this to see what's on the page before clicking or typing.",
    parameters: Type.Object({}),
    async execute() {
      if (!page) return err("Browser not started");
      // 提取可交互元素 + 可见文本
      const interactives = await page.$$eval(
        'a, button, input, select, textarea, [role="button"]',
        (els) =>
          els.map((el) => {
            const tag = el.tagName.toLowerCase();
            const text = (el as HTMLElement).innerText?.trim().slice(0, 100) || "";
            const id = el.id || "";
            const name = (el as HTMLInputElement).name || "";
            const placeholder = (el as HTMLInputElement).placeholder || "";
            const href = tag === "a" ? (el as HTMLAnchorElement).href : "";
            const label = [tag, id, name, placeholder, text, href]
              .filter(Boolean)
              .join(" | ");
            return `[${tag}] ${label}`;
          }),
      );
      const bodyText = (await page.textContent("body"))?.trim().slice(0, 4000) ?? "";
      return ok(
        `=== Interactive Elements ===\n${interactives.slice(0, 50).join("\n")}\n\n=== Page Text ===\n${bodyText}`,
      );
    },
  });

  // ── click ──
  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element on the page. Use the selector from browser_snapshot output.",
    parameters: ClickSchema,
    async execute(_id, params) {
      if (!page) return err("Browser not started");
      try {
        await page.click(params.selector, { timeout: 5000 });
        return ok(`Clicked: ${params.selector}`);
      } catch (e) {
        // fallback: try clicking by text
        await page.getByText(params.selector, { exact: false }).first().click({ timeout: 3000 });
        return ok(`Clicked (by text): ${params.selector}`);
      }
    },
  });

  // ── type ──
  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an input field",
    parameters: TypeSchema,
    async execute(_id, params) {
      if (!page) return err("Browser not started");
      await page.fill(params.selector, params.text, { timeout: 5000 });
      return ok(`Typed into ${params.selector}`);
    },
  });

  // ── screenshot（调试用） ──
  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the current page",
    parameters: ScreenshotSchema,
    async execute(_id, params) {
      if (!page) return err("Browser not started");
      const path = `/tmp/pi-browser-${params.name ?? Date.now()}.png`;
      await page.screenshot({ path, fullPage: false });
      return ok(`Screenshot saved to ${path}`);
    },
  });
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true, details: {} };
}
```

### 关键设计

| 特性 | 说明 |
|------|------|
| **Browser 生命周期** | `session_start` 创建 → `session_shutdown` 关闭 |
| **单 Page 复用** | 整个 session 共享一个 page，状态（登录、cookie）自然保持 |
| **Snapshot** | 提取可交互元素列表 + 页面文本，LLM 据此决定下一步操作 |
| **Click fallback** | 先用 CSS selector，失败后 fallback 到文本匹配 |
| **Screenshot** | 调试用，输出到 `/tmp` |

### 注意事项

- **headless: true** — 服务器/无桌面环境用 headless；本地调试可以 `headless: false` 看浏览器操作
- **单 page 足够** — 大部分场景一个 tab 就够了，需要多 tab 可以用 `browser.newPage()`
- **超时** — 所有操作都设了 timeout，防止卡死
- **错误处理** — click/type 失败不会崩，返回 isError 让 LLM 知道并重试

# Pi + Web Search: 网络搜索方案

## 问题

Pi 内置的工具只有文件系统操作（read/write/edit/bash），没有网络搜索能力。需要让 LLM 能搜索互联网获取最新信息。

## 方案概览

通过 pi extension 注册 `web_search` 和 `web_fetch` 两个工具，调用搜索 API + 网页抓取。

| 层级 | 工具 | 作用 |
|------|------|------|
| 搜索 | `web_search(query)` | 调用搜索 API，返回结果列表（标题+URL+摘要） |
| 抓取 | `web_fetch(url)` | 抓取单个网页的正文内容 |

LLM 工作流：`web_search("xxx")` → 看结果列表 → 挑感兴趣的 URL → `web_fetch(url)` → 读正文 → 回答用户。

## 搜索 API 选择

| API | 免费额度 | 特点 | 价格 |
|-----|---------|------|------|
| **Tavily** | 1000/月 | AI-优化，专为 agent 设计，自带内容提取 | ~$0.005/次 |
| **Brave Search** | 2000/月 | 独立索引，隐私好 | $5/1000次 |
| **SerpAPI** | 100/月 | 代理 Google/Bing，结果最全 | ~$0.01-0.03/次 |
| **DuckDuckGo (免费)** | 无限 | 非官方 API，可能不稳定，结果质量一般 | 免费 |

**推荐 Tavily** — 专为 AI agent 设计，返回结果已经包含提取好的内容摘要，减少后续 `web_fetch` 次数。

## 实现

### 1. 获取 API Key

```bash
# Tavily: https://app.tavily.com
# 注册后拿到 API key，放环境变量
echo 'TAVILY_API_KEY=tvly-xxxxxxxx' >> ~/.pi/.env
```

### 2. 安装

```bash
mkdir -p ~/.pi/agent/extensions/web-search
cd ~/.pi/agent/extensions/web-search
npm init -y
```

### 3. 完整实现

```typescript
// ~/.pi/agent/extensions/web-search/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── 搜索结果类型 ──
interface SearchResult {
  title: string;
  url: string;
  content: string;  // Tavily 自带内容摘要
  score?: number;
}

// ── 搜索 ──
async function searchWeb(query: string, maxResults = 5): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set in environment");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",       // basic=快, advanced=深但贵
      include_answer: true,         // Tavily AI 直接回答（若有）
      include_raw_content: false,   // false 减少 token 消耗
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Search API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  // Tavily 返回格式
  const data = (await res.json()) as {
    answer?: string;
    results: Array<{ title: string; url: string; content: string; score: number }>;
  };

  const results: SearchResult[] = [];
  
  // AI 直接回答优先
  if (data.answer) {
    results.push({ title: "AI Answer", url: "", content: data.answer, score: 1 });
  }

  for (const r of data.results ?? []) {
    results.push({ title: r.title, url: r.url, content: r.content, score: r.score });
  }

  return results.slice(0, maxResults + (data.answer ? 1 : 0));
}

// ── 网页抓取 ──
async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KrakiBot/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  
  const html = await res.text();

  // 简单 HTML → 纯文本提取
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000); // 截断，避免塞满 context

  return text;
}

// ── Extension 主体 ──
export default function (pi: ExtensionAPI) {
  // web_search
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the internet for current information. Returns titles, URLs, and " +
      "content snippets. Use this when you need up-to-date facts, news, or " +
      "information beyond your training data. Follow up with web_fetch to read " +
      "full pages from the returned URLs.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(
        Type.Number({ description: "Max results (default 5, max 10)" }),
      ),
    }),
    async execute(_id, params) {
      const query = params.query;
      if (!query?.trim()) return err("Query is required");

      try {
        const results = await searchWeb(query, Math.min(params.maxResults ?? 5, 10));
        if (results.length === 0) return ok("No results found.");

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}**\n   URL: ${r.url || "(direct answer)"}\n   ${r.content.slice(0, 300)}`,
          )
          .join("\n\n");

        return ok(formatted);
      } catch (e) {
        return err(`Search failed: ${(e as Error).message}`);
      }
    },
  });

  // web_fetch
  pi.registerTool({
    name: "web_fetch",
    label: "Fetch Web Page",
    description:
      "Fetch and extract the text content of a web page. Use this to read " +
      "full articles or pages found via web_search. Returns plain text (HTML " +
      "tags stripped, max 6000 chars).",
    parameters: Type.Object({
      url: Type.String({ description: "Full URL of the page to fetch" }),
    }),
    async execute(_id, params) {
      const url = params.url;
      if (!url?.trim()) return err("URL is required");

      try {
        const text = await fetchPage(url);
        if (!text) return ok("Page fetched but appears to have no readable content.");
        return ok(text);
      } catch (e) {
        return err(`Fetch failed: ${(e as Error).message}`);
      }
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

## 替代方案：Brave Search

如果不想用 Tavily，换成 Brave Search：

```typescript
// 替换 searchWeb 函数
async function searchWeb(query: string, maxResults = 5): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
    {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey!,
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  const data = await res.json() as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.description,
  }));
}
```

## 关键设计

| 特性 | 说明 |
|------|------|
| **两段式** | `web_search` 找 URL → `web_fetch` 读正文。LLM 自己决策 |
| **token 控制** | search 结果截断 300 字/条，fetch 截断 6000 字，防止塞爆 context |
| **Tavily AI answer** | 简单问题直接返回 AI 回答，不需要再 fetch |
| **超时** | search 15s，fetch 10s，防止卡死 |
| **API key 放环境变量** | 不硬编码，通过 `~/.pi/.env` 加载 |

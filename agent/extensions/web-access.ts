import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PERPLEXITY_CHAT_COMPLETIONS_URL = "https://api.perplexity.ai/v1/sonar";
const PERPLEXITY_AGENT_API_URL = "https://api.perplexity.ai/v1/agent";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;
const MAX_FETCH_URLS = 10;
const SEARCH_CONTEXT_SIZE = "medium";
const AGENT_PRESET = "pro-search";
function getApiKey(): string {
  const key = process.env.PERPLEXITY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Perplexity API key not found. Set PERPLEXITY_API_KEY environment variable. " +
        "Get a key at https://perplexity.ai/settings/api",
    );
  }
  return key;
}

async function writeTruncatedOutput(output: string, filePrefix: string) {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let resultText = truncation.content;
  let fullOutputPath: string | undefined;

  if (truncation.truncated) {
    const tempDir = await mkdtemp(join(tmpdir(), filePrefix));
    fullOutputPath = join(tempDir, "output.md");
    await writeFile(fullOutputPath, output, "utf8");

    const truncatedLines = truncation.totalLines - truncation.outputLines;
    const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
    resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
    resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
    resultText += ` If the truncated output is not enough to answer the user properly, read the full output before answering: read({ path: "${fullOutputPath}" }).]`;
  }

  return { resultText, truncation, fullOutputPath };
}

type Source = {
  title: string;
  url: string;
  snippet?: string;
  date?: string;
};

type SearchResult = {
  query: string;
  answer: string;
  sources: Source[];
};

async function searchWithPerplexity(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const response = await fetch(PERPLEXITY_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [{ role: "user", content: query }],
      max_tokens: 32768,
      return_related_questions: false,
      web_search_options: { search_context_size: SEARCH_CONTEXT_SIZE },
    }),
    signal: signal ?? null,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as any;
  const answer = data.choices?.[0]?.message?.content || "";
  const searchResults = Array.isArray(data.search_results) ? data.search_results : [];
  let sources: Source[] = searchResults
    .filter((result: any) => result && typeof result === "object" && typeof result.url === "string")
    .slice(0, numResults)
    .map((result: any, index: number) => ({
      title:
        typeof result.title === "string" && result.title ? result.title : `Source ${index + 1}`,
      url: result.url,
      snippet: typeof result.snippet === "string" ? result.snippet : undefined,
      date: typeof result.date === "string" ? result.date : undefined,
    }));

  if (sources.length === 0) {
    const citations: unknown[] = Array.isArray(data.citations) ? data.citations : [];
    sources = citations
      .filter((citation: any): citation is string => typeof citation === "string")
      .slice(0, numResults)
      .map((url, index) => ({ title: `Source ${index + 1}`, url }));
  }

  return { query, answer, sources };
}

function formatSearchOutput(result: SearchResult): string {
  let output = `# Search: ${result.query}\n\n`;
  output += `## Perplexity answer\n\n${result.answer || "No answer returned."}\n\n`;
  output += "## Sources\n\n";

  if (result.sources.length === 0) {
    output += "No sources returned.\n";
  } else {
    for (const [index, source] of result.sources.entries()) {
      output += `${index + 1}. ${source.title}\n   ${source.url}\n`;
      if (source.date) output += `   Date: ${source.date}\n`;
      if (source.snippet) output += `   Snippet: ${source.snippet}\n`;
    }
  }

  return output.trim();
}

function normalizeUrlKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function validateWebUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Only http and https URLs are supported";
    }
    return null;
  } catch {
    return "Invalid URL";
  }
}

type FetchResult = {
  url: string;
  title: string;
  content: string;
  error: string | null;
};

function extractAgentFetchResults(data: any): FetchResult[] {
  const output = Array.isArray(data.output) ? data.output : [];
  const results: FetchResult[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "fetch_url_results" || !Array.isArray(item.contents)) continue;

    for (const entry of item.contents) {
      if (!entry || typeof entry !== "object" || typeof entry.url !== "string") continue;
      const content = typeof entry.snippet === "string" ? entry.snippet.trim() : "";

      results.push({
        url: entry.url,
        title: typeof entry.title === "string" ? entry.title : "",
        content,
        error: content ? null : "No readable content returned",
      });
    }
  }

  return results;
}

async function fetchReadableContents(urls: string[], signal?: AbortSignal): Promise<FetchResult[]> {
  try {
    const response = await fetch(PERPLEXITY_AGENT_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        preset: AGENT_PRESET,
        input: `Fetch these URLs:\n${urls.map((url, index) => `${index + 1}. ${url}`).join("\n")}`,
        tools: [{ type: "fetch_url", max_urls: urls.length }],
        max_output_tokens: 256,
      }),
      signal: signal ?? null,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity Agent API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as any;
    if (typeof data.error?.message === "string") throw new Error(data.error.message);

    const fetched = extractAgentFetchResults(data);
    const byUrl = new Map(fetched.map((result) => [normalizeUrlKey(result.url), result]));

    return urls.map((url) => {
      const result = byUrl.get(normalizeUrlKey(url));
      return result ?? { url, title: "", content: "", error: "No readable content returned" };
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Cancelled", { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    return urls.map((url) => ({ url, title: "", content: "", error: message }));
  }
}

function formatFetchOutput(results: FetchResult[]): string {
  let output = "# Fetched content\n\n";
  for (const result of results) {
    output += `## ${result.title || result.url}\n\n`;
    output += `Source: ${result.url}\n\n`;
    output += result.error ? `Error: ${result.error}\n\n` : `${result.content}\n\n`;
  }
  return output.trim();
}

export default function webExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the web with Perplexity Sonar. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Requires PERPLEXITY_API_KEY.`,
    promptSnippet: "Search the web with Perplexity Sonar and return an answer plus source URLs",
    promptGuidelines: [
      "Use web_search when the user asks to look up current information or search the web.",
      "When source verification matters, follow web_search results with web_fetch for the relevant source URLs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(
        Type.Integer({
          description: `Maximum number of source URLs to return (1-${MAX_NUM_RESULTS}, default ${DEFAULT_NUM_RESULTS})`,
          minimum: 1,
          maximum: MAX_NUM_RESULTS,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      if (!query) throw new Error("query must not be empty");

      getApiKey();
      const numResults = params.numResults ?? DEFAULT_NUM_RESULTS;
      const result = await searchWithPerplexity(query, numResults, signal);
      const output = formatSearchOutput(result);
      const truncated = await writeTruncatedOutput(output, "pi-web-search-");

      return {
        content: [{ type: "text", text: truncated.resultText }],
        details: null,
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch readable content for http/https URLs through the Perplexity Agent API. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Requires PERPLEXITY_API_KEY.`,
    promptSnippet: "Fetch readable content for one or more web URLs",
    promptGuidelines: [
      "Use web_fetch when the user needs source verification, quotes, or readable content from specific URLs.",
      "Pass only absolute http:// or https:// URLs to web_fetch.",
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String({ description: "Absolute http:// or https:// URL" }), {
        description: "URLs to fetch",
        minItems: 1,
        maxItems: MAX_FETCH_URLS,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const urls = params.urls.map((url) => url.trim());

      for (const url of urls) {
        const validationError = validateWebUrl(url);
        if (validationError) throw new Error(`${validationError}: ${url}`);
      }

      getApiKey();
      const results = await fetchReadableContents(urls, signal);
      const output = formatFetchOutput(results);
      const truncated = await writeTruncatedOutput(output, "pi-fetch-content-");

      return {
        content: [{ type: "text", text: truncated.resultText }],
        details: null,
      };
    },
  });
}

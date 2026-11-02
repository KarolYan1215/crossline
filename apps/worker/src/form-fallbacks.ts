import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserUseActions, browserUseSchema, browserUseTask, OBSERVE_SUPPORTED, observedActions, observeInstruction, observeRules, observeTree, observeVariables,
  type FormAction, type FormBrowserInput, type FormObserveAnswer, type FormObserveInput } from "@crossline/core";
import { runBrowserUse } from "./browser-use";
import type { FormFallback } from "./form-engine";
import { onHosts, runHosts } from "./node/browser";

/**
 * Stagehand v3 as a fallback form engine (docs/opportunity-agent.md §10.7; MIT, checked on GitHub 2026-11-01). Only its inference step
 * is used: `observe()` from `@browserbasehq/stagehand/lib/inference`, with no browser of its own, no CDP connection and no `act()`.
 * The page it sees is the tree `observeTree` builds from the filler's redacted snapshot (no field values), the person's profile
 * items are variables with empty values, and its model is a Crossline Skill run (`ask`). What it names becomes the engine's actions
 * (`observedActions`), which the engine judges and does itself — a fallback never turns a page, submits or holds a sensitive value.
 */
type ChatMessage = { role: string; content: unknown };
type ChatOptions = { messages: ChatMessage[]; response_model?: { schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } }; name: string } };

export function stagehandFallback(deps: { ask: (input: FormObserveInput) => Promise<FormObserveAnswer | undefined> }): FormFallback {
  return {
    name: "stagehand",
    propose: async ({ context }): Promise<FormAction[] | undefined> => {
      const { tree, elements } = observeTree(context.snapshot);
      if (!elements.size) return [];
      const llmClient = {
        type: "crossline", modelName: "crossline-form-observer", hasVision: false, clientOptions: {},
        createChatCompletion: async ({ options }: { options: ChatOptions }) => {
          const messages = options.messages.map((message) => ({ role: message.role, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }));
          const answer = await deps.ask({ version: "crossline.form-observe.v1", messages });
          if (!answer) throw new Error("FORM_OBSERVER_NO_ANSWER");
          const parsed = options.response_model ? options.response_model.schema.safeParse(answer) : { success: true, data: answer };
          if (!parsed.success) throw new Error("FORM_OBSERVER_SHAPE");
          return { data: parsed.data, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
        }
      };
      const { observe } = await import("@browserbasehq/stagehand/lib/inference");
      const result = await observe({ instruction: observeInstruction(context), domElements: tree, llmClient: llmClient as unknown as Parameters<typeof observe>[0]["llmClient"],
        userProvidedInstructions: observeRules(context), logger: () => undefined, supportedActions: [...OBSERVE_SUPPORTED],
        variables: observeVariables(context.profile) });
      return observedActions(result.elements, elements);
    }
  };
}

/**
 * browser-use as the second fallback (docs/opportunity-agent.md §10.7; MIT). It never touches the person's window: the engine hands over
 * the page's DOM (already redacted), and it is loaded into a throwaway headless browser of its own — an empty temporary profile with no
 * cookies, a CSP that lets no script run, every request refused but the copy itself and stylesheets from the run's own hosts — whose
 * DevTools port (loopback, this run only) browser-use connects to. Its model is a Crossline Skill run (`ask`) behind a loopback
 * endpoint with a one-run token, every message redacted again. What it proposes through `propose_field` becomes the engine's actions
 * (`browserUseActions`), judged and done by the engine on the real page. Without the download, a browser, or the page's DOM (a compute
 * node does not send it), it proposes nothing.
 */
export function browserUseFallback(deps: { python: () => string | undefined; executable: () => string | undefined;
  ask: (input: FormBrowserInput, schema: Record<string, unknown>) => Promise<unknown>; maxSteps?: number; timeoutMs?: number;
  log?: (event: Record<string, unknown>) => void }): FormFallback {
  return {
    name: "browser-use",
    propose: async ({ nodes, context, html, url, redact }): Promise<FormAction[] | undefined> => {
      const python = deps.python();
      const executable = deps.executable();
      if (!python || !executable || !html || !/^https?:/.test(url)) return undefined;
      const copy = await html();
      const hosts = runHosts(context.intent.host);
      const dir = mkdtempSync(path.join(tmpdir(), "crossline-bu-"));
      const token = randomBytes(18).toString("hex");
      const answer = async (request: IncomingMessage) => {
        if (request.method !== "POST" || request.url !== `/${token}/v1/chat/completions`) throw new Error("FORM_BROWSER_ROUTE");
        let raw = "";
        for await (const chunk of request) { raw += String(chunk); if (raw.length > 4_000_000) throw new Error("FORM_BROWSER_TOO_LARGE"); }
        const body = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }>; response_format?: { json_schema?: { schema?: unknown } } };
        // Text only: vision is off, and any other part is dropped rather than passed on.
        const text = (content: unknown): string => typeof content === "string" ? content
          : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("\n") : "";
        const messages = (body.messages ?? []).map((message) => ({ role: String(message.role ?? "user"), content: redact(text(message.content)) }));
        const output = await deps.ask({ version: "crossline.form-browser.v1", messages }, browserUseSchema(body.response_format?.json_schema?.schema ?? { type: "object" }));
        if (output === undefined) throw new Error("FORM_BROWSER_NO_ANSWER");
        return { id: `crossline-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "crossline-form-browser-agent",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      };
      const server = createServer((request, response) => {
        void answer(request).then((body) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); },
          () => { response.writeHead(502, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "no answer" } })); }); // i18n-ignore: an HTTP body
      });
      const { chromium } = await import("playwright-core");
      const shadow = await chromium.launchPersistentContext(path.join(dir, "profile"), { executablePath: executable, headless: true, acceptDownloads: false,
        serviceWorkers: "block", args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"] }).catch(() => undefined);
      if (!shadow) { rmSync(dir, { recursive: true, force: true }); return undefined; }
      try {
        await shadow.route("**/*", async (route) => {
          const request = route.request();
          if (request.url() === url && request.method() === "GET" && request.isNavigationRequest()) {
            return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: copy,
              headers: { "content-security-policy": "script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; worker-src 'none'" } });
          }
          if (request.method() === "GET" && request.resourceType() === "stylesheet" && /^https:/.test(request.url()) && onHosts(request.url(), hosts)) return route.continue();
          return route.abort("blockedbyclient");
        });
        const page = shadow.pages()[0] ?? await shadow.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const portFile = path.join(dir, "profile", "DevToolsActivePort");
        for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        const port = Number(readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const shim = (server.address() as AddressInfo).port;
        const proposals = await runBrowserUse({ python, scriptDir: dir, cdpUrl: `http://127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${shim}/${token}/v1`,
          apiKey: token, task: browserUseTask(context), allowedDomains: hosts, maxSteps: deps.maxSteps ?? 3, timeoutMs: deps.timeoutMs ?? 6 * 60_000 });
        deps.log?.({ event: "form.browser_use", proposals: proposals?.length ?? null });
        return proposals ? browserUseActions(proposals, nodes) : undefined;
      } finally {
        server.close();
        await shadow.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

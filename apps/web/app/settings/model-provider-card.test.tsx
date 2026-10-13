import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ModelProviderCard, type ProviderView } from "./model-provider-card";

const base: ProviderView = { provider: null, presets: [{ id: "deepseek", label: "DeepSeek", kind: "chat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" }],
  unavailable: "联网查证、画像插图、电脑上的助手、日历应用读取和跨次记忆只在 ChatGPT 登录（或 OpenAI API key）下可用；其余功能按检验结果开放。",
  signedIn: false, conformance: null, features: [], testing: null };

test("with nothing added the card offers the starting points and says what another model can never do here", () => {
  const html = renderToStaticMarkup(<ModelProviderCard initial={base} />);
  expect(html).toContain("未添加");
  expect(html).toContain("DeepSeek");
  expect(html).toContain("联网查证、画像插图");
});

test("a tested provider lists what it serves and, for the rest, why not — never the key", () => {
  const html = renderToStaticMarkup(<ModelProviderCard initial={{ ...base,
    provider: { id: "deepseek", kind: "chat", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyLast4: "9xyz" },
    conformance: { ranAt: "2026-10-13T11:00:00.000Z", passRate: 0.94, repairRate: 0.03, p95Ms: 41_000, runs: 35, current: true, failures: [] },
    features: [{ skill: "crossline-task-titler", label: "任务命名", critical: false, served: true, reason: "" },
      { skill: "crossline-due-diligence", label: "网上查证", critical: false, served: false, reason: "网上查证要联网搜索，这个模型连接没有" }] }} />);
  expect(html).toContain("承担 1 项");
  expect(html).toContain("任务命名");
  expect(html).toContain("网上查证要联网搜索");
  expect(html).toContain("密钥 ···9xyz");
  expect(html).toContain("一次答对或修正后答对 94%");
  expect(html).not.toMatch(/sk-|SKILL_|MODEL_/);
});

test("while the check runs, its progress shows", () => {
  const html = renderToStaticMarkup(<ModelProviderCard initial={{ ...base, testing: { done: 4, total: 35 },
    provider: { id: "ollama", kind: "responses", label: "本机 Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", keyLast4: null } }} />);
  expect(html).toContain("检验中");
  expect(html).toContain("4 / 35");
  expect(html).toContain("无需密钥");
});

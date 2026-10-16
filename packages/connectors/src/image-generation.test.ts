import { expect, test } from "vitest";
import { imageBackend, imageBackendFromEnv } from "./image-generation";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

test("SiliconFlow style: posts image_size, then downloads the linked image without the key", async () => {
  const calls: Array<{ url: string; auth: string | null; body?: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return String(url).endsWith("/images/generations") ? new Response(JSON.stringify({ images: [{ url: "https://cdn.example.com/a.png" }] })) : new Response(PNG);
  }) as typeof fetch;
  const backend = imageBackend({ apiKey: "k", baseUrl: "https://api.siliconflow.cn/v1", model: "black-forest-labs/FLUX.1-dev", size: "1024x1024", style: "siliconflow", fetchImpl });
  expect((await backend.generate("a figure", { seed: 7 })).equals(PNG)).toBe(true);
  expect(JSON.parse(calls[0]!.body!)).toMatchObject({ model: "black-forest-labs/FLUX.1-dev", image_size: "1024x1024", prompt_enhancement: false, seed: 7 });
  expect(calls[1]).toMatchObject({ url: "https://cdn.example.com/a.png", auth: null });
});

test("OpenAI style: b64_json is accepted; anything that is not an image is refused", async () => {
  const b64 = (async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))) as typeof fetch;
  const ok = imageBackend({ apiKey: "k", baseUrl: "https://ark.example.com/api/v3", model: "m", size: "1024x1024", style: "openai", fetchImpl: b64 });
  expect((await ok.generate("p")).equals(PNG)).toBe(true);
  const junk = (async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("hello").toString("base64") }] }))) as typeof fetch;
  const bad = imageBackend({ apiKey: "k", baseUrl: "https://ark.example.com/api/v3", model: "m", size: "1024x1024", style: "openai", fetchImpl: junk });
  await expect(bad.generate("p")).rejects.toThrow("IMAGE_NOT_AN_IMAGE");
});

test("from the environment: no key, no backend; SiliconFlow's address picks its style", () => {
  expect(imageBackendFromEnv({})).toBeUndefined();
  expect(imageBackendFromEnv({ SILICONFLOW_API_KEY: "k" })).toMatchObject({ id: "siliconflow", model: "black-forest-labs/FLUX.1-dev" });
  expect(imageBackendFromEnv({ CROSSLINE_IMAGE_API_KEY: "k", CROSSLINE_IMAGE_BASE_URL: "https://ark.example.com/api/v3", CROSSLINE_IMAGE_MODEL: "seedream" }))
    .toMatchObject({ id: "openai", model: "seedream" });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("connectors page", () => {
  test("does not claim measured connector health", async () => {
    const { default: ConnectorsPage } = await import("./page");
    const html = renderToStaticMarkup(<ConnectorsPage />);
    expect(html).not.toContain("连接器健康");
    expect(html).not.toContain("待授权");
    expect(html).toContain("CONNECTOR_NOT_CONFIGURED");
  });
});

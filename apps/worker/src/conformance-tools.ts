// i18n-exempt: the conformance case's repair messages go to the model under test, never to the person
import type { ConformanceCase } from "@crossline/core";
import type { SkillTools } from "@crossline/codex";

/**
 * The function a conformance case offers (`ConformanceCase.tool`), and the check that it was called and its answer used. A case
 * without one gets neither. Used by both conformance runners, the person's own provider and the developer's candidates.
 */
export function caseTools(item: ConformanceCase): { tools?: SkillTools; check: (output: unknown) => void } {
  const tool = item.tool;
  if (!tool) return { check: () => {} };
  let called = false;
  return {
    tools: { specs: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }], call: () => { called = true; return tool.reply; } },
    check: (output) => {
      if (!called) throw Object.assign(new Error("CONFORMANCE_TOOL_NOT_CALLED"), { detail: `先调用函数 ${tool.name}，再用它返回的内容作答。` });
      if ((output as { code?: unknown }).code !== tool.reply) throw Object.assign(new Error("CONFORMANCE_TOOL_IGNORED"), { detail: `code 应是 ${tool.name} 返回的值。` });
    }
  };
}

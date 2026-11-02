import { OBSERVE_SUPPORTED, observedActions, observeInstruction, observeRules, observeTree, observeVariables, type FormAction,
  type FormObserveAnswer, type FormObserveInput } from "@crossline/core";
import type { FormFallback } from "./form-engine";

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

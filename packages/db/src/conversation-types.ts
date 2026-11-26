export type StoredAssistantThread = {
  id: string; ownerId: string; workspaceId: string;
  codexThreadId?: string; workOrderId?: string; createdAt: string; updatedAt: string;
};

export type StoredAssistantAttachment = {
  id: string; ownerId: string; workspaceId: string; threadId: string;
  uri: string; mediaType: string; fileName: string; createdAt: string;
};

/** The one input box's conversation of a day (docs/one-input.md). */
/** `kind` 'day' is the day's conversation (the default thread); 'thread' one the person started in 小帮手, with its own `title`. */
export type StoredConversation = { id: string; workspaceId: string; day: string; codexThreadId?: string; createdAt: string; updatedAt: string;
  kind: "day" | "thread"; title: string; archivedAt?: string; instructionsSeen: number };
/** person = typed by the person; assistant = the turn's answer (its card in `payload`); nudge = a message the system started. */
export type ConversationRole = "person" | "assistant" | "nudge";
export type StoredConversationMessage = {
  id: string; workspaceId: string; conversationId: string; role: ConversationRole; text: string; payload: Record<string, unknown>; createdAt: string;
};

import type { PiMessage } from "./types";

// Pi 1.1 sends deltas without a cumulative message. Completed blocks replace
// reconstructed content; message_end remains the final authority.
export function applyStream(
  message: PiMessage,
  event: any,
  usage?: any,
): PiMessage {
  const content = Array.isArray(message.content) ? message.content.slice() : [];
  const i = event.contentIndex;
  if (!Number.isInteger(i) || i < 0 || i > 1024) return message;
  const old = content[i] || {};
  if (event.type === "text_start") content[i] = { type: "text", text: "" };
  if (event.type === "text_delta")
    content[i] = { type: "text", text: (old.text || "") + event.delta };
  if (event.type === "text_end")
    content[i] = { type: "text", text: event.content };
  if (event.type === "thinking_start")
    content[i] = { type: "thinking", thinking: "" };
  if (event.type === "thinking_delta")
    content[i] = {
      type: "thinking",
      thinking: (old.thinking || "") + event.delta,
    };
  if (event.type === "thinking_end")
    content[i] = { type: "thinking", thinking: event.content };
  if (event.type === "toolcall_start")
    content[i] = {
      type: "toolCall",
      id: event.id,
      name: event.toolName,
      arguments: {},
      argumentText: "",
    };
  if (event.type === "toolcall_delta")
    content[i] = {
      ...old,
      argumentText: (old.argumentText || "") + event.delta,
    };
  if (event.type === "toolcall_end") content[i] = event.toolCall;
  return { ...message, content, usage: usage || message.usage };
}

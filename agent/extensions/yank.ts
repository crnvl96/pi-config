/**
 * yank.ts — Copy a session tree node's text content to the clipboard.
 *
 * Triggered by:
 *   - Alt+Shift+Y: opens the session tree, pick a node, press Enter
 *   - /yank:       same action as a slash command
 *
 * Content extraction:
 *   - user / toolResult / custom: concatenated text blocks
 *     (image blocks are skipped)
 *   - assistant: concatenated text blocks
 *     (thinking and tool-call blocks are skipped)
 *   - bashExecution: the full output
 *   - branchSummary / compactionSummary: the summary string
 *   - non-message entries (label, model_change, custom state, etc.) are
 *     skipped and surface a notification
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { TreeSelectorComponent, copyToClipboard } from "@earendil-works/pi-coding-agent";

/** Structural shape of a text content block, used purely as a type guard target. */
type TextContentLike = { type: "text"; text: string };

/** Extract plain text from a `string | array of content blocks` content field. */
function blocksToText(content: string | readonly unknown[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is TextContentLike =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n\n");
}

/** Get the copyable text from a session entry, or null if there is none. */
function extractText(entry: SessionEntry | undefined): string | null {
  if (!entry || entry.type !== "message") return null;
  // The `message` field is an AgentMessage discriminated union on `role`.
  // After narrowing on `entry.type === "message"`, the `message` field
  // is the union and each case below narrows it to a specific variant.
  const message = entry.message;
  switch (message.role) {
    case "user":
    case "custom":
      return blocksToText(message.content);
    case "assistant":
    case "toolResult":
      return blocksToText(message.content);
    case "bashExecution":
      return message.output;
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default:
      return null;
  }
}

async function runYank(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("yank: TUI mode required", "warning");
    return;
  }

  const tree = ctx.sessionManager.getTree();
  if (tree.length === 0) {
    ctx.ui.notify("yank: session is empty", "info");
    return;
  }

  const leafId = ctx.sessionManager.getLeafId();

  const selectedId = await ctx.ui.custom<string | null>((tui, _theme, _keybindings, done) => {
    const component = new TreeSelectorComponent(
      tree,
      leafId,
      tui.terminal.rows,
      (entryId) => done(entryId),
      () => done(null),
    );
    return component;
  });

  if (!selectedId) return; // user pressed Escape

  const text = extractText(ctx.sessionManager.getEntry(selectedId));

  if (text === null) {
    ctx.ui.notify("yank: selected node has no copyable text", "warning");
    return;
  }
  if (text.length === 0) {
    ctx.ui.notify("yank: selected node is empty", "info");
    return;
  }

  try {
    await copyToClipboard(text);
    const size =
      text.length < 1024 ? `${text.length} chars` : `${(text.length / 1024).toFixed(1)} KB`;
    ctx.ui.notify(`yank: copied ${size} to clipboard`, "info");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`yank: copy failed: ${message}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+y", {
    description: "Copy session tree node content to clipboard",
    handler: runYank,
  });

  pi.registerCommand("yank", {
    description: "Copy a session tree node's content to the clipboard",
    handler: async (_args, ctx) => runYank(ctx),
  });
}

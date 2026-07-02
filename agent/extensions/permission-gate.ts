import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PERMISSION_GATE_BASH_PATTERNS = [
  { label: "git push", regex: /git push/ },
  { label: "git reset --hard", regex: /git reset --hard/ },
  { label: "git clean -fd", regex: /git clean -fd/ },
  { label: "git clean -f", regex: /git clean -f/ },
  { label: "git branch -D", regex: /git branch -D/ },
  { label: "git checkout .", regex: /git checkout \./ },
  { label: "git restore .", regex: /git restore \./ },
  { label: "push --force", regex: /push --force/ },
  { label: "reset --hard", regex: /reset --hard/ },
];

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = String(event.input.command ?? "");

    const match = PERMISSION_GATE_BASH_PATTERNS.find((pattern) => pattern.regex.test(command));
    if (!match) return;

    if (!ctx.hasUI)
      return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };

    process.stdout.write(`\x1b]777;notify;"Pi";"Dangerous command needs approval"\x07`);

    const choice = await ctx.ui.select(`Dangerous command:\n\n  ${command}\n\nAllow?`, [
      "Yes",
      "No",
    ]);

    if (choice !== "Yes")
      return {
        block: true,
        reason: `BLOCKED: '${command}' matches dangerous pattern '${match.label}'. The user has prevented you from doing this.`,
      };

    return;
  });
}

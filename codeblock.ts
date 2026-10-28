import { execFileSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "display_codeblock",
    label: "Code",
    description: "Display code for the user without a left border or line numbers. Does not execute it. The user can copy the exact original with /copy-code.",
    promptSnippet: "Display copyable, syntax-highlighted code without a left border",
    promptGuidelines: ["Use display_codeblock instead of Markdown fences when the user needs code or shell commands to copy."],
    parameters: Type.Object({
      code: Type.String({ description: "Exact raw code, without Markdown fences" }),
      language: Type.Optional(Type.String({ description: "Syntax language, e.g. bash or typescript" })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    renderShell: "self",
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: "Code displayed. /copy-code copies the original without formatting." }],
        details: params,
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("accent", `── ${args.language || "code"} ──`) + theme.fg("muted", "  /copy-code"), 0, 0);
    },
    renderResult(result, _options, theme) {
      if (!result.details) return new Text("", 0, 0);
      const { code, language } = result.details;
      return new Text(highlightCode(code, language).join("\n") + "\n" + theme.fg("muted", "────────────────────"), 0, 0);
    },
  }));

  pi.registerCommand("copy-code", {
    description: "Choose a displayed code block on this branch and copy it to the macOS clipboard",
    handler: async (_args, ctx) => {
      const blocks = [...ctx.sessionManager.getBranch()].reverse().flatMap(entry => {
        if (entry.type !== "message" || entry.message.role !== "toolResult" ||
            entry.message.toolName !== "display_codeblock" || entry.message.isError) return [];
        const details = entry.message.details as { code?: unknown; language?: unknown } | undefined;
        if (typeof details?.code !== "string") return [];
        return [{ code: details.code, language: typeof details.language === "string" ? details.language : "code" }];
      });
      if (blocks.length === 0) {
        ctx.ui.notify("No displayed code on this branch.", "warning");
        return;
      }
      const labels = blocks.map((block, index) => {
        const preview = (block.code.split("\n").find(line => line.trim()) || "(empty)")
          .replace(/[\x00-\x1f\x7f]/g, " ").trim();
        return `${index + 1}. ${block.language.replace(/[\x00-\x1f\x7f]/g, " ")} · ${preview}`;
      });
      const selected = await ctx.ui.select("Copy code · newest first", labels);
      if (selected === undefined) return;
      const block = blocks[labels.indexOf(selected)];
      if (!block) return;
      try {
        execFileSync("/usr/bin/pbcopy", [], { input: block.code, timeout: 3000 });
        ctx.ui.notify("Code copied without borders or formatting.", "info");
      } catch (error) {
        ctx.ui.notify(`Clipboard failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

/**
 * always-on — persistent agent workers in tmux.
 *
 * Tools (model-callable, namespace "always-on"):
 *   always_on_start   start a persistent TUI agent worker
 *   always_on_send    type a prompt into a worker and press Enter
 *   always_on_log     read the worker's screen (last N lines)
 *   always_on_status   list workers / check one worker
 *   always_on_stop    stop a worker
 *
 * Command (human): /always-on list | show <name> | run <name> <task> | start [name] [dir] | stop <name> | attach <name>
 *
 * `run` behaves like a subagent: it delegates a task to the worker and waits
 * until the worker settles, then reports its reply.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  capturePane,
  DEFAULT_WORKER_NAME,
  listSessions,
  runDelegated,
  sendText,
  startWorker,
  stopWorker,
} from "./lib.ts";

const NAMESPACE = {
  name: "always-on",
  aliases: ["alwayson"],
  description: "Persistent agent workers (independent pi sessions living in tmux)",
  instructions:
    "Workers survive terminal-window closes but pause while the machine sleeps and are lost on reboot. " +
    "Each worker has its own history and working directory; it shares provider auth with the same machine. " +
    "Worker names are tmux session names (default 'worker'). Use always_on_start then always_on_send, " +
    "and read output with always_on_log.",
};

const NAME_DESC = "Worker name (tmux session name; default: worker)";

const startParams = Type.Object({
  name: Type.Optional(Type.String({ description: NAME_DESC })),
  dir: Type.Optional(Type.String({ description: "Working directory for the worker (default ~/.pi/workers/<name>)" })),
});

const sendParams = Type.Object({
  name: Type.String({ description: NAME_DESC }),
  text: Type.String({ description: "Prompt text to type into the worker (newlines become spaces)" }),
});

const logParams = Type.Object({
  name: Type.String({ description: NAME_DESC }),
  lines: Type.Optional(Type.Number({ description: "How many screen lines to capture (default 40, max 500)" })),
});

const statusParams = Type.Object({
  name: Type.Optional(Type.String({ description: NAME_DESC })),
});

const stopParams = Type.Object({
  name: Type.String({ description: NAME_DESC }),
});

export default function alwaysOnExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "always_on_start",
    label: "Always-on: start worker",
    description:
      "Start a persistent agent worker: an interactive pi session in its own tmux session. " +
      "Returns the worker's initial screen. If it is already running, returns its current screen.",
    namespace: NAMESPACE,
    parameters: startParams,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const name = (params.name as string | undefined) || DEFAULT_WORKER_NAME;
      const dir = params.dir as string | undefined;
      const { alreadyRunning, dir: actualDir, initialScreen } = await startWorker(name, dir);
      return {
        content: [
          {
            type: "text",
            text:
              (alreadyRunning ? `Worker '${name}' already running` : `Started worker '${name}'`) +
              `\nDirectory: ${actualDir}` +
              `\nInitial screen:\n${initialScreen || "(still starting…)"}`,
          },
        ],
        details: { name, dir: actualDir, alreadyRunning },
      };
    },
  });

  pi.registerTool({
    name: "always_on_send",
    label: "Always-on: send prompt",
    description:
      "Type literal text into a worker and press Enter. Use to give the worker a new task or continue a conversation.",
    namespace: NAMESPACE,
    parameters: sendParams,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { sent } = await sendText(params.name as string, params.text as string);
      return {
        content: [{ type: "text", text: `Sent to '${params.name}': ${sent}` }],
        details: { name: params.name, sent },
      };
    },
  });

  pi.registerTool({
    name: "always_on_log",
    label: "Always-on: read worker screen",
    description: "Capture the worker's screen (last N lines, ANSI-stripped) to see its output and state.",
    namespace: NAMESPACE,
    parameters: logParams,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const name = params.name as string;
      const lines = (params.lines as number | undefined) ?? 40;
      const screen = await capturePane(name, lines);
      return {
        content: [
          {
            type: "text",
            text: screen ? `Worker '${name}' screen:\n${screen}` : `Worker '${name}' screen is empty.`,
          },
        ],
        details: { name, lines, screen },
      };
    },
  });

  pi.registerTool({
    name: "always_on_status",
    label: "Always-on: status",
    description: "List always-on workers and other tmux sessions, or check whether one worker is running.",
    namespace: NAMESPACE,
    parameters: statusParams,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const name = params.name as string | undefined;
      const sessions = await listSessions();
      const lines: string[] = [];

      if (name) {
        const found = sessions.find((s) => s.name === name);
        if (!found) {
          lines.push(`Worker '${name}' is not running.`);
        } else {
          lines.push(`Worker '${name}' is running.`);
          if (found.dir) lines.push(`Directory: ${found.dir}`);
          if (found.windows !== undefined) lines.push(`Windows: ${found.windows}`);
        }
      } else {
        if (sessions.length === 0) {
          lines.push("No tmux sessions running.");
        } else {
          for (const s of sessions) {
            const kind = s.dir ? "always-on worker" : "other tmux session";
            lines.push(`- ${s.name} (${kind})${s.windows !== undefined ? `, ${s.windows} window(s)` : ""}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { name, sessions },
      };
    },
  });

  pi.registerTool({
    name: "always_on_stop",
    label: "Always-on: stop worker",
    description: "Stop a worker by killing its tmux session. The worker's directory and history remain on disk.",
    namespace: NAMESPACE,
    parameters: stopParams,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const name = params.name as string;
      await stopWorker(name);
      return {
        content: [{ type: "text", text: `Stopped worker '${name}'.` }],
        details: { name },
      };
    },
  });

  pi.registerCommand("always-on", {
    description:
      "Manage always-on workers like subagents: list | show <name> | run <name> <task> | start [name] [dir] | stop <name> | attach <name>",
    getArgumentCompletions: (prefix) => {
      const words = ["list", "show", "run", "start", "stop", "attach"];
      const first = prefix.trim().split(/\s+/)[0] ?? "";
      return words.filter((w) => w.startsWith(first)).map((w) => ({ value: w, label: w }));
    },
    handler: async (args, ctx) => {
      const notify = (text: string, kind: "info" | "error" | "warning" = "info") => {
        ctx.ui.notify(text, kind);
      };
      const [verb, ...rest] = args.trim().split(/\s+/);

      try {
        // No verb → list workers, mirroring /subagent's list behavior.
        if (!verb || verb === "list") {
          const sessions = await listSessions();
          if (sessions.length === 0) {
            notify("No always-on workers running. Start one: /always-on start", "info");
            return;
          }
          const text = sessions
            .map((s) => `• ${s.name} — ${s.dir ? "always-on worker" : "other tmux session"}`)
            .join("\n");
          notify(`Workers:\n${text}`, "info");
          return;
        }

        if (verb === "show") {
          const name = rest[0] || DEFAULT_WORKER_NAME;
          const sessions = await listSessions();
          const found = sessions.find((s) => s.name === name);
          if (!found) {
            notify(`No worker named "${name}" is running`, "warning");
            return;
          }
          const tail = await capturePane(name, 40).catch(() => "");
          const excerpt = tail
            .split("\n")
            .filter((l) => l.trim())
            .slice(-14)
            .join("\n");
          notify(
            `${name} — running\n` +
              `Directory: ${found.dir || "(unknown)"}\n\n` +
              `Last screen:\n${excerpt || "(empty)"}`,
            "info",
          );
          return;
        }

        // Delegation flow: send the task, wait for the worker to settle, then
        // report the reply like a subagent outcome.
        if (verb === "run") {
          const name = rest[0];
          const task = rest.slice(1).join(" ");
          if (!name || !task) {
            notify("Usage: /always-on run <name> <task>", "error");
            return;
          }
          notify(`Delegating to '${name}'… (waiting for it to finish)`, "info");
          const report = await runDelegated(name, task);
          const status = report.settled
            ? `done in ${Math.round(report.elapsedMs / 1000)}s`
            : `still busy after ${Math.round(report.elapsedMs / 1000)}s (partial result)`;
          notify(
            `[always-on:${report.name}] ${status}.\n\n` +
              `${report.reply || "(no reply captured)"}`,
            "info",
          );
          return;
        }

        if (verb === "start") {
          const name = rest[0] || DEFAULT_WORKER_NAME;
          const dir = rest[1];
          const { alreadyRunning, dir: actualDir } = await startWorker(name, dir);
          notify(
            alreadyRunning
              ? `Worker '${name}' already running (${actualDir})`
              : `Started worker '${name}' in ${actualDir}`,
            "info",
          );
          notify(`Attach anytime: tmux attach -t ${name}`, "info");
          return;
        }

        if (verb === "stop") {
          const name = rest[0];
          if (!name) {
            notify("Usage: /always-on stop <name>", "error");
            return;
          }
          await stopWorker(name);
          notify(`Stopped worker '${name}'.`, "info");
          return;
        }

        if (verb === "attach") {
          const name = rest[0];
          if (!name) {
            notify("Usage: /always-on attach <name>", "error");
            return;
          }
          notify(`Run in an external terminal: tmux attach -t ${name}`, "info");
          return;
        }

        notify(
          `Unknown /always-on verb "${verb}". Try: list, show <name>, run <name> <task>, start, stop <name>, attach <name>`,
          "warning",
        );
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}

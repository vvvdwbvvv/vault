/**
 * Functional smoke test for always-on (lib.ts) — uses a real tmux session
 * and a real pi worker process. Covers start → send → log → status → stop,
 * plus the subagent-like delegation helpers (extractReply / isIdleScreen /
 * waitUntilIdle / runDelegated).
 *
 * Run: node --experimental-strip-types test.ts
 */

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capturePane,
  extractReply,
  hasSession,
  isIdleScreen,
  listSessions,
  runDelegated,
  sendText,
  startWorker,
  stopWorker,
  findTmux,
} from "./lib.ts";

const FAILED: string[] = [];

function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${extra}`}`);
  if (!ok) FAILED.push(label);
}

async function main(): Promise<void> {
  // ---- pure helper checks (no tmux needed) ----
  const fakeBusy = ["┌─ model thinking ────────┐", "│ thinking…                │", "└─ spinner ───────────────┘", "generating…"].join("\n");
  const fakeIdle = ["─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─", "❯ "].join("\n");
  check("isIdleScreen detects idle", isIdleScreen(fakeIdle) && !isIdleScreen(fakeBusy), "busy+idle screens");

  const replyScreen = [
    "user: what is 2+2?",
    "assistant: 4",
    "❯ ",
    "status: idle",
  ].join("\n");
  const reply = extractReply(replyScreen, "what is 2+2?");
  check("extractReply pulls the reply", reply.includes("4") && !reply.includes("❯"), JSON.stringify(reply));

  // ---- live tmux worker ----
  const tmp = await mkdtemp(path.join(os.tmpdir(), "always-on-test-"));
  const name = `ao-test-${Date.now() % 100000}`;

  const tmux = await findTmux();
  check("tmux found", !!tmux, `resolved to ${tmux}`);

  const before = await listSessions();
  check("listSessions works", Array.isArray(before));

  const { alreadyRunning, dir } = await startWorker(name, tmp);
  check("startWorker created session", !alreadyRunning && (await hasSession(tmux, name)), dir);

  let screen = "";
  for (let i = 0; i < 40; i++) {
    screen = await capturePane(name, 40);
    if (screen.trim()) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  check("worker screen has content", screen.trim().length > 0, `first 60 chars: ${screen.trim().slice(0, 60)}`);

  const probe = `probe ${Date.now()}`;
  await sendText(name, probe);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await capturePane(name, 40);
  check("sent text appears on worker screen", after.includes(probe), `screen tail: ${after.slice(-120)}`);

  // Delegation flow (subagent-like). The worker may reply or error out
  // (e.g. provider quota) — either way it should settle and yield a report.
  const report = await runDelegated(name, `reply with the single word pong (test ${Date.now()})`, {
    timeoutMs: 90_000,
  });
  check("runDelegated settled", report.settled, `elapsed=${report.elapsedMs}ms`);
  check("runDelegated produced a report", typeof report.reply === "string" && report.reply.length > 0, JSON.stringify(report.reply.slice(-120)));

  const sessions = await listSessions();
  const mine = sessions.find((s) => s.name === name);
  check("status lists the worker", !!mine && mine.running, JSON.stringify(mine));

  await stopWorker(name);
  const gone = !(await hasSession(tmux, name));
  check("stopWorker removed session", gone);
}

main()
  .then(() => {
    console.log(FAILED.length === 0 ? "\nALL TESTS PASSED" : `\n${FAILED.length} TEST(S) FAILED`);
    process.exit(FAILED.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("test harness error:", err);
    process.exit(2);
  });

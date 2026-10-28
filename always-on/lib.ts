/**
 * always-on core: tmux-backed persistent worker management.
 *
 * A worker is a full, interactive `pi` (TUI) running inside its own named,
 * detached tmux session, so it survives terminal-window closes. The agent
 * drives it with send / capture; a human can attach with `tmux attach`.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WORKERS_DIR = path.join(os.homedir(), ".pi", "workers");
export const DEFAULT_WORKER_NAME = "worker";
export const MAX_SEND_LENGTH = 8000;

export function getWorkersDir(): string {
  return process.env.ALWAYS_ON_WORKERS_DIR || DEFAULT_WORKERS_DIR;
}

export function workerDir(name: string): string {
  return path.join(getWorkersDir(), name);
}

export function getPiBin(): string {
  return process.env.ALWAYS_ON_PI_BIN || "pi";
}

export function getPiArgs(): string {
  return process.env.ALWAYS_ON_PI_ARGS || "";
}

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

let cachedTmux: string | undefined;

export async function findTmux(): Promise<string> {
  if (cachedTmux) return cachedTmux;
  const candidates = [
    "tmux",
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    path.join(os.homedir(), ".local", "bin", "tmux"),
  ];
  for (const c of candidates) {
    try {
      await execFileAsync(c, ["-V"]);
      cachedTmux = c;
      return c;
    } catch {
      // try next candidate
    }
  }
  throw new Error("tmux not found (checked PATH and common locations)");
}

export interface WorkerSession {
  name: string;
  dir: string;
  running: boolean;
  windows?: number;
  created?: string;
}

export async function hasSession(tmux: string, name: string): Promise<boolean> {
  try {
    await execFileAsync(tmux, ["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export async function listSessions(): Promise<WorkerSession[]> {
  const tmux = await findTmux();
  const workersDir = getWorkersDir();
  try {
    const { stdout } = await execFileAsync(tmux, ["ls", "-F", "#{session_name}:#{session_windows}:#{session_created}"]);
    const out: WorkerSession[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, windows, created] = trimmed.split(":");
      out.push({
        name: name ?? trimmed,
        dir: workerDir(name ?? trimmed),
        running: true,
        windows: windows !== undefined ? Number(windows) : undefined,
        created,
      });
    }
    // Mark which sessions look like always-on workers (their workdir exists).
    for (const s of out) {
      try {
        await fs.access(s.dir);
      } catch {
        s.dir = "";
      }
    }
    void workersDir;
    return out;
  } catch {
    return []; // no tmux server running -> no sessions
  }
}

export async function startWorker(name: string, dirOverride?: string): Promise<{ alreadyRunning: boolean; dir: string; initialScreen: string }> {
  const tmux = await findTmux();
  const dir = dirOverride || workerDir(name);
  await fs.mkdir(dir, { recursive: true });

  if (await hasSession(tmux, name)) {
    return { alreadyRunning: true, dir, initialScreen: await capturePane(name, 40) };
  }

  const cmd = `${getPiBin()} ${getPiArgs()}`.trim();
  await execFileAsync(tmux, ["new-session", "-d", "-s", name, "-c", dir, cmd]);

  // Poll until the worker's screen has content (or give up after 12s).
  let screen = "";
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    screen = await capturePane(name, 40).catch(() => "");
    if (screen.trim()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { alreadyRunning: false, dir, initialScreen: screen };
}

export async function requireSession(tmux: string, name: string): Promise<void> {
  if (!(await hasSession(tmux, name))) {
    throw new Error(`worker '${name}' is not running (start it with always_on_start)`);
  }
}

/** Send literal text into the worker's input, then press Enter. */
export async function sendText(name: string, text: string): Promise<{ sent: string }> {
  const tmux = await findTmux();
  await requireSession(tmux, name);
  let clean = text.replace(/\r?\n/g, " ");
  if (clean.length > MAX_SEND_LENGTH) {
    clean = clean.slice(0, MAX_SEND_LENGTH) + " …(truncated)";
  }
  await execFileAsync(tmux, ["send-keys", "-t", name, "-l", clean]);
  await execFileAsync(tmux, ["send-keys", "-t", name, "Enter"]);
  return { sent: clean };
}

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|\([A-Z])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Capture the worker's screen, last N lines, ANSI-stripped. */
export async function capturePane(name: string, lines = 40): Promise<string> {
  const tmux = await findTmux();
  await requireSession(tmux, name);
  const n = Math.max(1, Math.min(lines, 500));
  const { stdout } = await execFileAsync(tmux, ["capture-pane", "-pt", name, "-S", `-${n}`]);
  const cleaned = stripAnsi(stdout)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n");
  return cleaned.trimEnd();
}

export async function stopWorker(name: string): Promise<void> {
  const tmux = await findTmux();
  await requireSession(tmux, name);
  await execFileAsync(tmux, ["kill-session", "-t", name]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * True when the screen shows the idle input marker (❯) near the bottom,
 * i.e. the worker is waiting for input rather than mid-run.
 */
export function isIdleScreen(screen: string): boolean {
  const tail = screen.split("\n").slice(-15);
  return tail.some((l) => /^❯/.test(l.trim()));
}

/**
 * Wait until the worker's screen stops changing (and shows the idle marker),
 * i.e. the worker finished what it was doing. Returns elapsed time and the
 * final screen.
 */
export async function waitUntilIdle(
  name: string,
  opts?: { timeoutMs?: number; sampleMs?: number },
): Promise<{ settled: boolean; elapsedMs: number; screen: string }> {
  const timeoutMs = opts?.timeoutMs ?? 240_000;
  const sampleMs = opts?.sampleMs ?? 1_500;
  const start = Date.now();
  let prev = "";
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    const screen = await capturePane(name, 200);
    if (isIdleScreen(screen) && screen === prev) {
      stable += 1;
      if (stable >= 3) {
        return { settled: true, elapsedMs: Date.now() - start, screen };
      }
    } else {
      stable = 0;
    }
    prev = screen;
    await sleep(sampleMs);
  }
  return { settled: false, elapsedMs: Date.now() - start, screen: prev };
}

/**
 * Extract the worker's reply from a screen capture: everything below the last
 * echo of the sent prompt, up to the input-marker line. Falls back to a
 * bounded tail when the prompt echo cannot be found.
 */
export function extractReply(screen: string, promptText: string): string {
  const lines = screen.split("\n");
  const anchor = promptText.split(/\s+/).slice(0, 6).join(" ");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (anchor && lines[i].includes(anchor)) {
      idx = i;
      break;
    }
  }

  const out: string[] = [];
  const rest = idx === -1 ? lines : lines.slice(idx + 1);
  for (const raw of rest) {
    const t = raw.trim();
    if (/^❯/.test(t)) break; // input marker / cursor zone
    if (/^[─━]{4,}$/.test(t)) continue; // separator filler
    if (!t && out.length === 0) continue;
    out.push(raw.replace(/^\s*│\s*/, "")); // strip left-border gutter
  }
  const text = out.join("\n").trim();
  if (text) return text;
  // Fallback: last non-empty chunk of the screen (minus footer lines).
  const meaningful = lines
    .map((l) => l.replace(/^\s*│\s*/, ""))
    .filter((l) => l.trim() && !/^❯/.test(l.trim()) && !/^[─━]{4,}$/.test(l.trim()));
  return meaningful.slice(-30).join("\n").trim();
}

/** Run a task on the worker and wait for it to finish. Returns a subagent-like report. */
export async function runDelegated(
  name: string,
  task: string,
  opts?: { timeoutMs?: number },
): Promise<{
  name: string;
  settled: boolean;
  elapsedMs: number;
  reply: string;
}> {
  const before = await capturePane(name, 100);
  await sendText(name, task);
  const { settled, elapsedMs, screen } = await waitUntilIdle(name, opts);
  void before;
  return { name, settled, elapsedMs, reply: extractReply(screen, task).slice(0, 4000) };
}

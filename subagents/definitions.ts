/**
 * Subagent definitions: types, a small frontmatter / YAML-lite parser, and the
 * loader that scans the extension's bundled `agents/` directory plus a user
 * directory (`~/.pi/subagents/`, overridable via `$PI_SUBAGENTS_DIR`).
 *
 * This module has no runtime dependency on pi or the model runtime, so it can be
 * unit-tested offline.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** A normalized subagent definition. */
export interface AgentDef {
  name: string;
  description: string;
  /**
   * `"*"` means "every callable tool except the `subagent` tool itself";
   * otherwise an explicit allow-list of tool names.
   */
  tools: string[] | "*";
  /** Optional `"provider/model"` override, e.g. `"openai/gpt-5"`. */
  model?: string;
  thinking?: "low" | "medium" | "high";
  maxTurns: number;
  temperature?: number;
  /** The body / system instructions. */
  instructions: string;
  /** Where the definition was loaded from (file path, or source root). */
  source: string;
}

/** A scalar value produced by the YAML-lite parser. */
export type YamlScalar = string | number | boolean | null | YamlScalar[];

/** Parse a YAML-lite scalar (string, number, boolean, null, inline array). */
export function parseScalar(raw: string): YamlScalar {
  let v = raw.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => parseScalar(s));
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * Minimal YAML-lite parser for frontmatter. Handles top-level `key: value`
 * scalars, inline arrays, and indented `- item` block lists. It intentionally
 * ignores the rest of YAML (nested maps, anchors, multi-line strings).
 */
export function parseYamlLite(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  let listKey: string | null = null;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) {
      i++;
      continue;
    }

    // Continuation of a `key:` block list.
    if (listKey && line.startsWith("- ")) {
      (out[listKey] as unknown[]).push(parseScalar(line.slice(2)));
      i++;
      continue;
    }
    listKey = null;

    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const val = m[2].trim();

    if (val === "") {
      // Maybe an indented block list follows.
      let j = i + 1;
      let sawList = false;
      while (j < lines.length) {
        const nxt = lines[j].trim();
        if (nxt === "" || nxt.startsWith("#")) {
          j++;
          continue;
        }
        if (nxt.startsWith("- ")) sawList = true;
        break;
      }
      if (sawList) {
        out[key] = [];
        listKey = key;
        i++;
        continue;
      }
      out[key] = "";
      i++;
      continue;
    }

    out[key] = parseScalar(val);
    i++;
  }

  return out;
}

/** Split a markdown document into its frontmatter meta and body. */
export function parseFrontmatter(md: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: md };
  return { meta: parseYamlLite(match[1]), body: md.slice(match[0].length) };
}

/** Normalize parsed frontmatter + body into a validated `AgentDef`. */
export function normalizeDef(
  meta: Record<string, unknown>,
  body: string,
  source: string,
  fallbackName: string,
): AgentDef {
  const toolsRaw = meta.tools === undefined ? "*" : meta.tools;
  const tools = Array.isArray(toolsRaw) ? toolsRaw.map(String) : "*";

  const turnsRaw = typeof meta["max_turns"] === "number" ? meta["max_turns"] : meta.maxTurns;
  const maxTurns =
    typeof turnsRaw === "number" && turnsRaw >= 1 ? Math.floor(turnsRaw) : 8;

  const thinking =
    meta.thinking === "low" || meta.thinking === "medium" || meta.thinking === "high"
      ? (meta.thinking as "low" | "medium" | "high")
      : undefined;

  return {
    name: String(meta.name ?? fallbackName),
    description: String(meta.description ?? ""),
    tools,
    model: typeof meta.model === "string" && meta.model ? meta.model : undefined,
    thinking,
    maxTurns,
    temperature: typeof meta.temperature === "number" ? meta.temperature : undefined,
    instructions: body.trim(),
    source,
  };
}

/** Load a single `.md` or `.json` definition file. */
export function loadDefFromFile(file: string): AgentDef {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, ext);

  if (ext === ".json") {
    let json: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      json = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      throw new Error(`Invalid subagent JSON "${file}": ${error instanceof Error ? error.message : String(error)}`);
    }
    const body =
      typeof json.instructions === "string"
        ? json.instructions
        : typeof json.system === "string"
          ? json.system
          : "";
    if (!body) throw new Error(`Subagent JSON "${file}" has no instructions/system body`);
    return normalizeDef(json, body, file, base);
  }

  const text = fs.readFileSync(file, "utf8");
  const { meta, body } = parseFrontmatter(text);
  if (!body) throw new Error(`Subagent markdown "${file}" has an empty body`);
  return normalizeDef(meta, body, file, base);
}

/** Scan a directory for `.md` / `.json` definitions, silently skipping broken ones. */
export function scanDir(dir: string): AgentDef[] {
  if (!fs.existsSync(dir)) return [];
  const out: AgentDef[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md") && !entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      out.push(loadDefFromFile(file));
    } catch {
      /* skip unreadable/malformed definitions */
    }
  }
  return out;
}

export interface AgentRegistryOptions {
  userDir?: string;
}

/**
 * Registry of subagent definitions. Bundled agents ship under `agents/` next to
 * this module; users can add/override in `~/.pi/subagents/` (or
 * `$PI_SUBAGENTS_DIR`). User definitions override bundled ones with the same
 * name.
 */
export class AgentRegistry {
  private defs = new Map<string, AgentDef>();
  readonly builtinDir: string;
  readonly userDir: string;

  constructor(opts: AgentRegistryOptions = {}) {
    this.builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
    this.userDir = opts.userDir ?? process.env.PI_SUBAGENTS_DIR ?? path.join(os.homedir(), ".pi", "subagents");
  }

  /** Re-scan both directories. User definitions win on name collisions. */
  load(): void {
    this.defs.clear();
    for (const def of scanDir(this.builtinDir)) this.defs.set(def.name, def);
    for (const def of scanDir(this.userDir)) this.defs.set(def.name, def);
  }

  /**
   * Create the user directory and copy the bundled examples into it the first
   * time it is used. Never overwrites an existing directory.
   */
  seed(): void {
    if (fs.existsSync(this.userDir)) return;
    fs.mkdirSync(this.userDir, { recursive: true });
    for (const entry of fs.readdirSync(this.builtinDir)) {
      if (!entry.endsWith(".md")) continue;
      fs.copyFileSync(path.join(this.builtinDir, entry), path.join(this.userDir, entry));
    }
  }

  get(name: string): AgentDef | undefined {
    return this.defs.get(name);
  }

  list(): AgentDef[] {
    return [...this.defs.values()];
  }
}

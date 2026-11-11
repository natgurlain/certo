// Small Node-only helpers shared by the panel scripts (no dependencies).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function repoPath(...parts: string[]): string {
  return resolve(REPO_ROOT, ...parts);
}

/** Repository-relative path with forward slashes (what goes into committed JSON). */
export function repoRel(abs: string): string {
  return relative(REPO_ROOT, abs).split("\\").join("/");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function utcDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function readJsonl<T = any>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch (e) {
        throw new Error(`${repoRel(path)}:${i + 1}: invalid JSON (${(e as Error).message})`);
      }
    });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

/** Model id → file-name stem (`Qwen/Qwen3.8-27B` → `Qwen__Qwen3.8-27B`). */
export function modelSlug(model: string): string {
  return model.replace(/\//g, "__");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse `--flag`, `--key value` and `--key=value` arguments. Positional args go to `_`. */
export function parseArgs(argv = process.argv.slice(2)): { _: string[]; [k: string]: string | boolean | string[] } {
  const out: { _: string[]; [k: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

/** Fixed-width text table for terminal output. */
export function table(head: string[], rows: (string | number)[][]): string {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, c) => Math.max(...cells.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]) => r.map((v, c) => (v ?? "").padEnd(w[c])).join("  ").trimEnd();
  return [line(cells[0]), w.map((n) => "-".repeat(n)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

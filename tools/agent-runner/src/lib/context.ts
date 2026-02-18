import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunnerContext } from "./types.js";

async function safeRead(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function walkRepo(dir: string, depth = 0, maxDepth = 3): Promise<string[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(".", fullPath);
    lines.push(relPath + (entry.isDirectory() ? "/" : ""));

    if (entry.isDirectory()) {
      lines.push(...(await walkRepo(fullPath, depth + 1, maxDepth)));
    }
  }

  return lines;
}

export async function loadRunnerContext(): Promise<RunnerContext> {
  const [vision, status, tree] = await Promise.all([
    safeRead("VISION.md"),
    safeRead("STATUS.md"),
    walkRepo("."),
  ]);

  return { vision, status, tree };
}

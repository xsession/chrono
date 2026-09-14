// Workspace persistence: load/save the remembered repositories list.
//
// Ported from `src-tauri/src/workspace.rs`. Tauri's `app_config_dir` becomes
// the process environment (CHRONO_CONFIG_DIR) or a per-OS default under the
// user profile, so the same file layout keeps working in the web server.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "./lib/errors.ts";

export interface WorkspaceRepository {
  path: string;
  alias?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  repositories: WorkspaceRepository[];
}

export function workspacesFile(): string {
  const override = process.env.CHRONO_CONFIG_DIR;
  const directory = override
    ? path.resolve(override)
    : path.join(os.homedir(), ".chrono-next");
  return path.join(directory, "workspaces.json");
}

export async function loadWorkspaces(): Promise<Workspace[]> {
  const file = workspacesFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AppError("io", `failed to read workspaces: ${(error as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Workspace[]) : [];
  } catch (error) {
    throw new AppError("json", `workspaces.json is not valid JSON: ${(error as Error).message}`);
  }
}

export async function saveWorkspaces(workspaces: Workspace[]): Promise<void> {
  const file = workspacesFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(workspaces, null, 2));
  await fs.rename(temporary, file);
}

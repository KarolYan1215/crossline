import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MINE_PLUGIN, currentMineVersion, mineSkillDirName, mineSkillName, mineSkillSettingKey, readMineSkill } from "@crossline/core";
import { installLibraryPlugin, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { linePacks } from "./lines";
import { runtimesDir } from "./owner";

/**
 * The person's skill library on disk (docs/skills-library.md): a local marketplace holding the runtime's second and third plugins,
 * `crossline-mine` (one skill per line, the person's own) and, from S2, `crossline-public`. The ledger is the source of truth — these
 * files are derived from it on every install and live beside the Codex homes, outside the backed-up data folder.
 */
export const LIBRARY_MARKETPLACE = "crossline-library";

export function skillLibraryDir(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(runtimesDir(env)), "skill-library", workspaceId);
}
export const libraryMarketplacePath = (dir: string) => path.join(dir, ".agents", "plugins", "marketplace.json");

type PluginFiles = { name: string; displayName: string; description: string; skills: Map<string, Map<string, string>> };

/** Every line's skill in force, as `<dir>/SKILL.md`. Archived lines keep theirs: the system never deletes a line skill. */
function minePlugin(store: CrosslineStore, workspaceId: string): PluginFiles {
  const skills = new Map<string, Map<string, string>>();
  for (const line of linePacks(store, workspaceId, { includeArchived: true }).filter((pack) => pack.kind === "identity")) {
    const version = currentMineVersion(readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(line.id))));
    if (version) skills.set(mineSkillDirName(line.id), new Map([["SKILL.md", version.markdown]]));
  }
  return { name: MINE_PLUGIN, displayName: "本人的主线 skill", description: "How this person does each line's work: plays, preferences and red lines.", skills };
}

/** Writes one plugin's directory to match `plugin`, removing skill folders it no longer has. */
function writePlugin(dir: string, plugin: PluginFiles): void {
  const root = path.join(dir, "plugins", plugin.name);
  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin.name, version: "0.1.0", description: plugin.description,
    author: { name: "Crossline" }, skills: "./skills/", interface: { displayName: plugin.displayName, category: "Productivity" } }, null, 2), "utf8");
  const skillsDir = path.join(root, "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const entry of readdirSync(skillsDir)) if (!plugin.skills.has(entry)) rmSync(path.join(skillsDir, entry), { recursive: true, force: true });
  for (const [name, files] of plugin.skills) {
    for (const [relative, content] of files) {
      const target = path.join(skillsDir, name, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
  }
}

/** Writes the library for a workspace and returns what it holds, with a hash that changes whenever any file does. */
export function writeSkillLibrary(store: CrosslineStore, workspaceId: string, dir = skillLibraryDir(workspaceId)):
  { dir: string; hash: string; plugins: Array<{ name: string; skills: string[] }> } {
  const plugins = [minePlugin(store, workspaceId)].filter((plugin) => plugin.skills.size > 0);
  mkdirSync(path.dirname(libraryMarketplacePath(dir)), { recursive: true });
  writeFileSync(libraryMarketplacePath(dir), JSON.stringify({ name: LIBRARY_MARKETPLACE, interface: { displayName: "Crossline Library" },
    plugins: plugins.map((plugin) => ({ name: plugin.name, source: { source: "local", path: `./plugins/${plugin.name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" })) }, null, 2), "utf8");
  const hash = createHash("sha256");
  for (const plugin of plugins) {
    writePlugin(dir, plugin);
    for (const [name, files] of [...plugin.skills].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [relative, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(`${plugin.name}/${name}/${relative}\0${content}\0`);
    }
  }
  return { dir, hash: hash.digest("hex"), plugins: plugins.map((plugin) => ({ name: plugin.name, skills: [...plugin.skills.keys()].map((skill) => `${plugin.name}:${skill}`) })) };
}

/** What each runtime last installed, per workspace: an install is a plugin copy and a config write, so it happens only when the files changed. */
const installed = new WeakMap<object, Map<string, string>>();

/**
 * Brings the runtime's copy of the library up to date with the ledger. Never throws: a library that cannot be installed leaves the run
 * as it was before the library existed, and says so in the log.
 */
export async function ensureSkillLibrary(client: CodexRpcBoundary, store: CrosslineStore, workspaceId: string,
  options: { dir?: string; cwd: string }): Promise<string[]> {
  try {
    const library = writeSkillLibrary(store, workspaceId, options.dir ?? skillLibraryDir(workspaceId));
    const seen = installed.get(client) ?? new Map<string, string>();
    installed.set(client, seen);
    if (seen.get(workspaceId) !== library.hash) {
      for (const plugin of library.plugins) await installLibraryPlugin(client, { marketplacePath: libraryMarketplacePath(library.dir), name: plugin.name, cwd: options.cwd });
      seen.set(workspaceId, library.hash);
    }
    return library.plugins.flatMap((plugin) => plugin.skills);
  } catch (error) {
    console.warn(JSON.stringify({ type: "skill_library.install_failed", workspaceId, code: error instanceof Error ? error.message : "" }));
    return [];
  }
}

/** Added to a run's instructions when it has the line's own skill on: whose rules win when they meet a generic convention. */
export const MINE_SKILL_INSTRUCTION = " The crossline-mine skill named in the prompt is the person's own way of doing this line's work: read it first "
  + "and follow its plays and preferences over generic conventions, a platform's usual style or another skill's defaults; only its red lines are "
  + "hard limits. Check the result against each of its rules before finishing.";

/**
 * The library skills a run on this line switches on beside its own Skill: the line's own skill when it has one. Installs first, so a
 * rewrite made since the last run is the copy the run reads.
 */
export async function librarySkillsFor(client: CodexRpcBoundary, store: CrosslineStore, workspaceId: string, lineId: string | undefined,
  options: { dir?: string; cwd: string }): Promise<string[]> {
  // A line with no skill of its own runs exactly as before: nothing is written or installed for it.
  if (!lineId || !currentMineVersion(readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(lineId))))) return [];
  const available = await ensureSkillLibrary(client, store, workspaceId, options);
  const mine = mineSkillName(lineId);
  return available.includes(mine) ? [mine] : [];
}

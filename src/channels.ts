// Channels on the hub side: the files (channels/<slug>.md), what agents are told, and what their results assign.
import { existsSync, readFileSync } from "node:fs";
import { P, list, now, readDoc, writeDoc } from "./core";
import { CHANNEL_SLUG, type ChannelRow, parseChannel, slugify } from "../cloud/src/tools";

export type ChannelPick = string | { name: string; goal?: string };

export function channels(): ChannelRow[] {
  return list(P("channels")).map((f) => parseChannel(`channels/${f.split(/[\\/]/).pop()}`, readFileSync(f, "utf8"))).filter((c): c is ChannelRow => !!c);
}

const file = (slug: string) => P("channels", `${slug}.md`);

export function createChannel(name: string, goal = ""): ChannelRow {
  const slug = slugify(name.trim());
  if (!existsSync(file(slug))) writeDoc(file(slug), { name: name.trim(), goal: goal.trim(), status: "active", created: now() }, "");
  return parseChannel(`channels/${slug}.md`, readFileSync(file(slug), "utf8"))!;
}

/** The owner's edits: a new goal, archive / unarchive. */
export function updateChannel(slug: string, patch: { goal?: unknown; archived?: unknown; name?: unknown }): ChannelRow | string {
  if (!CHANNEL_SLUG.test(slug) || !existsSync(file(slug))) return `channel ${slug} not found`;
  const { meta, body } = readDoc(file(slug));
  if (typeof patch.goal === "string") meta.goal = patch.goal.trim().slice(0, 500);
  if (typeof patch.name === "string" && patch.name.trim()) meta.name = patch.name.trim().slice(0, 60);
  if (typeof patch.archived === "boolean") { meta.status = patch.archived ? "archived" : "active"; if (patch.archived) meta.archived = now(); else delete meta.archived; }
  writeDoc(file(slug), meta, body);
  return parseChannel(`channels/${slug}.md`, readFileSync(file(slug), "utf8"))!;
}

/** What the agent picked → slugs on the task. Existing active channels by slug or name; an object (or an unknown name
 *  with a goal) opens a new one; archived channels never get new items. */
export function resolveChannels(picks: unknown): string[] {
  if (!Array.isArray(picks)) return [];
  const all = channels();
  const out = new Set<string>();
  for (const p of picks.slice(0, 4)) {
    const name = typeof p === "string" ? p : p && typeof p === "object" && typeof (p as any).name === "string" ? (p as any).name : "";
    if (!name.trim()) continue;
    const hit = all.find((c) => c.slug === name.trim() || c.slug === slugify(name) || c.name.toLowerCase() === name.trim().toLowerCase());
    if (hit) { if (hit.status === "active") out.add(hit.slug); continue; }
    const goal = typeof p === "object" ? String((p as any).goal ?? "") : "";
    if (!goal.trim()) continue; // a new channel needs its goal, so a typo doesn't open one
    out.add(createChannel(name, goal).slug);
  }
  return [...out];
}

/** The prompt section: the active channels and how to pick. */
export function channelPrompt(): string {
  const act = channels().filter((c) => c.status === "active");
  const lines = act.map((c) => `- \`${c.slug}\` ${c.name}: ${c.goal}`).join("\n");
  return `# Channels (work topics the owner can drill into)
${lines || "(none yet)"}
In the result JSON, set "channels" to the topics this task's work belongs to: existing slugs from the list, or {"name": "...", "goal": "one sentence: what this channel is for"} to open a new one when no goal fits. A channel is a topic like a team in a company (e.g. "NSH i18n", "Omamail", "GPUI Kit releases"), not one per repo. Zero to three; [] for fleet-internal chores. When a run covers several projects (PR review, CI sweeps), write the summary as one short line per project, each starting with the project name, so nothing is buried.`;
}

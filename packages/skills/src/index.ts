import fs from 'node:fs/promises';
import path from 'node:path';
import type { SkillInfo } from '@deepseek-ide/shared';

export interface LoadedSkill extends SkillInfo {
  body: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) {
    return { meta: {}, body: raw.trim() };
  }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw.trim() };
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const meta: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body };
}

async function loadSkillsFromRoot(
  root: string,
  source: SkillInfo['source'],
): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(root, entry.name, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillPath, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      skills.push({
        name: meta.name || entry.name,
        description: meta.description || '',
        source,
        path: skillPath,
        body,
      });
    } catch {
      // skip
    }
  }
  return skills;
}

export async function discoverSkills(options: {
  workspaceRoot?: string | null;
  userSkillsDir?: string | null;
}): Promise<LoadedSkill[]> {
  const found: LoadedSkill[] = [];
  if (options.workspaceRoot) {
    for (const rel of ['.cursor/skills', '.deepseek/skills']) {
      found.push(...(await loadSkillsFromRoot(path.join(options.workspaceRoot, rel), 'workspace')));
    }
  }
  if (options.userSkillsDir) {
    found.push(...(await loadSkillsFromRoot(options.userSkillsDir, 'user')));
  }
  const byName = new Map<string, LoadedSkill>();
  for (const s of found) {
    const existing = byName.get(s.name);
    if (!existing || (existing.source === 'user' && s.source === 'workspace')) {
      byName.set(s.name, s);
    }
  }
  return [...byName.values()];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((t) => t.length > 1);
}

export function selectSkillsForPrompt(
  skills: LoadedSkill[],
  prompt: string,
  max = 3,
): LoadedSkill[] {
  if (!skills.length) return [];
  const promptTokens = new Set(tokenize(prompt));
  const scored = skills.map((skill) => {
    const hay = `${skill.name} ${skill.description}`.toLowerCase();
    let score = 0;
    for (const t of promptTokens) {
      if (hay.includes(t)) score += t.length > 3 ? 2 : 1;
    }
    if (skill.description && prompt.toLowerCase().includes(skill.name.toLowerCase())) {
      score += 5;
    }
    return { skill, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored
    .filter((s) => s.score > 0)
    .slice(0, max)
    .map((s) => s.skill);
  if (picked.length) return picked;
  return skills.slice(0, Math.min(1, max));
}

export function formatSkillsForPrompt(skills: LoadedSkill[]): string {
  if (!skills.length) return '';
  return skills
    .map(
      (s) =>
        `### Skill: ${s.name}\n${s.description ? `Description: ${s.description}\n` : ''}${s.body}`,
    )
    .join('\n\n');
}

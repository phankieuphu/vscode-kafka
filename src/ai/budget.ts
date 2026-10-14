/** One titled block of context. Lower `priority` is trimmed first. */
export interface ContextSection {
  title: string;
  text: string;
  priority: number;
  /** The same data as rows, for the chat panel to show next to the answer. Never sent to the model. */
  table?: ContextTable;
}

export interface ContextTable {
  columns: string[];
  rows: string[][];
}

export type TokenCounter = (text: string) => Thenable<number> | number;

export interface BudgetResult {
  text: string;
  tokens: number;
  /** Titles of sections left out entirely. */
  dropped: string[];
  /** Titles of sections cut short. */
  truncated: string[];
}

const TRUNCATED = "\n… [truncated]";
/** Below this much room a section is dropped rather than cut to a stub. */
const MIN_SECTION_TOKENS = 24;

/** Rough count (~4 characters a token) for when no model is at hand. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function render(section: ContextSection): string {
  return `## ${section.title}\n${section.text}\n\n`;
}

/**
 * Joins `sections` (in their given order) into at most `budget` tokens,
 * as counted by `count` (e.g. `model.countTokens`). Over budget, the
 * lowest-priority section is cut to fit or, if too little room is left,
 * dropped; then the next lowest, and so on.
 */
export async function fitToBudget(
  sections: ContextSection[],
  budget: number,
  count: TokenCounter,
): Promise<BudgetResult> {
  const kept = await Promise.all(
    sections.map(async (section, index) => ({ section, index, tokens: await count(render(section)) })),
  );
  const dropped: string[] = [];
  const truncated = new Set<string>();
  // Per-section counts don't add up exactly to the whole; shrink the target until the joined text fits.
  let target = budget;
  for (let attempt = 0; attempt < 5; attempt++) {
    let total = kept.reduce((sum, k) => sum + k.tokens, 0);
    while (total > target && kept.length > 0) {
      // Lowest priority first; among equals, the later section.
      const victim = kept.reduce((a, b) =>
        b.section.priority < a.section.priority ||
        (b.section.priority === a.section.priority && b.index > a.index)
          ? b
          : a,
      );
      const room = target - (total - victim.tokens);
      const cut = room >= MIN_SECTION_TOKENS ? await shorten(victim.section, victim.tokens, room, count) : undefined;
      if (cut) {
        total += cut.tokens - victim.tokens;
        victim.section = cut.section;
        victim.tokens = cut.tokens;
        truncated.add(victim.section.title);
      } else {
        kept.splice(kept.indexOf(victim), 1);
        dropped.push(victim.section.title);
        truncated.delete(victim.section.title);
        total -= victim.tokens;
      }
    }
    const text = kept.map((k) => render(k.section)).join("").trimEnd();
    const tokens = text ? await count(text) : 0;
    if (tokens <= budget) {
      return { text, tokens, dropped, truncated: [...truncated] };
    }
    target -= tokens - budget;
  }
  return { text: "", tokens: 0, dropped: [...dropped, ...kept.map((k) => k.section.title)], truncated: [] };
}

/** `section` cut to fit `room` tokens, or undefined if nothing useful fits. */
async function shorten(
  section: ContextSection,
  tokens: number,
  room: number,
  count: TokenCounter,
): Promise<{ section: ContextSection; tokens: number } | undefined> {
  // Start from the proportional length, then back off until it fits.
  let length = Math.floor((section.text.length * room) / tokens);
  for (let i = 0; i < 8 && length > 0; i++) {
    const candidate = { ...section, text: section.text.slice(0, length) + TRUNCATED };
    const n = await count(render(candidate));
    if (n <= room) {
      return { section: candidate, tokens: n };
    }
    length = Math.floor(length * Math.min(0.9, room / n));
  }
  return undefined;
}

import * as crypto from "crypto";

export const TEMPLATE_VARIABLES = ["uuid", "now", "nowMs", "random.int", "seq"] as const;

export interface TemplateContext {
  /** 1 for the first message of a send, then 2, 3, … */
  seq: number;
  now?: Date;
  random?: () => number;
  uuid?: () => string;
}

/**
 * Replaces `{{uuid}}`, `{{now}}` (ISO time), `{{nowMs}}`, `{{random.int}}`
 * (0 to 2^31-1) and `{{seq}}`. Unknown variables are left as written so a
 * typo is visible in the sent message rather than silently dropped.
 */
export function expandTemplate(text: string, context: TemplateContext): string {
  const now = context.now ?? new Date();
  const random = context.random ?? Math.random;
  const uuid = context.uuid ?? (() => crypto.randomUUID());
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    switch (name) {
      case "uuid":
        return uuid();
      case "now":
        return now.toISOString();
      case "nowMs":
        return String(now.getTime());
      case "random.int":
        return String(Math.floor(random() * 2 ** 31));
      case "seq":
        return String(context.seq);
      default:
        return match;
    }
  });
}

export function hasTemplateVariables(text: string): boolean {
  return /\{\{\s*[\w.]+\s*\}\}/.test(text);
}

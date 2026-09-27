import * as crypto from "crypto";

export function createNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

export function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function scriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const svg = (body: string, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${body}</svg>`;

export const icons = {
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M12 2v3h-3"/>'),
  warning: svg('<path d="M8 1.8 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.5v.3"/>', 18),
  error: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.8M8 10.8v.4"/>', 18),
  check: svg('<circle cx="8" cy="8" r="6"/><path d="m5.5 8 1.8 1.8L10.8 6.3"/>', 18),
  plug: svg('<path d="M6 10 3.5 12.5M10 6l2.5-2.5M4.5 8.5l3 3-1 1a2.1 2.1 0 0 1-3-3zM11.5 7.5l-3-3 1-1a2.1 2.1 0 0 1 3 3z"/>', 40),
  clock: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>', 13),
  copy: svg('<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M11 5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"/>', 15),
  resend: svg('<path d="M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3"/><path d="M12 2v3H9M4 14v-3h3"/>', 15),
  edit: svg('<path d="M10.5 2.5l3 3L6 13H3v-3z"/>', 13),
  close: svg('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>'),
  pause: '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>',
  play: '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3v10l8-5z"/></svg>',
  tick: svg('<path d="m3.5 8 3 3 6-6"/>', 13),
};

export const baseCss = /* css */ `
  :root {
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --bar: var(--vscode-charts-blue);
    --track: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    --good: var(--vscode-charts-green);
    --warn: var(--vscode-charts-yellow);
    --crit: var(--vscode-charts-red);
    --mono: var(--vscode-editor-font-family, Menlo, Consolas, monospace);
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0 20px 24px; }
  [hidden] { display: none !important; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .muted, .sub { color: var(--muted); }
  .sub { font-size: 12px; overflow-wrap: anywhere; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  header.page { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; justify-content: space-between; padding: 16px 0 12px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
  header.page .title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 13px; font-weight: 600; margin: 0; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--muted); }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  button { font: inherit; height: 26px; padding: 0 12px; border: none; border-radius: 2px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder, var(--crit)); }
  button.danger:hover { background: color-mix(in srgb, var(--crit) 12%, transparent); }
  button.icon { background: transparent; color: var(--vscode-foreground); width: 26px; padding: 0; justify-content: center; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.small { height: 24px; padding: 0 10px; font-size: 12px; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  select, input[type=text], input[type=search], input[type=number], input[type=datetime-local], textarea {
    font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 2px; padding: 0 8px; height: 26px; }
  select { padding: 0 4px; }
  textarea { height: auto; padding: 6px 8px; resize: vertical; font-family: var(--mono); font-size: 12px; line-height: 1.5; }
  input.mono { font-family: var(--mono); font-size: 12px; }
  label.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  label.inline { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }

  .seg { display: inline-flex; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; overflow: hidden; }
  .seg button { background: transparent; color: var(--vscode-foreground); border-radius: 0; }
  .seg button + button { border-left: 1px solid var(--vscode-input-border, var(--border)); }
  .seg button[aria-pressed=true], .seg button[aria-selected=true] { background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background)); color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground)); }

  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--muted); }
  .dot.good { background: var(--good); } .dot.warn { background: var(--warn); } .dot.crit { background: var(--crit); }
  .dot.idle { background: transparent; border: 1px solid var(--muted); }
  .health { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .lvl-crit { color: var(--crit); font-weight: 600; } .lvl-warn { color: var(--warn); font-weight: 600; }

  .card { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; min-width: 0; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; min-height: 28px; margin-bottom: 6px; }
  .count { color: var(--muted); font-weight: 400; margin-left: 4px; }
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
  .tile { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; }
  .tile .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .tile .value { font-size: 22px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .tile .hint { font-size: 11px; color: var(--muted); margin-top: 2px; display: flex; align-items: center; gap: 5px; min-height: 1.3em; }

  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; user-select: none; }
  th.sortable { cursor: pointer; } th.sortable:hover { color: var(--vscode-foreground); }
  th .arrow { font-size: 10px; margin-left: 3px; }
  td.name { max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  td.truncate { max-width: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; }
  tr.link { cursor: pointer; }
  tr.link:hover td, tr.hover td { background: var(--vscode-list-hoverBackground); }
  tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  tr.row-crit td { background: color-mix(in srgb, var(--crit) 10%, transparent); }
  .barcell { width: 28%; min-width: 90px; }
  .bar { height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--bar); border-radius: 3px; min-width: 2px; }
  .bar.zero > span { display: none; }

  .banner { display: flex; gap: 12px; align-items: flex-start; padding: 10px 14px; border-radius: 4px; background: var(--card); border: 1px solid var(--border); }
  .banner .icon-good { color: var(--good); } .banner .icon-warn { color: var(--warn); } .banner .icon-crit { color: var(--crit); }
  .banner .body { flex-grow: 1; display: flex; flex-direction: column; gap: 4px; }
  .banner .issues { display: flex; gap: 4px 24px; flex-wrap: wrap; font-size: 12px; }
  .alert { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 4px; font-size: 12px; line-height: 1.5; }
  .alert.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .alert.warn { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .alert .body { flex-grow: 1; display: flex; flex-direction: column; gap: 4px; }
  .alert.error svg { color: var(--vscode-errorForeground); } .alert.warn svg { color: var(--vscode-editorWarning-foreground, var(--warn)); }

  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 72px 16px; color: var(--muted); }
  .empty-state .title { font-size: 16px; font-weight: 600; color: var(--vscode-foreground); }
  .empty-state p { margin: 0; max-width: 380px; line-height: 1.5; }
  .empty { color: var(--muted); font-size: 12px; padding: 16px 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 8px; }

  .progress { height: 2px; background: transparent; position: relative; overflow: hidden; }
  .progress.active::after { content: ""; position: absolute; left: -30%; width: 30%; height: 2px; background: var(--vscode-progressBar-background); animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { to { left: 100%; } }
  .sk { background: var(--track); border-radius: 3px; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .5; } }
  .stale { opacity: .55; transition: opacity .15s; }
  #status { color: var(--muted); font-size: 12px; min-height: 1.2em; display: flex; align-items: center; gap: 6px; }
  #status.error { color: var(--vscode-errorForeground); }
  @media (prefers-reduced-motion: reduce) { .sk, .progress.active::after { animation: none; } }
`;

export const sharedScript = /* js */ `
    const $ = (id) => document.getElementById(id);
    function esc(text) {
      const div = document.createElement('div');
      div.textContent = text == null ? '' : String(text);
      return div.innerHTML;
    }
    const fmt = new Intl.NumberFormat();
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    const big = (s) => { try { return BigInt(s); } catch { return 0n; } };
    const fmtBig = (s) => fmt.format(big(s));
    const cmpBig = (a, b) => { const x = big(a), y = big(b); return x < y ? -1 : x > y ? 1 : 0; };
    const maxBig = (values) => values.reduce((m, v) => (big(v) > m ? big(v) : m), 0n);
    function bar(value, max, label) {
      const pct = max > 0n ? Number((big(value) * 1000n) / max) / 10 : 0;
      return '<div class="bar' + (big(value) === 0n ? ' zero' : '') + '" title="' + esc(label) + '"><span style="width:' + pct + '%"></span></div>';
    }
    const dot = (level) => '<span class="dot ' + level + '"></span>';
    const badge = (level, text) => '<span class="health">' + dot(level) + esc(text) + '</span>';
    function sortHeader(cols, sort, table) {
      return '<thead><tr>' + cols.map((c) => {
        const active = c.key && sort && sort.key === c.key;
        const cls = [c.num ? 'num' : '', c.key ? 'sortable' : ''].join(' ').trim();
        const arrow = active ? '<span class="arrow">' + (sort.dir > 0 ? '▲' : '▼') + '</span>' : '';
        const aria = active ? ' aria-sort="' + (sort.dir > 0 ? 'ascending' : 'descending') + '"' : '';
        const data = c.key ? ' data-table="' + table + '" data-key="' + c.key + '" tabindex="0"' : '';
        return '<th class="' + cls + '"' + aria + data + '>' + esc(c.label) + arrow + '</th>';
      }).join('') + '</tr></thead>';
    }
`;

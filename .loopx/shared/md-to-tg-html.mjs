#!/usr/bin/env node
// Markdown → Telegram-HTML converter for Claude Code output.
// Not a full CommonMark parser; covers the subset Claude typically emits.
// Telegram-supported tags: b, i, u, s, code, pre, a, blockquote, tg-spoiler.
// Headings and lists aren't supported natively, so # → bold and - → •.

import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8");

const placeholders = [];
const ph = (s) => {
  const token = `\x00${placeholders.length}\x00`;
  placeholders.push(s);
  return token;
};

const escHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

let md = input;

// Extract fenced code blocks first so inner content is not touched by other rules.
md = md.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_m, lang, code) => {
  const body = escHtml(code.replace(/\r?\n$/, ""));
  const langAttr = lang ? ` class="language-${lang}"` : "";
  return ph(`<pre><code${langAttr}>${body}</code></pre>`);
});

// Inline code.
md = md.replace(/`([^`\n]+)`/g, (_m, code) => ph(`<code>${escHtml(code)}</code>`));

// Escape the remaining document; from here on we emit tags directly.
md = escHtml(md);

// Links [text](url).
md = md.replace(
  /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
  (_m, text, url) => `<a href="${escAttr(url)}">${text}</a>`,
);

// Bold: **text** or __text__.
md = md.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
md = md.replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, "$1<b>$2</b>");

// Italic: *text* / _text_ (avoid list markers and intra-word underscores).
md = md.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>");
md = md.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>");

// Headings → bold (Telegram has no heading tag).
md = md.replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "<b>$1</b>");

// Bullet list markers → •.
md = md.replace(/^(\s*)[-*+]\s+/gm, "$1• ");

// Horizontal rules.
md = md.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "────────");

// Blockquotes: wrap consecutive `> ` lines in a single <blockquote>.
// (Escape pass has turned `>` into `&gt;`, so that's what we match.)
md = md.replace(/(?:^&gt;\s?.*(?:\n|$))+/gm, (block) => {
  const body = block
    .replace(/^&gt;\s?/gm, "")
    .replace(/\n$/, "");
  return `<blockquote>${body}</blockquote>\n`;
});

// Restore extracted code spans.
md = md.replace(/\x00(\d+)\x00/g, (_m, i) => placeholders[Number(i)]);

process.stdout.write(md);

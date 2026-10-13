/**
 * Bionic reading POC — display-only.
 *
 * Bolds the leading part of each word in assistant replies (and thinking) in the
 * interactive transcript. Session history and model context are untouched.
 *
 * Usage: /bionic [on|off]   (no arg toggles)
 */
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Spans left untouched: inline code, link targets, autolinks/HTML, URLs,
// existing emphasis, and path/identifier-like tokens.
const PROTECTED = new RegExp(
	[
		"(`+)[\\s\\S]*?\\1", // inline code
		"\\]\\([^)]*\\)", // link target
		"<[^>\\n]+>", // autolink / html
		"https?://\\S+", // bare URL
		"\\*\\*[^*\\n]+\\*\\*", // bold
		"__[^_\\n]+__",
		"\\*[^*\\s][^*\\n]*\\*", // italic
		"\\b_[^_\\n]+_\\b",
		"[^\\s()\\[\\]`]*[/\\\\_.@#$:][^\\s()\\[\\]`]*\\w", // paths, snake_case, a.b, emails, refs
	].join("|"),
	"g",
);

const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function boldLength(len: number): number {
	if (len <= 3) return 1;
	return Math.ceil(len / 2);
}

function bionicWord(word: string): string {
	if (word.length < 2 || CJK.test(word)) return word;
	const n = boldLength(word.length);
	return `**${word.slice(0, n)}**${word.slice(n)}`;
}

function bionicPlain(text: string): string {
	return text.replace(WORD, bionicWord);
}

function bionicLine(line: string): string {
	let out = "";
	let last = 0;
	for (const m of line.matchAll(PROTECTED)) {
		out += bionicPlain(line.slice(last, m.index)) + m[0];
		last = m.index! + m[0].length;
	}
	return out + bionicPlain(line.slice(last));
}

export function bionic(markdown: string): string {
	const lines = markdown.split("\n");
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const f = /^\s*(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fence) fence = f[1][0];
			else if (f[1][0] === fence) fence = undefined;
			continue;
		}
		if (fence) continue; // inside code block (also handles unclosed fences while streaming)
		if (/^\s*#{1,6}\s/.test(line)) continue; // headings are already bold
		if (/^ {4,}|^\t/.test(line) && (i === 0 || lines[i - 1].trim() === "")) continue; // indented code
		if (/^\s*\[[^\]]+\]:\s/.test(line)) continue; // link reference definitions
		lines[i] = bionicLine(line);
	}
	return lines.join("\n");
}

/** Force the transcript to re-render by re-applying the current theme (Markdown output is cached). */
function repaint(ctx: ExtensionContext): boolean {
	let setting: unknown;
	try {
		setting = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).theme;
	} catch {}
	const name = ctx.ui.theme?.name;
	// Only re-apply when the setting is a plain theme name, so we never overwrite an auto/system setting.
	if (typeof setting !== "string" || !name || setting !== name) return false;
	return ctx.ui.setTheme(name).success;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (!enabled || messageType === "user") return markdown;
		return bionic(markdown);
	});

	pi.registerCommand("bionic", {
		description: "Toggle bionic reading for assistant messages (usage: /bionic [on|off])",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			ctx.ui.setStatus("bionic", enabled ? "bionic" : undefined);
			const repainted = repaint(ctx);
			ctx.ui.notify(
				`Bionic reading ${enabled ? "on" : "off"}${repainted ? "" : " (applies to new messages)"}`,
				"info",
			);
		},
	});
}

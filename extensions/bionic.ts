/**
 * Bionic reading POC — display-only.
 *
 * Bolds the leading part of each word in assistant replies (and thinking) in the
 * interactive transcript. Session history and model context are untouched.
 *
 * Usage: /bionic [on|off]   (no arg toggles)
 */
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

// Spans left untouched: inline code, links, autolinks/HTML, URLs,
// existing emphasis, and path/identifier-like tokens.
const PROTECTED = new RegExp(
	[
		"(`+)[\\s\\S]*?\\1", // inline code
		"!?\\[[^\\]\\n]*\\](?:\\([^)]*\\)|\\[[^\\]\\n]*\\])", // inline and reference links, images
		"<[^>\\n]+>", // autolink / html
		"https?://\\S+", // bare URL
		"\\*\\*[^*\\n]+\\*\\*", // bold
		"__[^_\\n]+__",
		"\\*[^*\\s][^*\\n]*\\*", // italic
		"\\b_[^_\\n]+_\\b",
		"[^\\s()\\[\\]`]*[/\\\\_.@#$:][^\\s()\\[\\]`]*\\w", // paths, snake_case, a.b, emails, refs
		"\\b\\p{L}+\\p{Ll}\\p{Lu}[\\p{L}\\d]*", // camelCase / PascalCase identifiers
	].join("|"),
	"gu",
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

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/;
const INDENTED = /^ {4,}|^\t/;
const THEMATIC_BREAK = /^\s*([-*_]\s*){3,}$/;

const isBlank = (line: string | undefined) => line === undefined || line.trim() === "";

/** CommonMark: a fence closes on the same character, at least as long, with nothing after it. */
function closesFence(openFence: string, fenceMatch: RegExpExecArray | null): boolean {
	if (!fenceMatch) return false;
	const [, marker, rest] = fenceMatch;
	return marker[0] === openFence[0] && marker.length >= openFence.length && !rest.trim();
}

export function bionic(markdown: string): string {
	const lines = markdown.split("\n");
	let openFence: string | undefined; // the opening marker run, e.g. "````"
	let inIndentedCode = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = FENCE.exec(line);
		if (openFence) {
			// Unclosed fences (e.g. while streaming) keep the rest of the message untouched.
			if (closesFence(openFence, fenceMatch)) openFence = undefined;
			continue;
		}
		if (fenceMatch) {
			openFence = fenceMatch[1];
			continue;
		}
		if (INDENTED.test(line) && (inIndentedCode || isBlank(lines[i - 1]))) {
			inIndentedCode = true;
			continue;
		}
		inIndentedCode = false;
		if (isBlank(line)) continue;
		if (/^\s*#{1,6}\s/.test(line)) continue; // headings are already bold
		if (SETEXT_UNDERLINE.test(lines[i + 1] ?? "") && !THEMATIC_BREAK.test(line)) continue; // setext heading
		if (/^\s*\[[^\]]+\]:\s/.test(line)) continue; // link reference definitions
		lines[i] = bionicLine(line);
	}
	return lines.join("\n");
}

/**
 * Force the transcript to re-render by re-applying the current theme (Markdown output is cached).
 * setTheme writes the global setting and turns off automatic switching, so only do it when both the
 * effective (project-over-global) and the global setting already name exactly the active theme.
 */
function repaint(ctx: ExtensionContext): boolean {
	const name = ctx.ui.theme?.name;
	if (!name || name === "system") return false;
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir());
		if (settings.getThemeSetting() !== name || settings.getGlobalSettings().theme !== name) return false;
	} catch {
		return false;
	}
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

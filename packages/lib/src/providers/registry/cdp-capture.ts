import { type Browser, chromium, type Page } from "playwright";
import type { Citation } from "../../text-extraction";
import { reportedWebQueries } from "../config";
import type { ModelConfig, Provider, ProviderOptions, ScrapeResult } from "../types";

// Operational model:
// This provider requires a human to have manually launched a debug Chrome
// (`chrome --remote-debugging-port=9222 --user-data-dir=<persistent-path>`)
// and logged into each target site once, out of band, before this provider
// can do anything. It will fail loudly (not silently) if no debug Chrome is
// reachable at CDP_CAPTURE_URL. This is fundamentally different from every other
// provider in this repo, which are all pure API calls with no such dependency.

const TARGET_URLS: Record<string, string> = {
	// Locale is not controllable via URL for chatgpt, claude, and perplexity.
	// It is account/session-based. Setting CDP_CAPTURE_GL or CDP_CAPTURE_HL
	// has no effect on these targets.
	chatgpt: "https://chatgpt.com",
	claude: "https://claude.ai",
	perplexity: "https://www.perplexity.ai",
	"google-ai-mode": "https://www.google.com/search?udm=50&aep=11&atvm=2",
};

// Connecting over CDP attaches to whatever window the human already has open,
// so its size varies across machines and sessions. Pin the CSS viewport (not
// the OS window) to a fixed desktop size so every site renders its full
// desktop layout — below each site's own responsive breakpoint, the sidebar
// collapses or hides differently, which would silently break the selectors
// below.
const FIXED_VIEWPORT = { width: 1440, height: 900 };

// Each site's left navigation panel (conversation history, "New chat", etc.)
// is real page chrome, not part of the answer — left visible it pads every
// text extraction with nav noise and lets its links leak into citations (see
// the chatgpt.com self-link note below). Hidden via real DOM landmarks
// rather than a screenshot crop so it holds regardless of viewport.
//
// Claude also needs its top bar hidden: unlike ChatGPT (where extraction
// already scopes to <main>, which excludes the header), Claude's header
// (.dframe-header, "Free plan / Upgrade / Share") is absolutely positioned
// *inside* the same <main> as the chat, so scoping to a container can't
// exclude it — only hiding it can.
const SIDEBAR_SELECTORS: Record<string, string> = {
	chatgpt: "#stage-slideover-sidebar",
	claude: 'aside[aria-label="Sidebar"], .dframe-header',
	perplexity: 'nav[aria-label="Main"]',
};

async function hideSidebar(page: Page, model: string): Promise<void> {
	const selector = SIDEBAR_SELECTORS[model];
	if (!selector) return;
	// A real stylesheet rule, not an inline style mutation: these sites
	// re-render their header/nav components mid-conversation (title updates,
	// "Claude finished the response", etc.), and a React re-render silently
	// drops any inline style we set by hand. A CSS rule survives re-renders
	// since it isn't part of the component tree React reconciles.
	await page.addStyleTag({ content: `${selector} { display: none !important; }` }).catch(() => {});
}

const CONSENT_SELECTORS = [
	'button:has-text("Accept all")',
	'button:has-text("Accept All Cookies")',
	'button:has-text("Reject All Cookies")',
	'button:has-text("I agree")',
	'button:has-text("Got it")',
	'button:has-text("Dismiss")',
	'button:has-text("Stay logged out")',
];

async function dismissPopups(page: Page) {
	for (const selector of CONSENT_SELECTORS) {
		try {
			const locator = page.locator(selector).first();
			if (await locator.isVisible({ timeout: 500 })) {
				await locator.click({ timeout: 1000 }).catch(() => {});
			}
		} catch {
			// ignore failures
		}
	}
}

// Ordered by preference, not matched as a single combined selector: a page
// can have more than one element satisfying the union (e.g. ChatGPT ships a
// hidden textarea literally classed "fallbackTextarea" alongside the real
// contenteditable editor), and Playwright's `.first()` picks whichever is
// first in DOM order, not whichever entry looks earliest in this list. Only
// visibility, checked per candidate, can tell the real input from the decoy.
const INPUT_SELECTORS: Record<string, string[]> = {
	chatgpt: ["#prompt-textarea", 'div[contenteditable="true"]', "textarea"],
	claude: ['div[contenteditable="true"]', "textarea", '[role="textbox"]'],
	perplexity: ["textarea", 'div[contenteditable="true"]'],
	"google-ai-mode": ["textarea", 'input[type="text"]'],
};

async function findVisibleInput(page: Page, selectors: string[]) {
	for (const selector of selectors) {
		const candidate = page.locator(selector).first();
		if (await candidate.isVisible({ timeout: 200 }).catch(() => false)) {
			return candidate;
		}
	}
	return null;
}

async function typePrompt(page: Page, model: string, prompt: string) {
	const selectors = INPUT_SELECTORS[model] || ["textarea", 'div[contenteditable="true"]'];
	const deadline = Date.now() + 8000;
	let inputLocator: Awaited<ReturnType<typeof findVisibleInput>> = null;

	while (Date.now() < deadline) {
		inputLocator = await findVisibleInput(page, selectors);
		if (inputLocator) break;
		await page.waitForTimeout(200);
	}

	if (!inputLocator) {
		throw new Error(`Timeout finding a visible input field for ${model}`);
	}

	try {
		await inputLocator.click({ timeout: 2000, force: true });
	} catch {
		await inputLocator
			.evaluate((el) => {
				if (el instanceof HTMLElement) el.focus();
			})
			.catch(() => {});
	}

	await page.keyboard.type(prompt, { delay: 6 });
	await page.keyboard.press("Enter");
}

function isInFlightText(lowerText: string): boolean {
	return (
		lowerText.includes("is responding") ||
		lowerText.includes("want to be notified when claude responds") ||
		lowerText.includes("stop response") ||
		lowerText.includes("thinking") ||
		/is (?:searching|pondering|mulling|musing|sleuthing|generating|analyzing)/i.test(lowerText)
	);
}

function isRateLimitedText(lowerText: string): boolean {
	return (
		lowerText.includes("usage limit reached") ||
		lowerText.includes("you've reached the current usage cap") ||
		lowerText.includes("rate limit") ||
		lowerText.includes("too many requests")
	);
}

// Phase 1: wait until generation has actually started (an in-flight marker
// appears, or the page grows) so phase 2 doesn't measure the pre-send page.
// Returns false if nothing happened for the whole budget — observed live: the
// Enter keypress can silently fail to submit (focus race, a stray keystroke
// swallowed by the site's own JS) and the page just sits on its empty landing
// state. Left unchecked, phase 2 would then "stabilize" on that empty state
// and run() would return it as a normal successful capture.
async function waitForResponseStart(page: Page, maxTicks: number): Promise<boolean> {
	let previousLength = 0;
	for (let i = 0; i < maxTicks; i++) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const text = await page.evaluate(() => document.body.innerText);
		if (isInFlightText(text.toLowerCase()) || text.length > previousLength + 10) return true;
		previousLength = text.length;
	}
	return false;
}

// Phase 2: wait until in-flight markers clear and the answer text has been
// stable for 3 consecutive ticks.
async function waitForResponseStable(page: Page, maxTicks: number): Promise<"stable" | "timeout"> {
	let previousLength = 0;
	let stableCount = 0;
	for (let i = 0; i < maxTicks; i++) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const text = await page.evaluate(() => document.body.innerText);
		const lowerText = text.toLowerCase();

		if (isRateLimitedText(lowerText)) {
			throw new Error("RATE_LIMITED: Detected rate limit or quota message.");
		}

		const textLength = text.length;
		if (!isInFlightText(lowerText) && Math.abs(textLength - previousLength) < 25 && textLength > 50) {
			stableCount++;
			if (stableCount >= 3) return "stable";
		} else {
			stableCount = 0;
		}
		previousLength = textLength;
	}
	return "timeout";
}

async function waitForStabilization(page: Page, model: string): Promise<"stable" | "timeout"> {
	const started = await waitForResponseStart(page, model === "claude" ? 40 : 20);
	if (!started) {
		throw new Error(
			`CDP Capture: prompt appears to have never been submitted for ${model} (no response activity detected after typing and Enter)`,
		);
	}
	return waitForResponseStable(page, model === "claude" ? 60 : 40);
}

async function extractCitations(page: Page): Promise<Citation[]> {
	const extractedLinks = (await page.evaluate(() => {
		const links = Array.from(document.querySelectorAll("a"));
		return links.map((a) => ({ url: a.href, text: a.innerText })).filter((l) => l.url?.startsWith("http"));
	})) as Array<{ url: string; text?: string }>;

	const citations: Citation[] = [];
	let index = 0;
	if (!Array.isArray(extractedLinks)) return [];
	for (const link of extractedLinks) {
		try {
			const urlObj = new URL(link.url);
			if (
				!urlObj.hostname.includes("openai.com") &&
				!urlObj.hostname.includes("chatgpt.com") &&
				!urlObj.hostname.includes("claude.ai") &&
				!urlObj.hostname.includes("anthropic.com") &&
				!urlObj.hostname.includes("perplexity.ai") &&
				// Google has a self-link on every country TLD (google.co.in,
				// google.de, ...), not just google.com.
				!/(^|\.)google\.[a-z.]{2,}$/i.test(urlObj.hostname)
			) {
				citations.push({
					url: link.url,
					domain: urlObj.hostname.replace(/^www\./, ""),
					title: link.text ? link.text.substring(0, 100) : undefined,
					citationIndex: index++,
				});
			}
		} catch {
			// Ignore invalid URLs
		}
	}
	return citations;
}

function buildTargetUrl(model: string): string {
	const targetUrl = TARGET_URLS[model];
	if (!targetUrl) {
		throw new Error(`CDP Capture: unsupported model "${model}". Supported: ${Object.keys(TARGET_URLS).join(", ")}`);
	}
	if (model !== "google-ai-mode") return targetUrl;

	const params: string[] = [];
	if (process.env.CDP_CAPTURE_GL) params.push(`gl=${process.env.CDP_CAPTURE_GL}`);
	if (process.env.CDP_CAPTURE_HL) params.push(`hl=${process.env.CDP_CAPTURE_HL}`);
	return params.length > 0 ? `${targetUrl}&${params.join("&")}` : targetUrl;
}

async function connectToDebugChrome(): Promise<Browser> {
	const cdpUrl = process.env.CDP_CAPTURE_URL ?? "http://127.0.0.1:9222";
	try {
		return await chromium.connectOverCDP(cdpUrl);
	} catch (error) {
		throw new Error(
			`CDP Capture: Failed to connect to CDP at ${cdpUrl}. Make sure Chrome is running with --remote-debugging-port=9222. Error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function getActivePage(browser: Browser): Promise<Page> {
	const contexts = browser.contexts();
	const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
	const pages = context.pages();
	const page = pages.length > 0 ? pages[0] : await context.newPage();
	await page.setViewportSize(FIXED_VIEWPORT).catch(() => {});
	return page;
}

// Google truncates a long AI Overview answer behind a "Show more" button -
// click it (best-effort) before extracting text, or the full answer is
// invisible.
async function expandGoogleAiOverview(page: Page): Promise<void> {
	try {
		const showMoreBtn = page.getByRole("button", { name: /show more/i }).first();
		if (await showMoreBtn.isVisible({ timeout: 2000 })) {
			await showMoreBtn.click({ timeout: 2000 }).catch(() => {});
		}
	} catch {
		// Ignore failure
	}
}

async function extractPageText(page: Page, model: string): Promise<string> {
	const containerSelector = model === "chatgpt" ? "main" : "body";
	return page
		.locator(containerSelector)
		.first()
		.innerText()
		.catch(() => "");
}

export const cdpCapture: Provider = {
	id: "cdp-capture",
	name: "CDP Capture",
	access: "scraped",

	isConfigured() {
		return true;
	},

	validateTarget(config: ModelConfig) {
		if (!TARGET_URLS[config.model]) {
			return `CDP Capture does not support model "${config.model}". Supported: ${Object.keys(TARGET_URLS).join(", ")}`;
		}
		return null;
	},

	async run(model: string, prompt: string, options?: ProviderOptions): Promise<ScrapeResult> {
		const targetUrl = buildTargetUrl(model);
		const browser = await connectToDebugChrome();

		try {
			const page = await getActivePage(browser);
			await page.goto(targetUrl);

			await dismissPopups(page);
			await hideSidebar(page, model);
			await typePrompt(page, model, prompt);

			// Result is intentionally unused - we still extract on a "timeout"
			// (the answer may be genuinely long-running or partially rendered)
			// rather than fail the whole capture outright.
			await waitForStabilization(page, model);

			if (model === "google-ai-mode") {
				await expandGoogleAiOverview(page);
			}

			const textContent = await extractPageText(page, model);
			const citations = await extractCitations(page);

			return {
				textContent,
				rawOutput: { textContent },
				webQueries: reportedWebQueries([], {
					webSearch: options?.webSearch ?? true,
					searchProven: citations.length > 0,
				}),
				citations,
				modelVersion: undefined,
			};
		} finally {
			await browser.close().catch(() => {});
		}
	},
};

import { chromium, type Page, type Browser } from "playwright";
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

const INPUT_SELECTORS: Record<string, string> = {
	chatgpt: '#prompt-textarea, div[contenteditable="true"], textarea',
	claude: 'div[contenteditable="true"], textarea, [role="textbox"]',
	perplexity: 'textarea, div[contenteditable="true"]',
	"google-ai-mode": 'textarea, input[type="text"]',
};

async function typePrompt(page: Page, model: string, prompt: string) {
	const selectors = INPUT_SELECTORS[model] || 'textarea, div[contenteditable="true"]';
	let inputLocator = null;

	// Wait for an input to be visible
	try {
		await Promise.race([
			page.waitForSelector(selectors, { state: "visible", timeout: 8000 }),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for input")), 8000))
		]);

		inputLocator = page.locator(selectors).first();
	} catch (e) {
		throw new Error(`Timeout or error finding input field for ${model}: ${e instanceof Error ? e.message : String(e)}`);
	}

	try {
		await inputLocator.click({ timeout: 2000, force: true });
	} catch {
		await inputLocator.evaluate((el) => {
			if (el instanceof HTMLElement) el.focus();
		}).catch(() => {});
	}

	await page.keyboard.type(prompt, { delay: 6 });
	await page.keyboard.press("Enter");
}

async function waitForStabilization(page: Page, model: string): Promise<string> {
	let previousLength = 0;
	let stableCount = 0;

	const maxTicks = model === "claude" ? 40 : 20;

	// Phase 1: Wait for inFlight text to appear or prompt to be echoed back
	let started = false;
	for (let i = 0; i < maxTicks; i++) {
		await new Promise(resolve => setTimeout(resolve, 1500));

		const text = await page.evaluate(() => document.body.innerText);
		const lowerText = text.toLowerCase();

		const isThinking = lowerText.includes("is responding") ||
			lowerText.includes("want to be notified when claude responds") ||
			lowerText.includes("stop response") ||
			lowerText.includes("thinking") ||
			/is (?:searching|pondering|mulling|musing|sleuthing|generating|analyzing)/i.test(lowerText);

		if (isThinking || text.length > previousLength + 10) {
			started = true;
			break;
		}
		previousLength = text.length;
	}

	if (!started) {
		// Even if not "started" by our heuristic, proceed to phase 2 just in case it was fast
	}

	previousLength = 0;
	stableCount = 0;

	const phase2Ticks = model === "claude" ? 60 : 40;

	for (let i = 0; i < phase2Ticks; i++) {
		await new Promise(resolve => setTimeout(resolve, 1500));

		const text = await page.evaluate(() => document.body.innerText);
		const lowerText = text.toLowerCase();

		// Rate limit detection
		if (
			lowerText.includes("usage limit reached") ||
			lowerText.includes("you've reached the current usage cap") ||
			lowerText.includes("rate limit") ||
			lowerText.includes("too many requests")
		) {
			throw new Error("RATE_LIMITED: Detected rate limit or quota message.");
		}

		const isThinking = lowerText.includes("is responding") ||
			lowerText.includes("want to be notified when claude responds") ||
			lowerText.includes("stop response") ||
			lowerText.includes("thinking") ||
			/is (?:searching|pondering|mulling|musing|sleuthing|generating|analyzing)/i.test(lowerText);

		const textLength = text.length;

		if (!isThinking && Math.abs(textLength - previousLength) < 25 && textLength > 50) {
			stableCount++;
			if (stableCount >= 3) {
				return "stable";
			}
		} else {
			stableCount = 0;
		}
		previousLength = textLength;
	}

	return "timeout";
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
				!urlObj.hostname.includes("claude.ai") &&
				!urlObj.hostname.includes("perplexity.ai") &&
				!urlObj.hostname.includes("google.com")
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
		let targetUrl = TARGET_URLS[model];
		if (!targetUrl) {
			throw new Error(`CDP Capture: unsupported model "${model}". Supported: ${Object.keys(TARGET_URLS).join(", ")}`);
		}

		if (model === "google-ai-mode") {
			if (process.env.CDP_CAPTURE_GL) {
				targetUrl += `&gl=${process.env.CDP_CAPTURE_GL}`;
			}
			if (process.env.CDP_CAPTURE_HL) {
				targetUrl += `&hl=${process.env.CDP_CAPTURE_HL}`;
			}
		}

		let browser: Browser;
		try {
			browser = await chromium.connectOverCDP(process.env.CDP_CAPTURE_URL ?? "http://127.0.0.1:9222");
		} catch (error) {
			throw new Error(
				`CDP Capture: Failed to connect to CDP at ${process.env.CDP_CAPTURE_URL ?? "http://127.0.0.1:9222"}. Make sure Chrome is running with --remote-debugging-port=9222. Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		try {
			const contexts = browser.contexts();
			const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
			const pages = context.pages();
			const page = pages.length > 0 ? pages[0] : await context.newPage();

			await page.goto(targetUrl);

			await dismissPopups(page);
			await typePrompt(page, model, prompt);

			const waitResult = await waitForStabilization(page, model);
			if (waitResult === "timeout") {
				// We still extract even on timeout, it might be partial.
			}

			if (model === "google-ai-mode") {
				try {
					const showMoreBtn = page.getByRole('button', { name: /show more/i }).first();
					if (await showMoreBtn.isVisible({ timeout: 2000 })) {
						await showMoreBtn.click({ timeout: 2000 }).catch(() => {});
					}
				} catch {
					// Ignore failure
				}
			}

			const containerSelector = model === "chatgpt" ? "main" : "body";
			const textContent = await page.locator(containerSelector).first().innerText().catch(() => "");

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

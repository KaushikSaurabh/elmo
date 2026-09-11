import { localBrowser, Stagehand, type StagehandBrowser } from "@browserbasehq/stagehand";
import { z } from "zod";
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

async function waitForStabilization(stagehand: Stagehand): Promise<void> {
	let previousLength = 0;
	let stableCount = 0;

	for (let i = 0; i < 60; i++) {
		await new Promise((resolve) => setTimeout(resolve, 2000));

		const page = await stagehand.browser.context.activePage();
		if (!page) break;

		const isThinking = await page.evaluate(() => {
			const text = document.body.innerText.toLowerCase();
			return text.includes("is responding") || text.includes("thinking") || text.includes("generating");
		});

		const currentText = await page.evaluate(() => document.body.innerText);
		const textLength = typeof currentText === "string" ? currentText.length : 0;

		if (!isThinking && textLength === previousLength && textLength > 0) {
			stableCount++;
			if (stableCount >= 3) {
				break;
			}
		} else {
			stableCount = 0;
		}
		previousLength = textLength;
	}
}

async function extractCitations(stagehand: Stagehand): Promise<Citation[]> {
	const page = await stagehand.browser.context.activePage();
	if (!page) return [];

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

		let browser: StagehandBrowser;
		try {
			browser = await localBrowser.connect({
				cdpUrl: process.env.CDP_CAPTURE_URL ?? "http://127.0.0.1:9222",
			});
		} catch (error) {
			throw new Error(
				`CDP Capture: Failed to connect to CDP at ${process.env.CDP_CAPTURE_URL ?? "http://127.0.0.1:9222"}. Make sure Chrome is running with --remote-debugging-port=9222. Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const stagehand = await Stagehand.create({ browser });

		try {
			const page = await stagehand.browser.context.activePage();
			if (!page) throw new Error("CDP Capture: No active page available.");

			await page.goto(targetUrl);
			await stagehand.act(`type the prompt "${prompt}" into the message box and press enter`);
			await waitForStabilization(stagehand);

			const { data } = await stagehand.extract(
				"extract the main AI response text from the page",
				z.object({ textContent: z.string() }),
			);
			const textContent = data.textContent;

			const citations = await extractCitations(stagehand);

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
			await stagehand.close();
		}
	},
};

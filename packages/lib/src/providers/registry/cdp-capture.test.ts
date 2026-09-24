import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdpCapture } from "./cdp-capture";

vi.mock("playwright", () => {
	const locatorMock = {
		first: vi.fn().mockReturnThis(),
		isVisible: vi.fn().mockResolvedValue(false),
		click: vi.fn().mockResolvedValue(undefined),
		evaluate: vi.fn().mockResolvedValue(undefined),
		innerText: vi.fn().mockResolvedValue("Mock response text"),
	};

	const keyboardMock = {
		type: vi.fn().mockResolvedValue(undefined),
		press: vi.fn().mockResolvedValue(undefined),
	};

	const pageMock = {
		goto: vi.fn().mockResolvedValue(undefined),
		evaluate: vi.fn(),
		locator: vi.fn().mockReturnValue(locatorMock),
		waitForSelector: vi.fn().mockResolvedValue(undefined),
		getByRole: vi.fn().mockReturnValue(locatorMock),
		keyboard: keyboardMock,
		screenshot: vi.fn().mockResolvedValue(Buffer.from("mock-screenshot")),
		setViewportSize: vi.fn().mockResolvedValue(undefined),
		waitForTimeout: vi.fn().mockResolvedValue(undefined),
		addStyleTag: vi.fn().mockResolvedValue(undefined),
	};

	const contextMock = {
		pages: vi.fn().mockReturnValue([pageMock]),
		newPage: vi.fn().mockResolvedValue(pageMock),
	};

	const browserMock = {
		contexts: vi.fn().mockReturnValue([contextMock]),
		newContext: vi.fn().mockResolvedValue(contextMock),
		close: vi.fn().mockResolvedValue(undefined),
	};

	return {
		chromium: {
			connectOverCDP: vi.fn().mockResolvedValue(browserMock),
		},
	};
});

describe("cdpCapture", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("isConfigured returns true", () => {
		expect(cdpCapture.isConfigured()).toBe(true);
	});

	it("validateTarget returns null for supported models", () => {
		expect(cdpCapture.validateTarget?.({ provider: "cdp-capture", model: "chatgpt", webSearch: true })).toBeNull();
		expect(cdpCapture.validateTarget?.({ provider: "cdp-capture", model: "claude", webSearch: true })).toBeNull();
		expect(
			cdpCapture.validateTarget?.({ provider: "cdp-capture", model: "google-ai-mode", webSearch: true }),
		).toBeNull();
		expect(cdpCapture.validateTarget?.({ provider: "cdp-capture", model: "perplexity", webSearch: true })).toBeNull();
	});

	it("validateTarget returns error for unsupported models", () => {
		expect(cdpCapture.validateTarget?.({ provider: "cdp-capture", model: "unknown-model", webSearch: true })).toMatch(
			/CDP Capture does not support model "unknown-model"/,
		);
	});

	it("run calls playwright with correct arguments and resolves successfully", async () => {
		// Mock evaluate specifically for this test's needs
		const mockBrowser = await chromium.connectOverCDP("");
		const mockPage = mockBrowser.contexts()[0].pages()[0];

		let evaluateCallCount = 0;
		// biome-ignore lint/suspicious/noExplicitAny: mock
		(mockPage.evaluate as any).mockImplementation((fn: any) => {
			const fnString = fn.toString();
			if (fnString.includes("querySelectorAll")) {
				return Promise.resolve([
					{ url: "https://example.com", text: "Example Citation" },
					{ url: "https://openai.com", text: "Should be filtered" },
				]);
			}

			// For stabilization, first return empty, then full text to trigger stability
			evaluateCallCount++;
			if (evaluateCallCount < 2) return Promise.resolve("");
			return Promise.resolve("Mock response text. ".repeat(10)); // Long enough to pass length check
		});

		vi.useFakeTimers();
		const runPromise = cdpCapture.run("chatgpt", "What is the meaning of life?", { webSearch: true });

		// Advance timers multiple times to get past both phases of stabilization
		await vi.advanceTimersByTimeAsync(8000); // input wait
		await vi.advanceTimersByTimeAsync(1500 * 20); // phase 1
		await vi.advanceTimersByTimeAsync(1500 * 40); // phase 2

		const result = await runPromise;
		vi.useRealTimers();

		expect(chromium.connectOverCDP).toHaveBeenCalled();
		expect(mockPage.goto).toHaveBeenCalledWith("https://chatgpt.com");

		expect(mockPage.addStyleTag).toHaveBeenCalledWith({
			content: expect.stringContaining("display: none !important;"),
		});

		expect(mockPage.keyboard.type).toHaveBeenCalledWith("What is the meaning of life?", { delay: 6 });
		expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");

		expect(result.textContent).toBe("Mock response text");
		expect(result.citations).toHaveLength(1);
		expect(result.citations[0].url).toBe("https://example.com");
		expect(result.citations[0].domain).toBe("example.com");
		expect(result.screenshot).toEqual(Buffer.from("mock-screenshot"));
		expect(mockPage.screenshot).toHaveBeenCalledWith({ fullPage: true });

		expect(mockBrowser.close).toHaveBeenCalled();
	});

	it("run throws clear error for unsupported model", async () => {
		await expect(cdpCapture.run("unknown", "prompt")).rejects.toThrow(/CDP Capture: unsupported model "unknown"/);
	});

	describe("locale environment variables", () => {
		let originalGl: string | undefined;
		let originalHl: string | undefined;

		beforeEach(() => {
			originalGl = process.env.CDP_CAPTURE_GL;
			originalHl = process.env.CDP_CAPTURE_HL;
		});

		afterEach(() => {
			if (originalGl === undefined) {
				delete process.env.CDP_CAPTURE_GL;
			} else {
				process.env.CDP_CAPTURE_GL = originalGl;
			}
			if (originalHl === undefined) {
				delete process.env.CDP_CAPTURE_HL;
			} else {
				process.env.CDP_CAPTURE_HL = originalHl;
			}
		});

		const setupMock = async () => {
			const mockBrowser = await chromium.connectOverCDP("");
			const mockPage = mockBrowser.contexts()[0].pages()[0];

			// biome-ignore lint/suspicious/noExplicitAny: mock
			(mockPage.evaluate as any).mockImplementation((fn: any) => {
				const fnString = fn.toString();
				if (fnString.includes("querySelectorAll")) return Promise.resolve([]);
				return Promise.resolve("Text ".repeat(20)); // Long enough
			});

			return mockPage;
		};

		it("google-ai-mode gets &gl=IN&hl=en appended when both env vars are set", async () => {
			process.env.CDP_CAPTURE_GL = "IN";
			process.env.CDP_CAPTURE_HL = "en";
			const mockPage = await setupMock();

			vi.useFakeTimers();
			const runPromise = cdpCapture.run("google-ai-mode", "prompt");
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(1500 * 60);
			await runPromise;
			vi.useRealTimers();

			expect(mockPage.goto).toHaveBeenCalledWith("https://www.google.com/search?udm=50&aep=11&atvm=2&gl=IN&hl=en");
		});

		it("google-ai-mode gets only &gl=IN appended when only CDP_CAPTURE_GL is set", async () => {
			process.env.CDP_CAPTURE_GL = "IN";
			delete process.env.CDP_CAPTURE_HL;
			const mockPage = await setupMock();

			vi.useFakeTimers();
			const runPromise = cdpCapture.run("google-ai-mode", "prompt");
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(1500 * 60);
			await runPromise;
			vi.useRealTimers();

			expect(mockPage.goto).toHaveBeenCalledWith("https://www.google.com/search?udm=50&aep=11&atvm=2&gl=IN");
		});

		it("google-ai-mode URL is unmodified when neither is set", async () => {
			delete process.env.CDP_CAPTURE_GL;
			delete process.env.CDP_CAPTURE_HL;
			const mockPage = await setupMock();

			vi.useFakeTimers();
			const runPromise = cdpCapture.run("google-ai-mode", "prompt");
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(1500 * 60);
			await runPromise;
			vi.useRealTimers();

			expect(mockPage.goto).toHaveBeenCalledWith("https://www.google.com/search?udm=50&aep=11&atvm=2");
		});

		it("chatgpt, claude, and perplexity URLs are completely unaffected by CDP_CAPTURE_GL/HL being set", async () => {
			process.env.CDP_CAPTURE_GL = "IN";
			process.env.CDP_CAPTURE_HL = "en";

			for (const model of ["chatgpt", "claude", "perplexity"]) {
				const mockPage = await setupMock();

				vi.useFakeTimers();
				const runPromise = cdpCapture.run(model, "prompt");
				await vi.advanceTimersByTimeAsync(8000);
				await vi.advanceTimersByTimeAsync(1500 * 100);
				await runPromise;
				vi.useRealTimers();

				const expectedUrl = {
					chatgpt: "https://chatgpt.com",
					claude: "https://claude.ai",
					perplexity: "https://www.perplexity.ai",
				}[model as "chatgpt" | "claude" | "perplexity"];

				expect(mockPage.goto).toHaveBeenCalledWith(expectedUrl);
			}
		});
	});

	describe("hideChrome CSS injection", () => {
		const setupMock = async () => {
			const mockBrowser = await chromium.connectOverCDP("");
			const mockPage = mockBrowser.contexts()[0].pages()[0];

			// biome-ignore lint/suspicious/noExplicitAny: mock
			(mockPage.evaluate as any).mockImplementation((fn: any) => {
				const fnString = fn.toString();
				if (fnString.includes("querySelectorAll")) return Promise.resolve([]);
				return Promise.resolve("Text ".repeat(20));
			});

			return mockPage;
		};

		it("injects hide chrome CSS rule for chatgpt", async () => {
			const mockPage = await setupMock();
			vi.useFakeTimers();
			const runPromise = cdpCapture.run("chatgpt", "prompt");
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(1500 * 60);
			await runPromise;
			vi.useRealTimers();

			expect(mockPage.addStyleTag).toHaveBeenCalledWith({
				content: '#stage-slideover-sidebar, header, #stage-header, [data-testid="profile-button"], [aria-label="Profile"] { display: none !important; }',
			});
		});

		it("injects hide chrome CSS rule for claude", async () => {
			const mockPage = await setupMock();
			vi.useFakeTimers();
			const runPromise = cdpCapture.run("claude", "prompt");
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(1500 * 100);
			await runPromise;
			vi.useRealTimers();

			expect(mockPage.addStyleTag).toHaveBeenCalledWith({
				content: 'aside[aria-label="Sidebar"], .dframe-header, header, [aria-label="User menu"], [aria-label="Account menu"] { display: none !important; }',
			});
		});

		it("injects hide chrome CSS rule for perplexity", async () => {
			const mockPage = await setupMock();
			vi.useFakeTimers();
			const runPromise = cdpCapture.run("perplexity", "prompt");
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(1500 * 60);
			await runPromise;
			vi.useRealTimers();

			expect(mockPage.addStyleTag).toHaveBeenCalledWith({
				content: 'nav[aria-label="Main"], header, [aria-label="User menu"], [aria-label="Account settings"] { display: none !important; }',
			});
		});

		it("injects hide chrome CSS rule for google-ai-mode", async () => {
			const mockPage = await setupMock();
			vi.useFakeTimers();
			const runPromise = cdpCapture.run("google-ai-mode", "prompt");
			await vi.advanceTimersByTimeAsync(8000);
			await vi.advanceTimersByTimeAsync(1500 * 60);
			await runPromise;
			vi.useRealTimers();

			expect(mockPage.addStyleTag).toHaveBeenCalledWith({
				content: '#gb, #ogb, #appbar, #top_nav, header, [aria-label*="Google Account"] { display: none !important; }',
			});
		});
	});

	it("webQueries degrades correctly when no citations are found", async () => {
		const mockBrowser = await chromium.connectOverCDP("");
		const mockPage = mockBrowser.contexts()[0].pages()[0];

		// biome-ignore lint/suspicious/noExplicitAny: mock
		(mockPage.evaluate as any).mockImplementation((fn: any) => {
			const fnString = fn.toString();
			if (fnString.includes("querySelectorAll")) return Promise.resolve([]);
			return Promise.resolve("Some text ".repeat(20));
		});

		vi.useFakeTimers();
		const runPromise = cdpCapture.run("chatgpt", "prompt", { webSearch: true });
		await vi.advanceTimersByTimeAsync(8000);
		await vi.advanceTimersByTimeAsync(1500 * 60);
		const result = await runPromise;
		vi.useRealTimers();

		expect(result.citations).toHaveLength(0);
		// Reported web queries when web search is true but no search proven should be empty or 'unavailable' according to config
		expect(result.webQueries).toEqual([]);
	});
});

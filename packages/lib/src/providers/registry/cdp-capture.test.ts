import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cdpCapture } from "./cdp-capture";

vi.mock("@browserbasehq/stagehand", () => {
	const activePageMock = {
		goto: vi.fn(),
		evaluate: vi.fn(),
	};
	const contextMock = {
		activePage: vi.fn().mockResolvedValue(activePageMock),
	};
	const browserMock = {
		context: contextMock,
	};
	const stagehandMock = {
		browser: browserMock,
		act: vi.fn(),
		extract: vi.fn(),
		close: vi.fn(),
	};
	return {
		localBrowser: {
			connect: vi.fn().mockResolvedValue(browserMock),
		},
		Stagehand: {
			create: vi.fn().mockResolvedValue(stagehandMock),
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

	it("run calls stagehand with correct arguments and resolves successfully", async () => {
		const mockPageEvaluate = vi.fn().mockImplementation((fn) => {
			const fnString = fn.toString();
			if (fnString.includes("querySelectorAll")) {
				return Promise.resolve([
					{ url: "https://example.com", text: "Example Citation" },
					{ url: "https://openai.com", text: "Should be filtered" },
				]);
			}
			if (fnString.includes("is responding")) {
				return Promise.resolve(false);
			}
			return Promise.resolve("Mock response text");
		});

		const activePageMock = {
			goto: vi.fn().mockResolvedValue(undefined),
			evaluate: mockPageEvaluate,
		};
		const browserMock = {
			context: { activePage: vi.fn().mockResolvedValue(activePageMock) },
		};

		// biome-ignore lint/suspicious/noExplicitAny: mock
		vi.mocked(localBrowser.connect).mockResolvedValueOnce(browserMock as any);

		const stagehandMock = {
			browser: browserMock,
			act: vi.fn().mockResolvedValue({}),
			extract: vi.fn().mockResolvedValue({ data: { textContent: "Mock response text" } }),
			close: vi.fn().mockResolvedValue(undefined),
		};

		// biome-ignore lint/suspicious/noExplicitAny: mock
		vi.mocked(Stagehand.create).mockResolvedValueOnce(stagehandMock as any);

		vi.useFakeTimers();
		const runPromise = cdpCapture.run("chatgpt", "What is the meaning of life?", { webSearch: true });
		// Wait loop asks for up to 60 iterations * 2000ms = 120,000ms
		// We mock out 3 iterations of stabilization, which will take 3 * 2000 = 6000ms.
		// Let's use runAllTimersAsync to handle all Promises that are waiting on setTimeout.
		await vi.runAllTimersAsync();
		const result = await runPromise;
		vi.useRealTimers();

		expect(localBrowser.connect).toHaveBeenCalled();
		expect(Stagehand.create).toHaveBeenCalled();
		expect(activePageMock.goto).toHaveBeenCalledWith("https://chatgpt.com");
		expect(stagehandMock.act).toHaveBeenCalledWith(
			'type the prompt "What is the meaning of life?" into the message box and press enter',
		);
		expect(stagehandMock.extract).toHaveBeenCalled();

		expect(result.textContent).toBe("Mock response text");
		expect(result.citations).toHaveLength(1);
		expect(result.citations[0].url).toBe("https://example.com");
		expect(result.citations[0].domain).toBe("example.com");

		expect(stagehandMock.close).toHaveBeenCalled();
	});

	it("run throws clear error for unsupported model", async () => {
		await expect(cdpCapture.run("unknown", "prompt")).rejects.toThrow(/CDP Capture: unsupported model "unknown"/);
	});

	it("webQueries degrades correctly when no citations are found", async () => {
		const mockPageEvaluate = vi.fn().mockImplementation((fn) => {
			const fnString = fn.toString();
			if (fnString.includes("querySelectorAll")) {
				return Promise.resolve([]);
			}
			if (fnString.includes("is responding")) {
				return Promise.resolve(false);
			}
			return Promise.resolve("Some text");
		});

		const activePageMock = {
			goto: vi.fn().mockResolvedValue(undefined),
			evaluate: mockPageEvaluate,
		};
		const browserMock = {
			context: { activePage: vi.fn().mockResolvedValue(activePageMock) },
		};

		// biome-ignore lint/suspicious/noExplicitAny: mock
		vi.mocked(localBrowser.connect).mockResolvedValueOnce(browserMock as any);

		const stagehandMock = {
			browser: browserMock,
			act: vi.fn().mockResolvedValue({}),
			extract: vi.fn().mockResolvedValue({ data: { textContent: "Some text" } }),
			close: vi.fn().mockResolvedValue(undefined),
		};

		// biome-ignore lint/suspicious/noExplicitAny: mock
		vi.mocked(Stagehand.create).mockResolvedValueOnce(stagehandMock as any);

		vi.useFakeTimers();
		const runPromise = cdpCapture.run("chatgpt", "prompt", { webSearch: true });
		await vi.runAllTimersAsync();
		const result = await runPromise;
		vi.useRealTimers();

		expect(result.citations).toHaveLength(0);
		// Reported web queries when web search is true but no search proven should be empty or 'unavailable' according to config
		expect(result.webQueries).toEqual([]);
	});
});

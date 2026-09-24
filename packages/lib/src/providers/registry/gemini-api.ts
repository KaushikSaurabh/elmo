import { z } from "zod";
import { getCredential } from "../../secrets";
import { configuredWhen } from "../config";
import type {
	Provider,
	ProviderOptions,
	ScrapeResult,
	StructuredResearchOptions,
	StructuredResearchResult,
} from "../types";
import { parseSchemaJson } from "./ai-sdk";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// Verified current + GA as of 2026-09 (ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
// and already used successfully in 3EO's own integration (packages/integrations/src/llm.ts).
// No separate research-tier model: no verified "pro" sibling exists in this
// generation (searched - Gemini 3's Pro line doesn't share version numbers
// with the 3.8 Flash line), so the same model covers both plain calls and
// onboarding research rather than guessing at an unverified model id.
const DEFAULT_MODEL = "gemini-3.8-flash";

async function geminiPost(model: string, body: object): Promise<any> {
	const res = await fetch(`${GEMINI_BASE_URL}/models/${model}:generateContent`, {
		method: "POST",
		headers: {
			"x-goog-api-key": getCredential("GEMINI_API_KEY") || "",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
	}
	return res.json();
}

function candidateText(data: any): string {
	const parts = data?.candidates?.[0]?.content?.parts ?? [];
	return parts.map((p: any) => p?.text ?? "").join("");
}

/**
 * Gemini's structured-output schema is a restricted OpenAPI-3-style subset,
 * not standard JSON Schema: types are uppercase ("OBJECT", "STRING", ...) and
 * it has no $ref/$defs/additionalProperties support. This is a best-effort
 * recursive translation of z.toJSONSchema()'s output, sufficient for the flat
 * object/array/enum shapes the onboarding schemas actually use - not a
 * general-purpose JSON Schema converter.
 */
function toGeminiSchema(schema: Record<string, any>): Record<string, any> {
	if (schema.type === "object" && schema.properties) {
		const properties: Record<string, any> = {};
		for (const [key, value] of Object.entries(schema.properties)) {
			properties[key] = toGeminiSchema(value as Record<string, any>);
		}
		return {
			type: "OBJECT",
			properties,
			...(schema.required ? { required: schema.required } : {}),
		};
	}
	if (schema.type === "array" && schema.items) {
		return { type: "ARRAY", items: toGeminiSchema(schema.items) };
	}
	if (schema.enum) {
		return { type: "STRING", enum: schema.enum };
	}
	const typeMap: Record<string, string> = {
		string: "STRING",
		number: "NUMBER",
		integer: "INTEGER",
		boolean: "BOOLEAN",
	};
	return { type: typeMap[schema.type] ?? "STRING" };
}

export const geminiApi: Provider = {
	id: "gemini-api",
	name: "Gemini API",
	access: "api",
	docsAnchor: "direct-model-apis",

	isConfigured: configuredWhen("GEMINI_API_KEY"),

	async run(_model: string, prompt: string, options?: ProviderOptions): Promise<ScrapeResult> {
		const version = options?.version ?? DEFAULT_MODEL;
		const data = await geminiPost(version, {
			contents: [{ parts: [{ text: prompt }] }],
		});
		return {
			rawOutput: data,
			textContent: candidateText(data),
			webQueries: [],
			citations: [],
			modelVersion: version,
		};
	},

	// No web-search grounding here: Gemini's `google_search` tool and
	// `responseSchema` structured-output mode are not reliably combinable in
	// one call as of this writing - the same no-web-search tradeoff
	// mistral-api documents for its own plain-completion path. Operators who
	// need search-grounded onboarding research should target a different
	// provider via ONBOARDING_LLM_TARGET.
	async runStructuredResearch<T>({
		prompt,
		schema,
	}: StructuredResearchOptions<T>): Promise<StructuredResearchResult<T>> {
		const responseSchema = toGeminiSchema(z.toJSONSchema(schema) as Record<string, any>);
		const data = await geminiPost(DEFAULT_MODEL, {
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				responseMimeType: "application/json",
				responseSchema,
			},
		});
		return {
			object: parseSchemaJson(schema, candidateText(data)),
			modelVersion: DEFAULT_MODEL,
		};
	},
};

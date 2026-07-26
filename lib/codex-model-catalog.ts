import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, posix, win32 } from "node:path";

export const CC_SWITCH_CODEX_MODEL_CATALOG_FILENAME = "cc-switch-model-catalog.json";
export const DEFAULT_CODEX_MODEL_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CODEX_MODEL_CATALOG_MAX_MODELS = 512;

const DEFAULT_CONTEXT_WINDOW = 200_000;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_NAME_LENGTH = 256;

type CodexCatalogInput = "text" | "image";

export interface CodexCatalogModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: CodexCatalogInput[];
	contextWindow: number;
}

export type CodexCatalogStatus =
	| "loaded"
	| "not-referenced"
	| "not-owned"
	| "missing"
	| "too-large"
	| "invalid"
	| "empty";

export interface CodexCatalogDiscovery {
	models: CodexCatalogModel[];
	status: CodexCatalogStatus;
}

export interface ParseCodexCatalogOptions {
	fallbackContextWindow?: number;
	maxBytes?: number;
	maxModels?: number;
}

function catalogFileName(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isAbsoluteOnAnyPlatform(filePath: string): boolean {
	return isAbsolute(filePath) || posix.isAbsolute(filePath) || win32.isAbsolute(filePath);
}

export function resolveOwnedCodexCatalogPath(
	catalogPointer: string | undefined,
	configDirectory: string,
): string | undefined {
	const pointer = catalogPointer?.trim();
	if (!pointer || catalogFileName(pointer) !== CC_SWITCH_CODEX_MODEL_CATALOG_FILENAME) return undefined;

	if (isAbsoluteOnAnyPlatform(pointer)) return normalize(pointer);
	// CC Switch resolves every owned relative pointer to its generated file in the Codex config directory.
	return join(configDirectory, CC_SWITCH_CODEX_MODEL_CATALOG_FILENAME);
}

function normalizedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
	return normalized;
}

function positiveContextWindow(value: unknown): number | undefined {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string" && /^\d+$/.test(value.trim())
			? Number.parseInt(value.trim(), 10)
			: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_CONTEXT_WINDOW) return undefined;
	return parsed;
}

function catalogInput(entry: Record<string, unknown>): CodexCatalogInput[] {
	if (!Array.isArray(entry.input_modalities)) return ["text", "image"];
	const modalities = entry.input_modalities
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim().toLowerCase());
	return modalities.includes("image") ? ["text", "image"] : ["text"];
}

function catalogReasoning(entry: Record<string, unknown>): boolean {
	if (typeof entry.supports_reasoning === "boolean") return entry.supports_reasoning;
	if (!Array.isArray(entry.supported_reasoning_levels)) return true;

	return entry.supported_reasoning_levels.some((level) => {
		const effort = typeof level === "string"
			? level
			: level && typeof level === "object" && !Array.isArray(level)
				? (level as Record<string, unknown>).effort
				: undefined;
		return typeof effort === "string" && !/^(none|off)$/i.test(effort.trim());
	});
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function parseCodexModelCatalog(
	catalogText: string,
	options: ParseCodexCatalogOptions = {},
): CodexCatalogModel[] | undefined {
	const maxBytes = options.maxBytes ?? DEFAULT_CODEX_MODEL_CATALOG_MAX_BYTES;
	const maxModels = options.maxModels ?? DEFAULT_CODEX_MODEL_CATALOG_MAX_MODELS;
	if (byteLength(catalogText) > maxBytes) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(catalogText) as unknown;
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const rawModels = (parsed as Record<string, unknown>).models;
	if (!Array.isArray(rawModels) || rawModels.length > maxModels) return undefined;

	const fallbackContextWindow = positiveContextWindow(options.fallbackContextWindow) ?? DEFAULT_CONTEXT_WINDOW;
	const seen = new Set<string>();
	const models: CodexCatalogModel[] = [];

	for (const value of rawModels) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		const id = normalizedString(entry.slug, MAX_MODEL_ID_LENGTH);
		if (!id || seen.has(id)) continue;
		seen.add(id);

		models.push({
			id,
			name: normalizedString(entry.display_name, MAX_MODEL_NAME_LENGTH) ?? id,
			reasoning: catalogReasoning(entry),
			input: catalogInput(entry),
			contextWindow: positiveContextWindow(entry.context_window)
				?? positiveContextWindow(entry.max_context_window)
				?? fallbackContextWindow,
		});
	}

	return models;
}

export function loadOwnedCodexModelCatalog(
	catalogPointer: string | undefined,
	configDirectory: string,
	options: ParseCodexCatalogOptions = {},
): CodexCatalogDiscovery {
	if (!catalogPointer?.trim()) return { models: [], status: "not-referenced" };
	const catalogPath = resolveOwnedCodexCatalogPath(catalogPointer, configDirectory);
	if (!catalogPath) return { models: [], status: "not-owned" };

	try {
		const stat = statSync(catalogPath);
		if (!stat.isFile()) return { models: [], status: "missing" };
		const maxBytes = options.maxBytes ?? DEFAULT_CODEX_MODEL_CATALOG_MAX_BYTES;
		if (stat.size > maxBytes) return { models: [], status: "too-large" };

		const models = parseCodexModelCatalog(readFileSync(catalogPath, "utf8"), options);
		if (!models) return { models: [], status: "invalid" };
		if (models.length === 0) return { models, status: "empty" };
		return { models, status: "loaded" };
	} catch {
		return { models: [], status: "missing" };
	}
}

export function buildCodexModelIds(
	currentModel: string,
	catalogModels: CodexCatalogModel[],
	fallbackModels: readonly string[],
): string[] {
	const discovered = catalogModels.length > 0 ? catalogModels.map((model) => model.id) : fallbackModels;
	return Array.from(new Set(["current", currentModel, ...discovered].filter(Boolean)));
}

export function resolveCodexRequestModelId(selectedModel: string, currentModel: string): string {
	return selectedModel === "current" ? currentModel : selectedModel;
}

export function findCodexCatalogModel(
	catalogModels: CodexCatalogModel[],
	modelId: string,
): CodexCatalogModel | undefined {
	return catalogModels.find((model) => model.id === modelId);
}

export function clampCodexContextWindow(catalogContextWindow: number | undefined, configuredLimit: number): number {
	const limit = positiveContextWindow(configuredLimit) ?? DEFAULT_CONTEXT_WINDOW;
	const catalogValue = positiveContextWindow(catalogContextWindow);
	return catalogValue ? Math.min(catalogValue, limit) : limit;
}

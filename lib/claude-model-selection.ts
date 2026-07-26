export const CLAUDE_CURRENT_MODEL_ENV = "PI_CC_SWITCH_CLAUDE_CURRENT_MODEL";

const DEFAULT_CLAUDE_OPUS_MODEL = "claude-opus-5";
const DEFAULT_CLAUDE_SONNET_MODEL = "claude-sonnet-5";
const DEFAULT_CLAUDE_HAIKU_MODEL = "claude-haiku-4-5-20251001";

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function currentClaudeModelFromEnv(env: Record<string, unknown>): string | undefined {
	return (
		stringValue(env.ANTHROPIC_MODEL) ??
		stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ??
		stringValue(env.ANTHROPIC_DEFAULT_OPUS_MODEL) ??
		stringValue(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
	);
}

function claudeModelSuffix(model: string): string {
	return model.match(/\[[^\]]+\]\s*$/)?.[0].trim() ?? "";
}

function stripClaudeModelSuffix(model: string): string {
	return model.replace(/\[[^\]]+\]\s*$/, "").trim();
}

function withClaudeModelSuffix(model: string, suffix: string): string {
	if (!suffix) return model;
	return `${stripClaudeModelSuffix(model)}${suffix}`;
}

export function resolveClaudeSettingsModel(
	settingsModel: unknown,
	env: Record<string, unknown>,
): string | undefined {
	const model = stringValue(settingsModel);
	if (!model) return undefined;

	const suffix = claudeModelSuffix(model);
	const baseModel = stripClaudeModelSuffix(model);
	const normalized = baseModel.toLowerCase();
	if (normalized === "opus" || normalized === "best") {
		return withClaudeModelSuffix(
			stringValue(env.ANTHROPIC_DEFAULT_OPUS_MODEL) ?? DEFAULT_CLAUDE_OPUS_MODEL,
			suffix,
		);
	}
	if (normalized === "sonnet") {
		return withClaudeModelSuffix(
			stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ?? DEFAULT_CLAUDE_SONNET_MODEL,
			suffix,
		);
	}
	if (normalized === "haiku") {
		return withClaudeModelSuffix(
			stringValue(env.ANTHROPIC_DEFAULT_HAIKU_MODEL) ?? DEFAULT_CLAUDE_HAIKU_MODEL,
			suffix,
		);
	}
	return model;
}

/**
 * Resolve the model behind the `current` alias without inspecting CC Switch's
 * credential database. Explicit non-secret metadata wins over live defaults.
 */
export function resolveClaudeCurrentModel(
	settings: Record<string, unknown>,
	env: Record<string, unknown>,
	processEnvironment: Record<string, string | undefined> = process.env,
): string | undefined {
	const explicitModel = stringValue(processEnvironment[CLAUDE_CURRENT_MODEL_ENV])
		?? stringValue(env[CLAUDE_CURRENT_MODEL_ENV]);
	return explicitModel
		? resolveClaudeSettingsModel(explicitModel, env)
		: currentClaudeModelFromEnv(env) ?? resolveClaudeSettingsModel(settings.model, env);
}

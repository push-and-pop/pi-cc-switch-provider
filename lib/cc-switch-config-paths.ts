import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

const CC_SWITCH_SETTINGS_MAX_BYTES = 1024 * 1024;
const MAX_DIRECTORY_PATH_LENGTH = 32_768;

export interface CcSwitchCliDirectoryOverrides {
	claudeConfigDir?: string;
	codexConfigDir?: string;
}

export interface CcSwitchCliPaths {
	ccSwitchSettingsPath: string;
	claudeConfigDir: string;
	claudeSettingsPath: string;
	codexConfigDir: string;
	codexAuthPath: string;
	codexConfigPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function directoryValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_DIRECTORY_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

function firstDirectoryValue(settings: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = directoryValue(settings[key]);
		if (value) return value;
	}
	return undefined;
}

export function ccSwitchSettingsPath(homeDirectory: string): string {
	return join(homeDirectory, ".cc-switch", "settings.json");
}

/**
 * Read only CC Switch's device-local CLI directory metadata. Provider payloads,
 * database contents, API keys, and every unrelated settings field are ignored.
 */
export function readCcSwitchCliDirectoryOverrides(homeDirectory: string): CcSwitchCliDirectoryOverrides {
	const settingsPath = ccSwitchSettingsPath(homeDirectory);
	try {
		const stat = statSync(settingsPath);
		if (!stat.isFile() || stat.size > CC_SWITCH_SETTINGS_MAX_BYTES) return {};
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "")) as unknown;
		if (!isRecord(parsed)) return {};
		return {
			claudeConfigDir: firstDirectoryValue(parsed, "claudeConfigDir", "claude_config_dir"),
			codexConfigDir: firstDirectoryValue(parsed, "codexConfigDir", "codex_config_dir"),
		};
	} catch {
		return {};
	}
}

/** Mirror CC Switch's supported `~`, `~/...`, and native absolute override forms. */
export function resolveCcSwitchDirectoryOverride(
	rawDirectory: string | undefined,
	homeDirectory: string,
): string | undefined {
	const directory = directoryValue(rawDirectory);
	if (!directory) return undefined;
	if (directory === "~") return normalize(homeDirectory);
	if (directory.startsWith("~/") || directory.startsWith("~\\")) {
		const segments = directory.slice(2).split(/[\\/]+/).filter(Boolean);
		return normalize(join(homeDirectory, ...segments));
	}
	// CC Switch's directory picker writes absolute paths. A relative path would be
	// relative to the GUI process rather than Pi's cwd, so fail closed instead of
	// silently reading credentials from the wrong directory.
	if (!isAbsolute(directory)) return undefined;
	return normalize(directory);
}

function claudeSettingsPath(configDirectory: string): string {
	const primaryPath = join(configDirectory, "settings.json");
	if (existsSync(primaryPath)) return primaryPath;
	const legacyPath = join(configDirectory, "claude.json");
	return existsSync(legacyPath) ? legacyPath : primaryPath;
}

export function resolveCcSwitchCliPaths(homeDirectory: string): CcSwitchCliPaths {
	const overrides = readCcSwitchCliDirectoryOverrides(homeDirectory);
	const claudeConfigDir = resolveCcSwitchDirectoryOverride(overrides.claudeConfigDir, homeDirectory)
		?? join(homeDirectory, ".claude");
	const codexConfigDir = resolveCcSwitchDirectoryOverride(overrides.codexConfigDir, homeDirectory)
		?? join(homeDirectory, ".codex");

	return {
		ccSwitchSettingsPath: ccSwitchSettingsPath(homeDirectory),
		claudeConfigDir,
		claudeSettingsPath: claudeSettingsPath(claudeConfigDir),
		codexConfigDir,
		codexAuthPath: join(codexConfigDir, "auth.json"),
		codexConfigPath: join(codexConfigDir, "config.toml"),
	};
}

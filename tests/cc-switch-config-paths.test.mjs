import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";

import {
	ccSwitchSettingsPath,
	readCcSwitchCliDirectoryOverrides,
	resolveCcSwitchCliPaths,
	resolveCcSwitchDirectoryOverride,
} from "../lib/cc-switch-config-paths.ts";

function withTempHome(run) {
	const home = mkdtempSync(join(tmpdir(), "pi-cc-switch-paths-"));
	try {
		run(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function writeCcSwitchSettings(home, settings) {
	const settingsPath = ccSwitchSettingsPath(home);
	mkdirSync(join(home, ".cc-switch"), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
}

test("CLI paths preserve the default layout when CC Switch has no overrides", () => {
	withTempHome((home) => {
		assert.deepEqual(resolveCcSwitchCliPaths(home), {
			ccSwitchSettingsPath: join(home, ".cc-switch", "settings.json"),
			claudeConfigDir: join(home, ".claude"),
			claudeSettingsPath: join(home, ".claude", "settings.json"),
			codexConfigDir: join(home, ".codex"),
			codexAuthPath: join(home, ".codex", "auth.json"),
			codexConfigPath: join(home, ".codex", "config.toml"),
		});
	});
});

test("camelCase CC Switch overrides relocate Claude and Codex live files", () => {
	withTempHome((home) => {
		const claudeDirectory = join(home, "profiles", "claude-live");
		const codexDirectory = join(home, "profiles", "codex-live");
		mkdirSync(claudeDirectory, { recursive: true });
		writeFileSync(join(claudeDirectory, "claude.json"), "{}", "utf8");
		writeCcSwitchSettings(home, {
			claudeConfigDir: claudeDirectory,
			codexConfigDir: codexDirectory,
			apiKey: "must-not-be-projected",
			webdavPassword: "must-not-be-projected",
		});

		assert.deepEqual(readCcSwitchCliDirectoryOverrides(home), {
			claudeConfigDir: claudeDirectory,
			codexConfigDir: codexDirectory,
		});
		const paths = resolveCcSwitchCliPaths(home);
		assert.equal(paths.claudeConfigDir, normalize(claudeDirectory));
		assert.equal(paths.claudeSettingsPath, join(claudeDirectory, "claude.json"));
		assert.equal(paths.codexConfigDir, normalize(codexDirectory));
		assert.equal(paths.codexAuthPath, join(codexDirectory, "auth.json"));
		assert.equal(paths.codexConfigPath, join(codexDirectory, "config.toml"));
	});
});

test("snake_case metadata and tilde paths remain compatible", () => {
	withTempHome((home) => {
		writeCcSwitchSettings(home, {
			claude_config_dir: "~/portable/claude",
			codex_config_dir: "~\\portable\\codex",
		});
		const paths = resolveCcSwitchCliPaths(home);
		assert.equal(paths.claudeConfigDir, join(home, "portable", "claude"));
		assert.equal(paths.codexConfigDir, join(home, "portable", "codex"));
	});
});

test("malformed and oversized settings fail closed to defaults", () => {
	withTempHome((home) => {
		mkdirSync(join(home, ".cc-switch"), { recursive: true });
		writeFileSync(ccSwitchSettingsPath(home), "not json", "utf8");
		assert.deepEqual(readCcSwitchCliDirectoryOverrides(home), {});
		assert.equal(resolveCcSwitchCliPaths(home).codexConfigDir, join(home, ".codex"));

		writeCcSwitchSettings(home, {
			codexConfigDir: join(home, "oversized-codex"),
			padding: "x".repeat(1024 * 1024),
		});
		assert.deepEqual(readCcSwitchCliDirectoryOverrides(home), {});
	});
});

test("ambiguous relative overrides fail closed to defaults", () => {
	withTempHome((home) => {
		writeCcSwitchSettings(home, {
			claudeConfigDir: "relative/claude",
			codexConfigDir: "relative/codex",
		});
		const paths = resolveCcSwitchCliPaths(home);
		assert.equal(paths.claudeConfigDir, join(home, ".claude"));
		assert.equal(paths.codexConfigDir, join(home, ".codex"));
		assert.equal(resolveCcSwitchDirectoryOverride("relative/path", home), undefined);
	});
});

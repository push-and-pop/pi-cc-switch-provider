import assert from "node:assert/strict";
import test from "node:test";

import {
	CLAUDE_CURRENT_MODEL_ENV,
	resolveClaudeCurrentModel,
	resolveClaudeSettingsModel,
} from "../lib/claude-model-selection.ts";

test("Claude current model remains unset when live metadata contains no model", () => {
	assert.equal(resolveClaudeCurrentModel({}, {}, {}), undefined);
});

test("process-level explicit model takes precedence over live settings", () => {
	assert.equal(
		resolveClaudeCurrentModel(
			{ model: "haiku" },
			{ ANTHROPIC_MODEL: "claude-sonnet-live", [CLAUDE_CURRENT_MODEL_ENV]: "claude-opus-settings" },
			{ [CLAUDE_CURRENT_MODEL_ENV]: "claude-opus-process" },
		),
		"claude-opus-process",
	);
});

test("settings env can provide an explicit non-secret current model", () => {
	assert.equal(
		resolveClaudeCurrentModel(
			{},
			{ [CLAUDE_CURRENT_MODEL_ENV]: "claude-opus-5" },
			{},
		),
		"claude-opus-5",
	);
});

test("standard live model metadata remains the fallback", () => {
	assert.equal(
		resolveClaudeCurrentModel({}, { ANTHROPIC_MODEL: "claude-live-model" }, {}),
		"claude-live-model",
	);
	assert.equal(
		resolveClaudeCurrentModel({ model: "claude-settings-model" }, {}, {}),
		"claude-settings-model",
	);
});

test("Claude aliases preserve suffixes and honor configured family defaults", () => {
	assert.equal(resolveClaudeSettingsModel("opus", {}), "claude-opus-5");
	assert.equal(resolveClaudeSettingsModel("best[1m]", {}), "claude-opus-5[1m]");
	assert.equal(
		resolveClaudeSettingsModel("sonnet[1m]", { ANTHROPIC_DEFAULT_SONNET_MODEL: "relay-sonnet" }),
		"relay-sonnet[1m]",
	);
	assert.equal(resolveClaudeSettingsModel("haiku", {}), "claude-haiku-4-5-20251001");
});

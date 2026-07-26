import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	CC_SWITCH_PROXY_TOKEN_PLACEHOLDER,
	CODEX_SUMMARY_API_KEY_ENV,
	CODEX_SUMMARY_BASE_URL_ENV,
	CODEX_SUMMARY_ENV_AUTH_REF,
	CODEX_SUMMARY_MODEL_ENV,
	CODEX_SUMMARY_PROXY_AUTH_REF,
	parseCcSwitchProviderLocalConfig,
	resolveCodexSummaryRoute,
} from "../extensions/codex-summary-route.ts";

test("the checked-in loopback example contains only route metadata", () => {
	const example = JSON.parse(readFileSync(new URL("../config/cc-switch-provider.example.json", import.meta.url), "utf8"));
	const parsed = parseCcSwitchProviderLocalConfig(example);
	assert.equal(parsed.codexSummary?.authRef, CODEX_SUMMARY_PROXY_AUTH_REF);
	assert.equal(parsed.codexSummary?.baseUrl, "http://127.0.0.1:15721/v1");
});

test("the runtime provider no longer scrapes the CC Switch SQLite file", () => {
	const source = readFileSync(new URL("../extensions/cc-switch-provider.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /readCcSwitchDbText|findCodexProviderInCcSwitchDb|\.cc-switch[\\/].*cc-switch\.db|paid\.tribiosapi\.top/);
});

test("no explicit summary route keeps the current Codex route", () => {
	assert.equal(resolveCodexSummaryRoute({ environment: {}, localConfig: null }), undefined);
});

test("external summary route requires the fixed environment credential reference", () => {
	const route = resolveCodexSummaryRoute({
		environment: { [CODEX_SUMMARY_API_KEY_ENV]: "test-runtime-credential" },
		localConfig: {
			codexSummary: {
				baseUrl: "https://relay.example/v1",
				model: "gpt-test",
				authRef: CODEX_SUMMARY_ENV_AUTH_REF,
			},
		},
	});

	assert.ok(route);
	assert.equal(route.baseUrl, "https://relay.example/v1");
	assert.equal(route.model, "gpt-test");
	assert.equal(route.authSource, "environment");
	assert.equal(route.apiKey, "test-runtime-credential");
});

test("external summary route reuses the live model when no override is configured", () => {
	const route = resolveCodexSummaryRoute({
		environment: { [CODEX_SUMMARY_API_KEY_ENV]: "test-runtime-credential" },
		localConfig: {
			codexSummary: {
				baseUrl: "https://relay.example/v1",
				authRef: CODEX_SUMMARY_ENV_AUTH_REF,
			},
		},
		liveModel: "gpt-live",
	});

	assert.ok(route);
	assert.equal(route.model, "gpt-live");
	assert.equal(route.authSource, "environment");
});

test("loopback summary route uses the CC Switch placeholder and live model", () => {
	const route = resolveCodexSummaryRoute({
		environment: {},
		localConfig: {
			codexSummary: {
				baseUrl: "http://127.0.0.1:15721/v1/",
				authRef: CODEX_SUMMARY_PROXY_AUTH_REF,
			},
		},
		liveModel: "current-model",
	});

	assert.ok(route);
	assert.equal(route.baseUrl, "http://127.0.0.1:15721/v1");
	assert.equal(route.model, "current-model");
	assert.equal(route.authSource, "cc-switch-proxy");
	assert.equal(route.apiKey, CC_SWITCH_PROXY_TOKEN_PLACEHOLDER);
});

test("environment route fields override file route fields", () => {
	const route = resolveCodexSummaryRoute({
		environment: {
			[CODEX_SUMMARY_BASE_URL_ENV]: "https://env-relay.example/v1",
			[CODEX_SUMMARY_MODEL_ENV]: "env-model",
			[CODEX_SUMMARY_API_KEY_ENV]: "env-test-credential",
		},
		localConfig: {
			codexSummary: {
				baseUrl: "https://file-relay.example/v1",
				model: "file-model",
				authRef: CODEX_SUMMARY_ENV_AUTH_REF,
			},
		},
	});

	assert.ok(route);
	assert.equal(route.baseUrl, "https://env-relay.example/v1");
	assert.equal(route.model, "env-model");
	assert.equal(route.configSource, "environment");
});

test("literal credentials are rejected in the local config", () => {
	assert.throws(
		() => parseCcSwitchProviderLocalConfig({
			codexSummary: {
				baseUrl: "https://relay.example/v1",
				model: "gpt-test",
				apiKey: "must-not-be-stored-here",
			},
		}),
		/不能包含凭据字段 apiKey/,
	);
});

test("external routes cannot claim the CC Switch proxy auth reference", () => {
	assert.throws(
		() => resolveCodexSummaryRoute({
			environment: {},
			localConfig: {
				codexSummary: {
					baseUrl: "https://relay.example/v1",
					model: "gpt-test",
					authRef: CODEX_SUMMARY_PROXY_AUTH_REF,
				},
			},
		}),
		/只允许 HTTP loopback/,
	);
});

test("external routes fail closed when the environment credential is missing", () => {
	assert.throws(
		() => resolveCodexSummaryRoute({
			environment: {},
			localConfig: {
				codexSummary: {
					baseUrl: "https://relay.example/v1",
					model: "gpt-test",
					authRef: CODEX_SUMMARY_ENV_AUTH_REF,
				},
			},
		}),
		new RegExp(CODEX_SUMMARY_API_KEY_ENV),
	);
});

test("malformed route metadata fails instead of silently falling back", () => {
	assert.throws(
		() => parseCcSwitchProviderLocalConfig({ codexSummary: { baseUrl: 15721 } }),
		/baseUrl 必须是非空字符串/,
	);
});

test("external HTTP routes are rejected before credentials are sent", () => {
	assert.throws(
		() => resolveCodexSummaryRoute({
			environment: { [CODEX_SUMMARY_API_KEY_ENV]: "must-not-be-sent" },
			localConfig: {
				codexSummary: {
					baseUrl: "http://relay.example/v1",
					model: "gpt-test",
					authRef: CODEX_SUMMARY_ENV_AUTH_REF,
				},
			},
		}),
		/必须使用 HTTPS/,
	);
});

test("the FC endpoint known to reject compaction is not accepted as a summary route", () => {
	assert.throws(
		() => resolveCodexSummaryRoute({
			environment: {},
			localConfig: {
				codexSummary: {
					baseUrl: "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1",
					model: "gpt-test",
					authRef: CODEX_SUMMARY_ENV_AUTH_REF,
				},
			},
		}),
		/不能指向不支持压缩的 FC 地址/,
	);
});

test("summary base URLs cannot embed credentials", () => {
	assert.throws(
		() => resolveCodexSummaryRoute({
			environment: {},
			localConfig: {
				codexSummary: {
					baseUrl: "https://user:password@relay.example/v1",
					model: "gpt-test",
					authRef: CODEX_SUMMARY_ENV_AUTH_REF,
				},
			},
		}),
		/不能包含凭据/,
	);
});

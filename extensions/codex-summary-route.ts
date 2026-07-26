import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_SUMMARY_BASE_URL_ENV = "PI_CC_SWITCH_CODEX_SUMMARY_BASE_URL";
export const CODEX_SUMMARY_MODEL_ENV = "PI_CC_SWITCH_CODEX_SUMMARY_MODEL";
export const CODEX_SUMMARY_API_KEY_ENV = "PI_CC_SWITCH_CODEX_SUMMARY_API_KEY";
export const CODEX_SUMMARY_ENV_AUTH_REF = `env:${CODEX_SUMMARY_API_KEY_ENV}` as const;
export const CODEX_SUMMARY_PROXY_AUTH_REF = "cc-switch-proxy" as const;
export const CC_SWITCH_PROXY_TOKEN_PLACEHOLDER = "PROXY_MANAGED";
export const CC_SWITCH_PROVIDER_CONFIG_FILE = "cc-switch-provider.json";

const FCAPP_ADMISSION_RETRY_HOST = "a-ocnfniawgw.cn-shanghai.fcapp.run";

type SummaryAuthRef = typeof CODEX_SUMMARY_ENV_AUTH_REF | typeof CODEX_SUMMARY_PROXY_AUTH_REF;
type SummaryConfigSource = "environment" | "config";
type SummaryAuthSource = "environment" | "cc-switch-proxy";

export interface CodexSummaryLocalConfig {
	baseUrl?: string;
	model?: string;
	authRef?: SummaryAuthRef;
}

export interface CcSwitchProviderLocalConfig {
	codexSummary?: CodexSummaryLocalConfig;
}

export interface CodexSummaryRoute {
	baseUrl: string;
	apiKey: string;
	model: string;
	authRef: SummaryAuthRef;
	configSource: SummaryConfigSource;
	authSource: SummaryAuthSource;
}

export interface ResolveCodexSummaryRouteOptions {
	liveModel?: string;
	environment?: Record<string, string | undefined>;
	/** null skips the user config file; primarily useful for tests. */
	localConfig?: CcSwitchProviderLocalConfig | null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalConfigString(config: Record<string, unknown>, key: string): string | undefined {
	if (config[key] === undefined) return undefined;
	const value = nonEmptyString(config[key]);
	if (!value) throw new Error(`独立压缩中转配置 ${key} 必须是非空字符串`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoCredentialLiterals(config: Record<string, unknown>): void {
	for (const key of Object.keys(config)) {
		if (/api.?key|authorization|credential|secret|token/i.test(key)) {
			throw new Error(
				`独立压缩中转配置不能包含凭据字段 ${key}；请使用 authRef=${CODEX_SUMMARY_ENV_AUTH_REF} 或 ${CODEX_SUMMARY_PROXY_AUTH_REF}`,
			);
		}
	}
}

export function parseCcSwitchProviderLocalConfig(value: unknown): CcSwitchProviderLocalConfig {
	if (!isRecord(value)) {
		throw new Error("独立压缩中转配置文件必须是 JSON 对象");
	}
	assertNoCredentialLiterals(value);
	if (value.codexSummary === undefined) return {};
	if (!isRecord(value.codexSummary)) {
		throw new Error("独立压缩中转配置 codexSummary 必须是 JSON 对象");
	}

	assertNoCredentialLiterals(value.codexSummary);
	const baseUrl = optionalConfigString(value.codexSummary, "baseUrl");
	const model = optionalConfigString(value.codexSummary, "model");
	const authRef = optionalConfigString(value.codexSummary, "authRef");
	if (authRef && authRef !== CODEX_SUMMARY_ENV_AUTH_REF && authRef !== CODEX_SUMMARY_PROXY_AUTH_REF) {
		throw new Error(
			`独立压缩中转 authRef 仅支持 ${CODEX_SUMMARY_ENV_AUTH_REF} 或 ${CODEX_SUMMARY_PROXY_AUTH_REF}`,
		);
	}

	return {
		codexSummary: {
			baseUrl,
			model,
			authRef: authRef as SummaryAuthRef | undefined,
		},
	};
}

export function ccSwitchProviderConfigPath(): string {
	return join(homedir(), ".pi", "agent", CC_SWITCH_PROVIDER_CONFIG_FILE);
}

export function loadCcSwitchProviderLocalConfig(): CcSwitchProviderLocalConfig | undefined {
	const configPath = ccSwitchProviderConfigPath();
	if (!existsSync(configPath)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		throw new Error(`独立压缩中转配置文件不是有效的 JSON：${configPath}`);
	}
	return parseCcSwitchProviderLocalConfig(parsed);
}

function validateCodexSummaryBaseUrl(baseUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error("独立压缩中转 baseUrl 必须是有效的 HTTP/HTTPS 地址");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("独立压缩中转 baseUrl 必须使用 HTTP 或 HTTPS");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("独立压缩中转 baseUrl 不能包含凭据、查询参数或 fragment");
	}
	if (parsed.hostname.toLowerCase() === FCAPP_ADMISSION_RETRY_HOST) {
		throw new Error("独立压缩中转不能指向不支持压缩的 FC 地址");
	}
	return parsed;
}

function isLoopbackUrl(url: URL): boolean {
	return new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname.toLowerCase());
}

export function resolveCodexSummaryRoute(
	options: ResolveCodexSummaryRouteOptions = {},
): CodexSummaryRoute | undefined {
	const environment = options.environment ?? process.env;
	const localConfig = options.localConfig === undefined
		? loadCcSwitchProviderLocalConfig()
		: options.localConfig ?? undefined;
	const fileRoute = localConfig?.codexSummary;
	const environmentBaseUrl = nonEmptyString(environment[CODEX_SUMMARY_BASE_URL_ENV]);
	const configuredBaseUrl = environmentBaseUrl ?? fileRoute?.baseUrl;

	// 独立 route 是显式 opt-in。未配置时继续走当前 Codex/CC Switch route，
	// 不再隐式访问硬编码第三方地址，也不读取 cc-switch.db。
	if (!configuredBaseUrl) return undefined;

	const parsedUrl = validateCodexSummaryBaseUrl(configuredBaseUrl);
	const configSource: SummaryConfigSource = environmentBaseUrl ? "environment" : "config";
	const loopback = isLoopbackUrl(parsedUrl);
	if (!loopback && parsedUrl.protocol !== "https:") {
		throw new Error("外部独立压缩中转必须使用 HTTPS");
	}
	const authRef = configSource === "environment"
		? (loopback ? CODEX_SUMMARY_PROXY_AUTH_REF : CODEX_SUMMARY_ENV_AUTH_REF)
		: fileRoute?.authRef ?? (loopback ? CODEX_SUMMARY_PROXY_AUTH_REF : CODEX_SUMMARY_ENV_AUTH_REF);

	if (authRef === CODEX_SUMMARY_PROXY_AUTH_REF && !loopback) {
		throw new Error("authRef=cc-switch-proxy 只允许 HTTP loopback 地址");
	}

	const environmentModel = nonEmptyString(environment[CODEX_SUMMARY_MODEL_ENV]);
	const model = environmentModel
		?? fileRoute?.model
		?? (authRef === CODEX_SUMMARY_PROXY_AUTH_REF ? options.liveModel : undefined);
	if (!model) {
		throw new Error(`独立压缩中转缺少模型；请设置 codexSummary.model 或 ${CODEX_SUMMARY_MODEL_ENV}`);
	}

	const environmentApiKey = nonEmptyString(environment[CODEX_SUMMARY_API_KEY_ENV]);
	const apiKey = authRef === CODEX_SUMMARY_PROXY_AUTH_REF
		? CC_SWITCH_PROXY_TOKEN_PLACEHOLDER
		: environmentApiKey;
	if (!apiKey) {
		throw new Error(`独立压缩中转凭据不可用；请在本地进程环境中设置 ${CODEX_SUMMARY_API_KEY_ENV}`);
	}

	return {
		baseUrl: configuredBaseUrl.replace(/\/+$/, ""),
		apiKey,
		model,
		authRef,
		configSource,
		authSource: authRef === CODEX_SUMMARY_PROXY_AUTH_REF ? "cc-switch-proxy" : "environment",
	};
}

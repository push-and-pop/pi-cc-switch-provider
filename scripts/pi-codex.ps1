[CmdletBinding()]
param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$PiArguments
)

$ErrorActionPreference = "Stop"

$AnyrouterBaseHost = "anyrouter.top"
$AnyrouterBasePath = "/v1"
$DefaultAnyrouterProxy = "http://127.0.0.1:7897"
$AnyrouterProxyEnv = "PI_CC_SWITCH_ANYROUTER_PROXY"
$GlobalProxyEnvNames = @(
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"NODE_USE_ENV_PROXY"
)

function Resolve-CcSwitchDirectoryOverride {
	param(
		[AllowNull()]
		[object]$RawDirectory,
		[Parameter(Mandatory = $true)]
		[string]$HomeDirectory
	)

	if ($RawDirectory -isnot [string]) { return $null }
	$directory = $RawDirectory.Trim()
	if ([string]::IsNullOrWhiteSpace($directory)) { return $null }

	if ($directory -eq "~") {
		return [IO.Path]::GetFullPath($HomeDirectory)
	}
	if ($directory.StartsWith("~/") -or $directory.StartsWith("~\")) {
		$relativePath = $directory.Substring(2) -replace "[\\/]+", [IO.Path]::DirectorySeparatorChar
		return [IO.Path]::GetFullPath((Join-Path $HomeDirectory $relativePath))
	}
	if ([IO.Path]::IsPathRooted($directory)) {
		return [IO.Path]::GetFullPath($directory)
	}

	return $null
}

function Resolve-CodexConfigPath {
	$homeDirectory = $env:USERPROFILE
	if ([string]::IsNullOrWhiteSpace($homeDirectory)) {
		$homeDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
	}

	$codexConfigDirectory = Join-Path $homeDirectory ".codex"
	$settingsPath = Join-Path (Join-Path $homeDirectory ".cc-switch") "settings.json"
	try {
		if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
			$settingsFile = Get-Item -LiteralPath $settingsPath
			if ($settingsFile.Length -le 1MB) {
				$settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
				$override = $settings.codexConfigDir
				if ($null -eq $override) { $override = $settings.codex_config_dir }
				$resolvedOverride = Resolve-CcSwitchDirectoryOverride $override $homeDirectory
				if ($resolvedOverride) { $codexConfigDirectory = $resolvedOverride }
			}
		}
	} catch {
		# Fail closed to ~/.codex, matching the extension's path resolver.
	}

	return Join-Path $codexConfigDirectory "config.toml"
}

function ConvertFrom-CodexTomlScalar {
	param([Parameter(Mandatory = $true)][string]$RawValue)

	$value = $RawValue.Trim()
	if ($value.Length -eq 0) { return $null }

	if ($value[0] -eq '"') {
		$match = [regex]::Match($value, '^"(?<value>(?:\\.|[^"\\])*)"')
		if (-not $match.Success) { return $null }
		$decoded = $match.Groups["value"].Value
		$decoded = $decoded.Replace('\n', "`n").Replace('\t', "`t").Replace('\r', "`r")
		$decoded = $decoded.Replace('\"', '"').Replace('\\', '\')
		return $decoded
	}

	if ($value[0] -eq "'") {
		$endIndex = $value.IndexOf("'", 1)
		if ($endIndex -lt 0) { return $null }
		return $value.Substring(1, $endIndex - 1)
	}

	$commentIndex = $value.IndexOf("#")
	if ($commentIndex -ge 0) { $value = $value.Substring(0, $commentIndex) }
	$value = $value.Trim()
	if ($value.Length -gt 0) { return $value }
	return $null
}

function Read-CodexToml {
	param([Parameter(Mandatory = $true)][string]$Text)

	$top = @{}
	$sections = @{}
	$currentSection = $null

	foreach ($rawLine in [regex]::Split($Text, "\r?\n")) {
		$line = $rawLine.TrimStart([char]0xFEFF).Trim()
		if (-not $line -or $line.StartsWith("#")) { continue }

		$sectionMatch = [regex]::Match($line, '^\[([^\]]+)\]\s*(?:#.*)?$')
		if ($sectionMatch.Success) {
			$currentSection = $sectionMatch.Groups[1].Value.Trim()
			if (-not $sections.ContainsKey($currentSection)) { $sections[$currentSection] = @{} }
			continue
		}

		$keyValueMatch = [regex]::Match($line, '^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$')
		if (-not $keyValueMatch.Success) { continue }
		$key = $keyValueMatch.Groups[1].Value.Trim()
		$value = ConvertFrom-CodexTomlScalar $keyValueMatch.Groups[2].Value
		if ($null -eq $value) { continue }

		if ($null -ne $currentSection) { $sections[$currentSection][$key] = $value }
		else { $top[$key] = $value }
	}

	return [pscustomobject]@{ Top = $top; Sections = $sections }
}

function Get-ActiveCodexBaseUrl {
	param([Parameter(Mandatory = $true)][string]$ConfigPath)

	try {
		if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $null }
		$configFile = Get-Item -LiteralPath $ConfigPath
		if ($configFile.Length -gt 1MB) { return $null }

		$toml = Read-CodexToml (Get-Content -Raw -LiteralPath $ConfigPath)
		$activeProvider = $toml.Top["model_provider"]
		$baseUrl = $null
		if ($activeProvider) {
			$sectionName = "model_providers.$activeProvider"
			if ($toml.Sections.ContainsKey($sectionName)) {
				$baseUrl = $toml.Sections[$sectionName]["base_url"]
			}
		}
		if (-not $baseUrl) { $baseUrl = $toml.Top["base_url"] }
		return $baseUrl
	} catch {
		return $null
	}
}

function Test-AnyrouterV1BaseUrl {
	param([AllowNull()][string]$BaseUrl)

	if ([string]::IsNullOrWhiteSpace($BaseUrl)) { return $false }
	try {
		$uri = [Uri]$BaseUrl
		if (-not $uri.IsAbsoluteUri) { return $false }
		$path = $uri.AbsolutePath.TrimEnd('/')
		return $uri.Scheme -eq "https" `
			-and $uri.Host -ieq $AnyrouterBaseHost `
			-and ($uri.IsDefaultPort -or $uri.Port -eq 443) `
			-and $path -ceq $AnyrouterBasePath `
			-and [string]::IsNullOrEmpty($uri.Query) `
			-and [string]::IsNullOrEmpty($uri.Fragment)
	} catch {
		return $false
	}
}

$configPath = Resolve-CodexConfigPath
$baseUrl = Get-ActiveCodexBaseUrl $configPath
$useSelectiveProxy = Test-AnyrouterV1BaseUrl $baseUrl

if ($useSelectiveProxy) {
	foreach ($name in $GlobalProxyEnvNames) {
		Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
	}
	$proxyUrl = [Environment]::GetEnvironmentVariable($AnyrouterProxyEnv, "Process")
	if ([string]::IsNullOrWhiteSpace($proxyUrl)) { $proxyUrl = $DefaultAnyrouterProxy }
	Set-Item -LiteralPath "Env:$AnyrouterProxyEnv" -Value $proxyUrl
	Write-Host "[pi-codex] https://anyrouter.top/v1 detected; selective proxy enabled."
} else {
	Remove-Item -LiteralPath "Env:$AnyrouterProxyEnv" -ErrorAction SilentlyContinue
}

& pi --provider cc-switch-codex --model current @PiArguments
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }
exit $exitCode

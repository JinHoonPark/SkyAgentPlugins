param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json
& $config.claude -p $config.query --output-format stream-json --verbose --include-partial-messages --setting-sources project,local --strict-mcp-config --no-session-persistence --model claude-opus-5-5 --max-turns 1
exit $LASTEXITCODE

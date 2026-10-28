# Build a minimal unpacked-extension ZIP; no third-party dependencies.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$extensionRoot = Join-Path $projectRoot 'edge-extension'
$manifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
if ($version -notmatch '^\d+(\.\d+){1,3}$') { throw 'Invalid manifest version.' }

# Explicit allowlist: never recursively package the checkout, tests or reports.
$runtimeFiles = @(
    'manifest.json', 'api-client.js', 'api-config.js', 'background.js',
    'content.css', 'content.js', 'cycle.js', 'command-verification.js', 'diagnostics.js', 'errors.js',
    'history.js', 'page-bridge.js', 'page-observer.js', 'report-directory.js',
    'report-format.js', 'report-settings.css', 'report-settings.html',
    'report-settings.js', 'reports.js'
)
$distRoot = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$stageRoot = Join-Path $distRoot ('build-' + [Guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $stageRoot 'HKUST-AC-Cycle'
$archiveName = "HKUST-AC-Cycle-v$version.zip"
$archivePath = Join-Path $distRoot $archiveName

try {
    New-Item -ItemType Directory -Path $payloadRoot | Out-Null
    foreach ($file in $runtimeFiles) {
        Copy-Item -LiteralPath (Join-Path $extensionRoot $file) -Destination (Join-Path $payloadRoot $file)
    }
    foreach ($file in @('README.md', 'PRIVACY.md')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $payloadRoot $file)
    }
    # Existing generated output is replaced only after all input files were read.
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath }
    [IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $archivePath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$archivePath.sha256", "$hash  $archiveName`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Created: $archivePath"
    Write-Output "SHA256: $hash"
} finally {
    # Only remove the unique staging directory created inside this project's dist.
    $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
    $allowedPrefix = [IO.Path]::GetFullPath($distRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedStage.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Staging path escaped dist.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}

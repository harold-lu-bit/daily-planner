$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$pluginRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$outputDirectory = Join-Path $pluginRoot 'dist'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$archiveName = "$($manifest.id)-$($manifest.version).zip"
$archivePath = Join-Path $outputDirectory $archiveName
$licenses = foreach ($dependency in @('yaml', 'zod')) {
    $licenseFile = Get-ChildItem -LiteralPath (Join-Path $pluginRoot "node_modules/$dependency") -File |
        Where-Object { $_.Name -like 'LICENSE*' } | Select-Object -First 1
    if (!$licenseFile) { throw "Missing license: $dependency" }
    $dependency + "`n" + [IO.File]::ReadAllText($licenseFile.FullName)
}
# Explicit release allowlist: no configuration, credentials, caches or test notes.
$entries = @{
    'main.js' = "$($manifest.id)/main.js"
    'manifest.json' = "$($manifest.id)/manifest.json"
    'styles.css' = "$($manifest.id)/styles.css"
    'README.md' = 'README.md'
    'AGENTS.md' = 'AGENTS.md'
    'docs/VALIDATION.md' = 'docs/VALIDATION.md'
    'docs/REQUIREMENTS.md' = 'docs/REQUIREMENTS.md'
    'docs/INSTALL.md' = 'docs/INSTALL.md'
    'examples/Daily.md' = 'examples/Daily.md'
    'examples/plugin-settings.example.json' = 'examples/plugin-settings.example.json'
}
foreach ($source in $entries.Keys) {
    if (!(Test-Path -LiteralPath (Join-Path $pluginRoot $source))) { throw "Missing release file: $source" }
}
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create)
try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($source in $entries.Keys) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $pluginRoot $source), $entries[$source]) | Out-Null
        }
        $licenseEntry = $archive.CreateEntry('THIRD-PARTY-LICENSES.txt')
        $writer = [IO.StreamWriter]::new($licenseEntry.Open(), [Text.UTF8Encoding]::new($false))
        try { $writer.Write(($licenses -join "`n`n")) } finally { $writer.Dispose() }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }
$hashStream = [IO.File]::OpenRead($archivePath)
$hasher = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
finally { $hashStream.Dispose(); $hasher.Dispose() }
[IO.File]::WriteAllText((Join-Path $outputDirectory "$($manifest.id)-$($manifest.version).sha256"), "$digest  $archiveName`n", [Text.UTF8Encoding]::new($false))
Write-Output "Created $archivePath (sha256 $digest)"

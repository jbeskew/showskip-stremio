[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pluginFileName = 'ShowSkip.plugin.js'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))
$sourcePath = [System.IO.Path]::GetFullPath((Join-Path -Path $repositoryRoot -ChildPath $pluginFileName))

if (
    -not [System.StringComparer]::OrdinalIgnoreCase.Equals(
        [System.IO.Path]::GetDirectoryName($sourcePath),
        $repositoryRoot
    ) -or
    -not [System.StringComparer]::Ordinal.Equals(
        [System.IO.Path]::GetFileName($sourcePath),
        $pluginFileName
    )
) {
    throw 'Refusing to install from a path outside the repository root.'
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "ShowSkip plugin source was not found at the expected path: $sourcePath"
}

$sourceItem = Get-Item -LiteralPath $sourcePath -Force
if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to install from a reparse point: $sourcePath"
}

$appDataRoot = [Environment]::GetEnvironmentVariable('APPDATA')
if ([string]::IsNullOrWhiteSpace($appDataRoot) -or -not [System.IO.Path]::IsPathRooted($appDataRoot)) {
    throw 'APPDATA is missing or is not an absolute path.'
}

$appDataRoot = [System.IO.Path]::GetFullPath($appDataRoot)
if ([System.StringComparer]::OrdinalIgnoreCase.Equals($appDataRoot, [System.IO.Path]::GetPathRoot($appDataRoot))) {
    throw 'Refusing to use a filesystem root as APPDATA.'
}

$enhancedDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path -Path $appDataRoot -ChildPath 'stremio-enhanced')
)
$pluginDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path -Path $enhancedDirectory -ChildPath 'plugins')
)
$destinationPath = [System.IO.Path]::GetFullPath(
    (Join-Path -Path $pluginDirectory -ChildPath $pluginFileName)
)

function Assert-SafeExistingDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Refusing a non-directory path in the install destination: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a reparse point in the install destination: $Path"
    }
}

Assert-SafeExistingDirectory -Path $enhancedDirectory
Assert-SafeExistingDirectory -Path $pluginDirectory

if (
    -not [System.StringComparer]::OrdinalIgnoreCase.Equals(
        [System.IO.Path]::GetDirectoryName($destinationPath),
        $pluginDirectory
    ) -or
    -not [System.StringComparer]::Ordinal.Equals(
        [System.IO.Path]::GetFileName($destinationPath),
        $pluginFileName
    )
) {
    throw 'Refusing to install outside the exact Stremio Enhanced plugin destination.'
}

if (Test-Path -LiteralPath $destinationPath) {
    if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
        throw "Refusing to overwrite a non-file destination: $destinationPath"
    }

    $destinationItem = Get-Item -LiteralPath $destinationPath -Force
    if (($destinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to overwrite a reparse point: $destinationPath"
    }
}

New-Item -ItemType Directory -Path $pluginDirectory -Force | Out-Null
Assert-SafeExistingDirectory -Path $enhancedDirectory
Assert-SafeExistingDirectory -Path $pluginDirectory
Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force

if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
    throw "Installation did not produce the expected file: $destinationPath"
}

Write-Output "Installed ShowSkip.plugin.js to: $destinationPath"

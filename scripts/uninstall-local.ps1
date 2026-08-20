[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch]$RemoveSettings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptCmdlet = $PSCmdlet

$pluginFileName = 'ShowSkip.plugin.js'
$settingsFileName = 'ShowSkip.plugin.json'
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

function Assert-SafeExistingDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Refusing a non-directory path in the uninstall destination: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing a reparse point in the uninstall destination: $Path"
    }
}

Assert-SafeExistingDirectory -Path $enhancedDirectory
Assert-SafeExistingDirectory -Path $pluginDirectory

function Get-ExactShowSkipPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FileName
    )

    if ($FileName -cne $pluginFileName -and $FileName -cne $settingsFileName) {
        throw "Refusing unexpected ShowSkip filename: $FileName"
    }

    $candidate = [System.IO.Path]::GetFullPath(
        (Join-Path -Path $pluginDirectory -ChildPath $FileName)
    )

    if (
        -not [System.StringComparer]::OrdinalIgnoreCase.Equals(
            [System.IO.Path]::GetDirectoryName($candidate),
            $pluginDirectory
        ) -or
        -not [System.StringComparer]::Ordinal.Equals(
            [System.IO.Path]::GetFileName($candidate),
            $FileName
        )
    ) {
        throw "Refusing to remove a path outside the exact ShowSkip destination: $candidate"
    }

    return $candidate
}

function Remove-ExactShowSkipFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Output "Not found; no change: $Path"
        return
    }

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Refusing to remove a non-file path: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to remove a reparse point: $Path"
    }

    if ($scriptCmdlet.ShouldProcess($Path, "Remove $Description")) {
        Remove-Item -LiteralPath $Path -Force
        Write-Output "Removed: $Path"
    }
}

$pluginPath = Get-ExactShowSkipPath -FileName $pluginFileName
Remove-ExactShowSkipFile -Path $pluginPath -Description 'ShowSkip local plugin file'

$settingsPath = Get-ExactShowSkipPath -FileName $settingsFileName
if ($RemoveSettings) {
    Remove-ExactShowSkipFile -Path $settingsPath -Description 'ShowSkip generated settings file'
} else {
    Write-Output "Settings preserved (use -RemoveSettings to delete): $settingsPath"
}

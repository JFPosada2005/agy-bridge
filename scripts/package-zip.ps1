# agy-bridge release packaging (maintainer script, PowerShell 5.1 compatible).
#
# Builds a versioned ZIP of the tracked repo files via `git archive` plus a
# SHA256 sidecar file, ready to upload to the GitHub Releases page.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\package-zip.ps1

param(
    [string]$OutDir = (Join-Path (Get-Location) "artifacts")
)

try {
    # --- 1. Locate the repo root (this script lives in <root>\scripts) ---
    $RepoRoot = Split-Path -Parent $PSScriptRoot
    $GitDirCheck = (git -C $RepoRoot rev-parse --git-dir 2>&1 | Out-String).Trim()
    if (($LASTEXITCODE -ne 0) -or ([string]::IsNullOrEmpty($GitDirCheck))) {
        throw "Directory $RepoRoot is not a git repository."
    }
    Write-Host "Repo root: $RepoRoot"

    # --- 2. Short SHA for the zip name ---
    $ShortSha = (git -C $RepoRoot rev-parse --short HEAD 2>&1 | Out-String).Trim()
    if (($LASTEXITCODE -ne 0) -or ([string]::IsNullOrEmpty($ShortSha))) {
        throw "Could not determine the HEAD short SHA."
    }
    Write-Host "HEAD short SHA: $ShortSha"

    # --- 3. Output directory (resolve to an absolute path) ---
    if (-not [System.IO.Path]::IsPathRooted($OutDir)) {
        $OutDir = Join-Path (Get-Location) $OutDir
    }
    if (-not (Test-Path $OutDir)) {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        Write-Host "Created output directory: $OutDir"
    }

    # --- 4. Archive tracked files only (excludes .git, node_modules, dist, artifacts) ---
    $ZipName = "agy-bridge-$ShortSha.zip"
    $ZipPath = Join-Path $OutDir $ZipName
    Write-Host "Creating $ZipPath ..."
    git -C $RepoRoot archive --format=zip --output "$ZipPath" HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "git archive failed (exit code $LASTEXITCODE)."
    }
    Write-Host "Archive created: $ZipPath"

    # --- 5. SHA256 sidecar in standard shasum format ---
    # lowercase hex + single LF newline so `sha256sum -c` / `shasum -c` both
    # accept the file (Set-Content would emit CRLF; uppercase hashes are
    # inconsistent across tools).
    $ZipSizeKb = [math]::Round(((Get-Item $ZipPath).Length / 1KB), 1)
    $ZipHash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $SidecarPath = "$ZipPath.sha256"
    [System.IO.File]::WriteAllText($SidecarPath, "$ZipHash  $ZipName`n", [System.Text.Encoding]::ASCII)
    Write-Host "Zip path: $ZipPath"
    Write-Host "Size: $ZipSizeKb KB"
    Write-Host "SHA256: $ZipHash"
    Write-Host "Sidecar: $SidecarPath"
    Write-Host "Upload both files ($ZipName and $ZipName.sha256) to the GitHub Releases page."
}
catch {
    Write-Host ("agy-bridge packaging failed: " + $_.Exception.Message)
    exit 1
}

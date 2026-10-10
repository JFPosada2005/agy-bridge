# agy-bridge Windows installer (PowerShell 5.1 compatible).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Ref v0.1.1]
#
# The script is idempotent: re-running it updates the checkout to -Ref,
# rebuilds, refreshes the plugin copy, and re-registers the AGY_BRIDGE_REPO
# and AGY_BRIDGE_NODE env vars. It never starts the daemon itself (the
# opencode watchdog does that on restart).
#
# Security (audit 2026-10-09): install a release TAG, not a moving branch,
# and prefer "download, read, verify SHA256, run" over `irm | iex`.
# Release checklist: set the -Ref default below to the new tag BEFORE tagging.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoUrl = "https://github.com/JFPosada2005/agy-bridge.git",
    # Git ref to install: a release tag (recommended) or a branch name.
    [string]$Ref = "agy-bridge",
    [string]$TargetDir = (Join-Path $env:LOCALAPPDATA "agy-bridge")
)

try {
    # NOTE on execution contexts: under `iex` (the irm one-liner the README
    # recommends) the code runs as a bare script block, so BOTH $PSScriptRoot
    # and $PSCmdlet are $null. Every automatic variable must be guarded, and
    # ShouldProcess sites always proceed (WhatIf is only meaningful when the
    # script is invoked as a file with -WhatIf).
    function Test-CanProceed {
        param([string]$Target, [string]$Action)
        if ($PSCmdlet) { return $PSCmdlet.ShouldProcess($Target, $Action) }
        return $true
    }

    # --- 0. Prerequisite checks run FIRST in every mode (fail fast before any
    # git traffic or files are downloaded) ---
    # a. Node.js check (the project engines.node field requires >= 24)
    $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $NodeCmd) {
        throw "Node.js 24+ is required but 'node' was not found on PATH. Install it from https://nodejs.org and re-run this script."
    }
    $NodeVersion = (node -v 2>&1 | Out-String).Trim()
    $NodeMajor = 0
    if ($NodeVersion -match "^v(\d+)\.") {
        $NodeMajor = [int]$Matches[1]
    }
    if ($NodeMajor -lt 24) {
        throw "Node.js 24+ is required but found $NodeVersion. Install a newer Node.js from https://nodejs.org and re-run this script."
    }
    Write-Host "Node.js check passed: $NodeVersion"

    # b. Antigravity (agy) CLI check
    $AgyExe = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
    if (-not (Test-Path $AgyExe)) {
        throw "Antigravity CLI not found at $AgyExe. Install and sign in to the Antigravity desktop app so the agy CLI exists, then re-run this script."
    }
    Write-Host "Antigravity CLI check passed: $AgyExe"

    # --- 1. Source-mode detection: running from inside an extracted repo? ---
    # NOTE: under `irm https://... | iex` there is no $PSScriptRoot at all (the
    # code arrives as a plain string) — the binding below MUST stay guarded or
    # the one-liner fails before clone mode can even start.
    $RepoRoot = $null
    if ($PSScriptRoot) {
        $ScriptParent = Split-Path -Parent $PSScriptRoot
        if ((Test-Path (Join-Path $ScriptParent "package.json")) -and
            (Test-Path (Join-Path $ScriptParent "plugins\agy-bridge.ts"))) {
            $RepoRoot = $ScriptParent
            Write-Host "Source mode: using local repo folder $RepoRoot (skipping git operations)."
        }
    }
    # BUGFIX (audit 2026-10-09): a script file downloaded on its own (the
    # safe "read it first" flow) has $PSScriptRoot but no repo around it; it
    # must fall back to clone mode instead of failing with a null path.
    if (-not $RepoRoot) {
        # --- 2. Clone mode: git is required ---
        $GitCmd = Get-Command git -ErrorAction SilentlyContinue
        if (-not $GitCmd) {
            throw "Git was not found. Install Git from https://git-scm.com or download the repo ZIP from the GitHub Releases page and run this script from inside the extracted folder."
        }
        if (Test-Path $TargetDir) {
            if (Test-Path (Join-Path $TargetDir ".git")) {
                Write-Host "Updating existing checkout at $TargetDir to $Ref ..."
                if (Test-CanProceed $TargetDir "git fetch + checkout $Ref") {
                    git -C $TargetDir fetch --depth 1 origin $Ref
                    if ($LASTEXITCODE -ne 0) {
                        throw "git fetch of '$Ref' failed in $TargetDir (exit code $LASTEXITCODE)."
                    }
                    # No --force: local edits in the install dir stop the
                    # update instead of being silently discarded.
                    git -C $TargetDir checkout --detach FETCH_HEAD
                    if ($LASTEXITCODE -ne 0) {
                        throw "git checkout of '$Ref' failed in $TargetDir (exit code $LASTEXITCODE). Commit or remove local changes there, then re-run."
                    }
                }
                Write-Host "Checkout updated: $TargetDir ($Ref)"
            }
            else {
                throw "Target directory $TargetDir exists but is not a git repository. Move or remove it, then re-run this script."
            }
        }
        else {
            Write-Host "Cloning $RepoUrl ($Ref) to $TargetDir ..."
            if (Test-CanProceed $TargetDir "git clone $RepoUrl") {
                git clone --depth 1 --branch $Ref $RepoUrl $TargetDir
                if ($LASTEXITCODE -ne 0) {
                    throw "git clone of '$Ref' failed (exit code $LASTEXITCODE)."
                }
            }
            Write-Host "Cloned: $TargetDir"
        }
        $RepoRoot = $TargetDir
    }

    # --- 3. Build (two separate commands; PowerShell 5.1 has no && chaining) ---
    $PluginSrc = Join-Path $RepoRoot "plugins\agy-bridge.ts"
    if (-not (Test-Path $PluginSrc)) {
        throw "Plugin source not found at $PluginSrc. The repo checkout looks incomplete."
    }
    Write-Host "Running npm ci in $RepoRoot ..."
    Push-Location $RepoRoot
    try {
        # npm ci installs exactly what package-lock.json pins (and fails if
        # the lockfile is out of sync) instead of re-resolving ranges.
        if (Test-CanProceed $RepoRoot "npm ci") {
            npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "npm ci failed in $RepoRoot (exit code $LASTEXITCODE)."
            }
        }
        Write-Host "Dependencies installed."
        Write-Host "Running npm run build in $RepoRoot ..."
        if (Test-CanProceed $RepoRoot "npm run build") {
            npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed in $RepoRoot (exit code $LASTEXITCODE)."
            }
        }
        Write-Host "Build completed."
    }
    finally {
        Pop-Location
    }

    # --- 6. Plugin deploy (copy only when the content changed) ---
    $PluginDir = Join-Path $env:USERPROFILE ".config\opencode\plugin"
    $PluginDst = Join-Path $PluginDir "agy-bridge.ts"
    if (-not (Test-Path $PluginDir)) {
        if (Test-CanProceed $PluginDir "Create plugin directory") {
            New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
        }
        Write-Host "Created plugin directory: $PluginDir"
    }
    $CopyNeeded = $true
    if (Test-Path $PluginDst) {
        $SrcHash = (Get-FileHash -Path $PluginSrc -Algorithm SHA256).Hash
        $DstHash = (Get-FileHash -Path $PluginDst -Algorithm SHA256).Hash
        if ($SrcHash -eq $DstHash) {
            $CopyNeeded = $false
            Write-Host "Plugin already up to date: $PluginDst"
        }
    }
    if ($CopyNeeded) {
        if (Test-CanProceed $PluginDst "Copy plugin file") {
            Copy-Item -Path $PluginSrc -Destination $PluginDst -Force
        }
        Write-Host "Plugin updated: $PluginDst"
    }

    # --- 7. Env registration (idempotent) ---
    if (Test-CanProceed "AGY_BRIDGE_REPO=$RepoRoot" "Set user environment variable") {
        [Environment]::SetEnvironmentVariable("AGY_BRIDGE_REPO", $RepoRoot, "User")
    }
    Write-Host "Registered AGY_BRIDGE_REPO=$RepoRoot for the current user."
    # The plugin spawns the daemon with this node.exe; its built-in default
    # (C:\Program Files\nodejs\node.exe) misses nvm/fnm/scoop installs.
    $NodeExe = $NodeCmd.Source
    if (Test-CanProceed "AGY_BRIDGE_NODE=$NodeExe" "Set user environment variable") {
        [Environment]::SetEnvironmentVariable("AGY_BRIDGE_NODE", $NodeExe, "User")
    }
    Write-Host "Registered AGY_BRIDGE_NODE=$NodeExe for the current user."

    # --- 8. Summary ---
    Write-Host ""
    Write-Host "agy-bridge install complete."
    Write-Host "Repo: $RepoRoot"
    Write-Host "Plugin: $PluginDst"
    Write-Host "Next: restart opencode so it loads the plugin."
    Write-Host "The daemon serves 127.0.0.1:41667 (check GET /healthz)."
    Write-Host ("Request log: " + (Join-Path $env:USERPROFILE ".agy-bridge\bridge.log"))
}
catch {
    Write-Host ("agy-bridge install failed: " + $_.Exception.Message)
    # Run as a file: exit code 1. Pasted as `irm | iex` into an open window:
    # `exit` would close that window, so just stop.
    if ($PSCommandPath) { exit 1 }
    return
}

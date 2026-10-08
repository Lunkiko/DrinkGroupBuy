[CmdletBinding()]
param(
  [int]$Port = 3000
)

# One-click update for the school VM (C:\apps\DrinkGroupBuy): pull the latest code, reinstall
# dependencies only when the lockfile changed, restart the backend, then confirm /health.
# Messages are ASCII on purpose -- Windows PowerShell 5.1 misreads a non-BOM UTF-8 script on a
# Simplified-Chinese Windows and would print garbage.
#
# Deliberately NOT done here: database migrations. database/migrate.js needs DATABASE_URL in the
# shell and mutates the database, so this script only warns when migrations changed.

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step {
  param([string]$Message)
  Write-Host "[update-vm] $Message" -ForegroundColor Cyan
}

function Stop-Update {
  param([string]$Message)
  Write-Host "[update-vm] STOPPED: $Message" -ForegroundColor Red
  exit 1
}

function Invoke-Git {
  param([string[]]$Arguments)
  $output = & git -C $projectRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    Stop-Update "git $($Arguments -join ' ') failed (exit $LASTEXITCODE)."
  }
  return $output
}

# Deliberately its own small copy, not dot-sourced from scripts/dev-common.ps1 (which
# scripts/dev-console.ps1 also uses this exact same match from): this script updates the classroom
# VM and has no other reason to depend on local-dev-console state (mobile paths, ports, etc.) --
# pulling in the whole shared module would couple two genuinely unrelated workflows, so the small
# duplication is kept instead. If the backend's start command ever changes, both copies need
# updating by hand.
function Get-BackendProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'backend[\\/]server\.js' }
}

# --- Guards: refuse to touch a running server unless the update can actually proceed ---
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Stop-Update "git is not installed or not on PATH."
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".git"))) {
  Stop-Update "$projectRoot is not a git clone, so it cannot pull updates. Clone the repo first."
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "backend\.env"))) {
  Stop-Update "backend\.env is missing. The backend would start without its secrets and settings."
}

# --- Pull (fast-forward only: never rewrites history, and git itself refuses to overwrite
# conflicting local edits -- both failures happen before the running backend is touched) ---
$oldHead = (Invoke-Git @("rev-parse", "HEAD")).Trim()
Write-Step "Pulling latest code from origin..."
Invoke-Git @("pull", "--ff-only") | Out-Host
$newHead = (Invoke-Git @("rev-parse", "HEAD")).Trim()

$changedFiles = @()
if ($oldHead -ne $newHead) {
  $changedFiles = @(Invoke-Git @("diff", "--name-only", $oldHead, $newHead))
  Write-Step "Updated $($oldHead.Substring(0, 7)) -> $($newHead.Substring(0, 7)) ($($changedFiles.Count) files changed)."
} else {
  Write-Step "Already up to date ($($newHead.Substring(0, 7))); restarting anyway."
}

# --- If the backend runs as the DrinkGroupBuyBackend scheduled task (scripts\install-vm-service.ps1), stop the
# task first: killing only the node process would make the task's "restart on failure" start it again while
# files are being replaced. ---
$serviceTaskName = "DrinkGroupBuyBackend"
$serviceTask = Get-ScheduledTask -TaskName $serviceTaskName -ErrorAction SilentlyContinue
if ($serviceTask) {
  Write-Step "Stopping the $serviceTaskName scheduled task..."
  Stop-ScheduledTask -TaskName $serviceTaskName -ErrorAction SilentlyContinue
}

# --- Stop the running backend (before npm ci, which cannot replace files node is holding) ---
$running = @(Get-BackendProcesses)
if ($running.Count -gt 0) {
  Write-Step "Stopping the running backend (PID $($running.ProcessId -join ', '))..."
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-BackendProcesses) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
  }
} else {
  Write-Step "No running backend found; starting a fresh one."
}

# --- Dependencies: only when the lockfile moved ---
if ($changedFiles -contains "package-lock.json" -or $changedFiles -contains "package.json") {
  Write-Step "package files changed; running npm ci..."
  Push-Location $projectRoot
  try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) {
      Stop-Update "npm ci failed (exit $LASTEXITCODE). The backend is stopped; fix this and rerun."
    }
  } finally {
    Pop-Location
  }
}

# --- Start: through the scheduled task when it exists (survives logoff and reboot, logs go to
# logs\backend.log), otherwise in its own console window so the logs stay visible ---
if ($serviceTask) {
  Write-Step "Starting the backend through the $serviceTaskName scheduled task..."
  Start-ScheduledTask -TaskName $serviceTaskName
} else {
  Write-Step "Starting the backend in a new window..."
  $startCommand = '$Host.UI.RawUI.WindowTitle = ''DrinkGroupBuy Backend''; npm.cmd run backend:start'
  Start-Process -FilePath "powershell.exe" -WorkingDirectory $projectRoot `
    -ArgumentList @("-NoExit", "-NoProfile", "-Command", $startCommand)
}

# --- Health check ---
$healthUrl = "http://127.0.0.1:$Port/health"
$healthDeadline = (Get-Date).AddSeconds(40)
$healthy = $false
while (-not $healthy -and (Get-Date) -lt $healthDeadline) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    $healthy = [bool]$health.ok
  } catch {
    # Backend still booting; keep polling until the deadline.
  }
}
if (-not $healthy) {
  Stop-Update "No healthy response from $healthUrl within 40 s. Check the 'DrinkGroupBuy Backend' window."
}

Write-Step "Backend is healthy at $healthUrl"
if ($changedFiles | Where-Object { $_ -like "database/migrations/*" }) {
  Write-Host "[update-vm] WARNING: this update changed database/migrations. Back up, then run 'npm run postgres:migrate' with the right DATABASE_URL, or the new code may not match the schema." -ForegroundColor Yellow
}
Write-Host "[update-vm] Done." -ForegroundColor Green

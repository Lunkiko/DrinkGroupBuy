# Registers the DrinkGroupBuy backend on the school Windows VM as a scheduled task that starts at boot
# (no one has to be logged in) and restarts itself after a crash. Run as Administrator.
#
#   powershell -ExecutionPolicy Bypass -File .\install-vm-service.ps1              install or reinstall, then start
#   powershell -ExecutionPolicy Bypass -File .\install-vm-service.ps1 -DryRun      only print what would happen
#   powershell -ExecutionPolicy Bypass -File .\install-vm-service.ps1 -Uninstall   remove the task
#
# Why a scheduled task and not a Windows service: a service needs a wrapper program (for example NSSM),
# which would be an extra download to trust. A task running as SYSTEM with "at startup" and "restart on
# failure" uses only what Windows already ships, and scripts\update-vm-server.ps1 knows how to restart it.
#
# Messages are ASCII on purpose (Windows PowerShell 5.1 on a Chinese-locale Windows misreads a UTF-8
# script without a BOM).

param(
  [string]$ProjectPath = "C:\apps\DrinkGroupBuy",
  [int]$Port = 3000,
  [string]$TaskName = "DrinkGroupBuyBackend",
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Message) Write-Host "[install-vm-service] $Message" -ForegroundColor Cyan }
function Stop-Install {
  param([string]$Message)
  Write-Host "[install-vm-service] STOPPED: $Message" -ForegroundColor Red
  exit 1
}
function Invoke-Action {
  # Runs the action, or only prints it in -DryRun mode.
  param([string]$Description, [scriptblock]$Action)
  if ($DryRun) { Write-Host "[dry-run] $Description" -ForegroundColor Yellow; return }
  Write-Step $Description
  & $Action
}

function Get-BackendProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'backend[\\/]server\.js' }
}

# --- Guards -----------------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) { Stop-Install "Run this in a PowerShell window opened with 'Run as administrator'." }

# --- Uninstall ----------------------------------------------------------------------------------
if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) { Write-Step "Task $TaskName does not exist; nothing to remove."; exit 0 }
  Invoke-Action "Stopping and removing the task $TaskName" {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Get-BackendProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  }
  Write-Step "Done. The backend no longer starts at boot."
  exit 0
}

# --- Install ------------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $ProjectPath)) { Stop-Install "$ProjectPath does not exist. Clone the repository there first." }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath "backend\server.js"))) { Stop-Install "backend\server.js not found under $ProjectPath." }
$envFile = Join-Path $ProjectPath "backend\.env"
if (-not (Test-Path -LiteralPath $envFile)) { Stop-Install "backend\.env is missing. The backend would start without its settings (see docs\school-vm-deployment.md)." }

# The port the task starts the backend on is whatever backend\.env says; warn if it disagrees with -Port.
$portLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -First 1
$configuredPort = if ($portLine) { ($portLine -split '=', 2)[1].Trim() } else { "(not set)" }
if ($configuredPort -ne "$Port") { Write-Host "[install-vm-service] WARNING: backend\.env has PORT=$configuredPort but -Port is $Port. The health check and firewall rule use -Port." -ForegroundColor Yellow }

$devModeLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*AUTH_DEV_MODE\s*=\s*true\s*$' } | Select-Object -First 1
if ($devModeLine) { Stop-Install "backend\.env has AUTH_DEV_MODE=true. This VM has a public IP; the developer login must be off. Set AUTH_DEV_MODE=false." }

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { Stop-Install "node.exe is not on PATH. Install Node.js 24.x first." }
$nodeExe = $nodeCommand.Source

$logDir = Join-Path $ProjectPath "logs"
$logFile = Join-Path $logDir "backend.log"
Write-Step "Project: $ProjectPath | node: $nodeExe | port: $Port | log: $logFile"

Invoke-Action "Creating the log folder $logDir" { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

$ruleName = "DrinkGroupBuy Backend $Port"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  Invoke-Action "Adding the inbound firewall rule '$ruleName' (TCP $Port)" {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  }
} else {
  Write-Step "Firewall rule '$ruleName' already exists."
}

# cmd.exe is only used for the >> redirection into the log file. The outer pair of quotes after /c is stripped
# by cmd, which is what lets the inner quoted paths survive.
$argument = '/c ""' + $nodeExe + '" backend\server.js >> "' + $logFile + '" 2>&1"'
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $argument -WorkingDirectory $ProjectPath
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Invoke-Action "Replacing the existing task $TaskName" {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}
Invoke-Action "Registering the task $TaskName (starts at boot as SYSTEM, restarts every 1 minute after a crash)" {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "DrinkGroupBuy backend (node backend\server.js). Log: $logFile" | Out-Null
}

# A backend someone started by hand in a window would hold the port; stop it so the task can take over.
$manual = @(Get-BackendProcesses)
if ($manual.Count -gt 0) {
  Invoke-Action "Stopping the backend that is already running by hand (PID $($manual.ProcessId -join ', '))" {
    $manual | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
  }
}

Invoke-Action "Starting the task now" { Start-ScheduledTask -TaskName $TaskName }

if ($DryRun) { Write-Step "Dry run finished; nothing was changed."; exit 0 }

$healthUrl = "http://127.0.0.1:$Port/health"
$deadline = (Get-Date).AddSeconds(40)
$healthy = $false
while (-not $healthy -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  try { $healthy = [bool](Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3).ok } catch { }
}
if (-not $healthy) {
  Write-Host "[install-vm-service] No healthy answer from $healthUrl within 40 s. Last log lines:" -ForegroundColor Red
  if (Test-Path -LiteralPath $logFile) { Get-Content -LiteralPath $logFile -Tail 25 }
  exit 1
}
Write-Host "[install-vm-service] Backend is healthy at $healthUrl and will start automatically at boot." -ForegroundColor Green
Write-Host "[install-vm-service] Log file: $logFile"
exit 0

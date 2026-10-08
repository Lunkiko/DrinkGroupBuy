# Backs up the PostgreSQL database named in backend\.env (DATABASE_URL) to a compressed dump, keeps the last
# few days, and can register itself as a daily scheduled task. Run as Administrator on the school VM.
#
#   powershell -ExecutionPolicy Bypass -File .\backup-vm-database.ps1              one backup now
#   powershell -ExecutionPolicy Bypass -File .\backup-vm-database.ps1 -Register    daily backup at 03:00 (as SYSTEM)
#   powershell -ExecutionPolicy Bypass -File .\backup-vm-database.ps1 -DryRun      show what would happen
#
# Restore (replaces the data in the target database -- stop the backend first, back up first):
#   pg_restore -h localhost -U <user> -d <database> --clean --if-exists <dump file>
#
# The password is read from DATABASE_URL, handed to pg_dump through an environment variable for this one
# process, and never printed or written anywhere. Messages are ASCII on purpose (Windows PowerShell 5.1 on a
# Chinese-locale Windows misreads a UTF-8 script without a BOM).

param(
  [string]$ProjectPath = "C:\apps\DrinkGroupBuy",
  [string]$BackupDir = "C:\apps\backups",
  [int]$KeepDays = 14,
  [switch]$Register,
  [string]$RunAt = "03:00",
  [string]$TaskName = "DrinkGroupBuyBackup",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Message) Write-Host "[backup-vm-database] $Message" -ForegroundColor Cyan }
function Stop-Backup {
  param([string]$Message)
  Write-Host "[backup-vm-database] STOPPED: $Message" -ForegroundColor Red
  exit 1
}

# --- Register the daily task (does not back up by itself) ----------------------------------------
if ($Register) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin -and -not $DryRun) { Stop-Backup "Run this in a PowerShell window opened with 'Run as administrator'." }
  $scriptPath = $MyInvocation.MyCommand.Path
  $argument = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '" -ProjectPath "' + $ProjectPath + '" -BackupDir "' + $BackupDir + '" -KeepDays ' + $KeepDays
  if ($DryRun) {
    Write-Host "[dry-run] Would register task ${TaskName}: daily at $RunAt as SYSTEM -> powershell.exe $argument" -ForegroundColor Yellow
    exit 0
  }
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
  $trigger = New-ScheduledTaskTrigger -Daily -At $RunAt
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "Daily pg_dump of the DrinkGroupBuy database into $BackupDir (keeps $KeepDays days)." | Out-Null
  Write-Step "Registered ${TaskName}: daily at $RunAt, dumps go to $BackupDir, kept for $KeepDays days."
  exit 0
}

# --- Read the connection from backend\.env -------------------------------------------------------
$envFile = Join-Path $ProjectPath "backend\.env"
if (-not (Test-Path -LiteralPath $envFile)) { Stop-Backup "$envFile not found." }
$urlLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
if (-not $urlLine) { Stop-Backup "DATABASE_URL is not set in backend\.env." }
$rawUrl = ($urlLine -split '=', 2)[1].Trim().Trim('"').Trim("'")

try { $uri = [Uri]$rawUrl } catch { Stop-Backup "DATABASE_URL is not a valid URL." }
if ($uri.Scheme -notin @("postgres", "postgresql")) { Stop-Backup "DATABASE_URL must start with postgres:// or postgresql://." }
$userInfo = $uri.UserInfo -split ':', 2
$dbUser = [Uri]::UnescapeDataString($userInfo[0])
$dbPassword = if ($userInfo.Count -gt 1) { [Uri]::UnescapeDataString($userInfo[1]) } else { "" }
$dbHost = $uri.Host
$dbPort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
$dbName = $uri.AbsolutePath.TrimStart('/')
if (-not $dbName) { Stop-Backup "DATABASE_URL has no database name." }

# --- Find pg_dump ---------------------------------------------------------------------------------
$pgDump = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source
if (-not $pgDump) {
  $pgDump = Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "bin\pg_dump.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $pgDump) { Stop-Backup "pg_dump.exe not found. Install PostgreSQL (with the command line tools) or add its bin folder to PATH." }
$pgRestore = Join-Path (Split-Path -Parent $pgDump) "pg_restore.exe"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpFile = Join-Path $BackupDir "drink-group-buy-$stamp.dump"
Write-Step "Database $dbName on ${dbHost}:$dbPort as $dbUser -> $dumpFile"
if ($DryRun) {
  Write-Host "[dry-run] Would run: pg_dump -Fc -h $dbHost -p $dbPort -U $dbUser -f $dumpFile $dbName, check it with pg_restore -l, and delete dumps older than $KeepDays days." -ForegroundColor Yellow
  exit 0
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

# Options must come BEFORE the database name: the Windows build of pg_dump stops parsing options at the
# first positional argument.
$env:PGPASSWORD = $dbPassword
try {
  & $pgDump -Fc -h $dbHost -p $dbPort -U $dbUser -f $dumpFile $dbName
  $dumpExit = $LASTEXITCODE
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
if ($dumpExit -ne 0) {
  Remove-Item -LiteralPath $dumpFile -Force -ErrorAction SilentlyContinue
  Stop-Backup "pg_dump failed (exit $dumpExit). Nothing was kept."
}

# A dump that cannot be listed is not a backup.
$tables = @(& $pgRestore -l $dumpFile 2>$null | Where-Object { $_ -match 'TABLE DATA' }).Count
$sizeKb = [math]::Round((Get-Item -LiteralPath $dumpFile).Length / 1KB)
if ($tables -eq 0 -or $sizeKb -eq 0) {
  Remove-Item -LiteralPath $dumpFile -Force -ErrorAction SilentlyContinue
  Stop-Backup "The dump looks empty or unreadable ($tables tables, $sizeKb KB). It was deleted."
}
Write-Step "Backup OK: $sizeKb KB, $tables tables."

$cutoff = (Get-Date).AddDays(-$KeepDays)
$old = @(Get-ChildItem -LiteralPath $BackupDir -Filter "drink-group-buy-*.dump" | Where-Object { $_.LastWriteTime -lt $cutoff })
foreach ($file in $old) { Remove-Item -LiteralPath $file.FullName -Force }
if ($old.Count -gt 0) { Write-Step "Removed $($old.Count) dump(s) older than $KeepDays days." }
exit 0

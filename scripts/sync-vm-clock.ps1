# Keeps the school VM's clock correct WITHOUT NTP. The school network drops the packets Windows Time needs
# (observed 2026-10-12: w32tm /stripchart works, but the w32time service never gets a reply and the peer is
# suspended), so the clock drifted by 4.5 minutes in a few days. HTTPS works, and every HTTPS response carries
# a Date header, so this script reads the time from several independent HTTPS hosts and corrects the clock.
#
#   powershell -ExecutionPolicy Bypass -File .\sync-vm-clock.ps1                 measure and correct once
#   powershell -ExecutionPolicy Bypass -File .\sync-vm-clock.ps1 -DryRun         measure only, never touches the clock
#   powershell -ExecutionPolicy Bypass -File .\sync-vm-clock.ps1 -Register       run at boot and every 15 minutes (admin)
#   powershell -ExecutionPolicy Bypass -File .\sync-vm-clock.ps1 -Unregister     remove that task (admin)
#
# Safety rules (the clock feeds group-buy deadlines and settlement, so a wrong correction is worse than none):
#   - at least 2 sources must answer; sources more than 3 seconds away from the median are ignored as outliers (a
#     cached or broken host), and a majority of the answering sources must agree, otherwise nothing changes
#   - the median offset of the agreeing sources is used, so one odd host cannot move the clock
#   - offsets within -ThresholdSeconds (default 2) are left alone
#   - offsets larger than -MaxAdjustSeconds (default 12 hours) are refused and logged: a human has to look at it
#   - the time zone is only reported, never changed
#
# Messages are ASCII on purpose (Windows PowerShell 5.1 on a Chinese-locale Windows misreads a UTF-8 script
# without a BOM).

param(
  [switch]$Register,
  [switch]$Unregister,
  [switch]$DryRun,
  [double]$ThresholdSeconds = 2,
  [double]$MaxAdjustSeconds = 43200,
  [int]$EveryMinutes = 15,
  [string]$TaskName = "DrinkGroupBuyClockSync",
  [string]$LogFile = "C:\apps\DrinkGroupBuy\logs\clock-sync.log",
  [string[]]$Sources = @("https://www.google.com", "https://oauth2.googleapis.com", "https://exp.host", "https://www.microsoft.com")
)

$ErrorActionPreference = "Stop"
$maxSpreadSeconds = 3
$maxLogBytes = 1MB

function Write-ClockLog {
  param([string]$Message, [string]$Color = "Gray")
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line -ForegroundColor $Color
  try {
    $logDir = Split-Path -Parent $LogFile
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt $maxLogBytes)) {
      Move-Item -LiteralPath $LogFile -Destination ($LogFile + ".old") -Force
    }
    Add-Content -LiteralPath $LogFile -Value $line
  } catch {
    Write-Host "(could not write the log file: $($_.Exception.Message))" -ForegroundColor Yellow
  }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# --- Unregister -----------------------------------------------------------------------------------
if ($Unregister) {
  if (-not $isAdmin) { Write-ClockLog "STOPPED: run this in a PowerShell window opened with 'Run as administrator'." "Red"; exit 1 }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-ClockLog "Removed the task $TaskName." "Cyan"
  } else {
    Write-ClockLog "Task $TaskName does not exist; nothing to remove." "Cyan"
  }
  exit 0
}

# --- Register -------------------------------------------------------------------------------------
if ($Register) {
  if (-not $isAdmin -and -not $DryRun) { Write-ClockLog "STOPPED: run this in a PowerShell window opened with 'Run as administrator'." "Red"; exit 1 }
  $scriptPath = $MyInvocation.MyCommand.Path
  $argument = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '" -LogFile "' + $LogFile + '"'
  if ($DryRun) {
    Write-ClockLog "[dry-run] Would register ${TaskName}: at boot (1 minute delay) and every $EveryMinutes minutes as SYSTEM -> powershell.exe $argument" "Yellow"
    exit 0
  }
  $clockAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
  $bootTrigger = New-ScheduledTaskTrigger -AtStartup
  $bootTrigger.Delay = "PT1M"
  $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
  $clockPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $clockSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Register-ScheduledTask -TaskName $TaskName -Action $clockAction -Trigger @($bootTrigger, $repeatTrigger) -Principal $clockPrincipal -Settings $clockSettings `
    -Description "Corrects the VM clock from HTTPS Date headers (the school network blocks NTP). Log: $LogFile" | Out-Null
  Write-ClockLog "Registered ${TaskName}: at boot and every $EveryMinutes minutes as SYSTEM. Log: $LogFile" "Cyan"
  exit 0
}

# --- Measure ----------------------------------------------------------------------------------------
# Offset = local clock minus true time, in seconds (positive = this machine is too fast). The Date header is
# truncated to whole seconds, so the true time is about half a second later than it says; the local time is
# taken at the middle of the request to cancel half of the network delay. A cached response carries the time
# the ORIGIN made it, so the Age header (seconds spent in a cache) is added back. Any HTTP status is fine as long
# as the reply has a Date header (a 404 from an API host is still a valid clock reading).
function Get-HeaderText {
  param($Headers, [string]$Name)
  try { return [string]$Headers[$Name] } catch { return $null }
}

function Get-ClockOffsetSeconds {
  param([string]$Url)
  $before = [DateTime]::UtcNow
  try {
    $replyHeaders = (Invoke-WebRequest -Uri $Url -UseBasicParsing -Method Head -TimeoutSec 10).Headers
  } catch {
    $errorResponse = $_.Exception.Response
    if (-not $errorResponse) { throw }
    $replyHeaders = $errorResponse.Headers
  }
  $after = [DateTime]::UtcNow
  $headerText = Get-HeaderText -Headers $replyHeaders -Name 'Date'
  if (-not $headerText) { throw "no Date header" }
  $ageSeconds = 0
  $ageText = Get-HeaderText -Headers $replyHeaders -Name 'Age'
  if ($ageText -and $ageText -match '^\d+$') { $ageSeconds = [int]$ageText }
  $serverTime = [DateTimeOffset]::Parse($headerText).UtcDateTime.AddSeconds($ageSeconds).AddMilliseconds(500)
  $localMiddle = $before.AddTicks([long](($after - $before).Ticks / 2))
  return ($localMiddle - $serverTime).TotalSeconds
}

function Get-MedianValue {
  param([double[]]$Values)
  $ordered = @($Values | Sort-Object)
  $mid = [int][math]::Floor(($ordered.Count - 1) / 2)
  if ($ordered.Count % 2 -eq 1) { return $ordered[$mid] }
  return ($ordered[$mid] + $ordered[$mid + 1]) / 2
}

$offsets = @()
$readings = @()
foreach ($source in $Sources) {
  try {
    $reading = Get-ClockOffsetSeconds -Url $source
    $offsets += $reading
    $readings += ("{0}={1:N1}s" -f $source, $reading)
  } catch {
    Write-ClockLog "source failed: $source ($($_.Exception.Message))" "Yellow"
  }
}
if ($readings.Count -gt 0) { Write-ClockLog ("readings (local minus source): " + ($readings -join "  ")) "DarkGray" }

if ($offsets.Count -lt 2) {
  Write-ClockLog "REFUSED: only $($offsets.Count) of $($Sources.Count) sources answered (need 2). The clock was not changed." "Red"
  exit 1
}

$answeredCount = $offsets.Count
$firstMedian = Get-MedianValue -Values $offsets
$agreeing = @($offsets | Where-Object { [math]::Abs($_ - $firstMedian) -le $maxSpreadSeconds })
if ($agreeing.Count -lt 2 -or ($agreeing.Count * 2) -le $answeredCount) {
  Write-ClockLog ("REFUSED: no agreement: only {0} of {1} answering sources are within {2} s of each other. The clock was not changed." -f $agreeing.Count, $answeredCount, $maxSpreadSeconds) "Red"
  exit 1
}
if ($agreeing.Count -lt $answeredCount) {
  Write-ClockLog ("ignored {0} outlier source(s) that were more than {1} s from the others" -f ($answeredCount - $agreeing.Count), $maxSpreadSeconds) "Yellow"
}

$offset = Get-MedianValue -Values $agreeing
$zoneId = (Get-TimeZone).Id

if ([math]::Abs($offset) -le $ThresholdSeconds) {
  Write-ClockLog ("OK: offset {0:N1} s (within {1} s), {2} sources, time zone {3}." -f $offset, $ThresholdSeconds, $offsets.Count, $zoneId) "Green"
  exit 0
}

if ([math]::Abs($offset) -gt $MaxAdjustSeconds) {
  Write-ClockLog ("REFUSED: offset {0:N1} s is larger than {1} s. The clock was not changed; fix it by hand (docs\school-vm-deployment.md)." -f $offset, $MaxAdjustSeconds) "Red"
  exit 1
}

$newTime = (Get-Date).AddSeconds(-$offset)
if ($DryRun) {
  Write-ClockLog ("[dry-run] Would correct the clock by {0:N1} s to {1} (time zone {2})." -f (-$offset), $newTime.ToString("yyyy-MM-dd HH:mm:ss"), $zoneId) "Yellow"
  exit 0
}
if (-not $isAdmin) { Write-ClockLog "STOPPED: changing the clock needs an administrator window." "Red"; exit 1 }
Set-Date -Date $newTime | Out-Null
Write-ClockLog ("CORRECTED: the clock was {0:N1} s off (positive = too fast); set to {1}, time zone {2}." -f $offset, $newTime.ToString("yyyy-MM-dd HH:mm:ss"), $zoneId) "Cyan"
exit 0

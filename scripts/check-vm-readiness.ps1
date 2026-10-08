# Read-only readiness check for the school Windows VM. Changes nothing, prints no secrets.
#
#   powershell -ExecutionPolicy Bypass -File .\check-vm-readiness.ps1
#
# Run it on the VM (Remote Desktop), then copy the whole output back. Every check prints
# [PASS], [WARN] or [FAIL] so the result can be read at a glance.
#
# Messages are ASCII on purpose: Windows PowerShell 5.1 on a Chinese-locale Windows misreads a
# UTF-8 script without a BOM (same reason as scripts/update-vm-server.ps1).

param(
  [string]$ProjectPath = "C:\apps\DrinkGroupBuy",
  [int[]]$BackendPorts = @(3000, 3001),
  [int]$TimeoutSec = 8
)

$ErrorActionPreference = "Continue"
$script:counts = @{ PASS = 0; WARN = 0; FAIL = 0 }

function Write-Result {
  param([string]$Level, [string]$Name, [string]$Detail = "")
  $script:counts[$Level]++
  $color = @{ PASS = "Green"; WARN = "Yellow"; FAIL = "Red" }[$Level]
  $line = "[{0}] {1}" -f $Level, $Name
  if ($Detail) { $line += " -- $Detail" }
  Write-Host $line -ForegroundColor $color
}

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "=== $Title ===" -ForegroundColor Cyan
}

# Older Windows PowerShell defaults to TLS 1.0/1.1, which most HTTPS sites now refuse.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

Write-Host "DrinkGroupBuy school VM readiness check  ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"

# ---------------------------------------------------------------- system
Write-Section "System"
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) { Write-Host ("OS: {0} (build {1}), {2}" -f $os.Caption, $os.BuildNumber, $os.OSArchitecture) }
Write-Host ("Computer name: {0}" -f $env:COMPUTERNAME)
Write-Host ("PowerShell: {0}" -f $PSVersionTable.PSVersion)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Write-Result PASS "Running as administrator" } else { Write-Result WARN "Not running as administrator" "needed later to open the firewall port, install PostgreSQL and register the auto-start task" }

$tz = (Get-TimeZone).Id
if ($tz -eq "Taipei Standard Time") { Write-Result PASS "Time zone" $tz } else { Write-Result WARN "Time zone is $tz" "the backend schedules deadlines and pickup windows by time; Taipei Standard Time is expected" }
Write-Host ("Clock now: {0}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"))

$drive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(":")) -ErrorAction SilentlyContinue
if ($drive) {
  $freeGb = [math]::Round($drive.Free / 1GB, 1)
  if ($freeGb -ge 5) { Write-Result PASS "Free disk space on $($env:SystemDrive)" "$freeGb GB" } else { Write-Result WARN "Free disk space on $($env:SystemDrive)" "$freeGb GB (low)" }
}

# ---------------------------------------------------------------- tools
Write-Section "Tools"
function Test-Tool {
  param([string]$Name, [string]$VersionArgs, [string]$Hint)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Result FAIL "$Name not found" $Hint; return $null }
  $ver = (& $cmd.Source $VersionArgs 2>&1 | Select-Object -First 1)
  Write-Result PASS "$Name found" "$ver"
  return $ver
}
$nodeVersion = Test-Tool "node" "--version" "install Node.js 24.x LTS (package.json engines requires 24.x)"
if ($nodeVersion -and ($nodeVersion -notmatch "^v24\.")) { Write-Result WARN "Node version is $nodeVersion" "this project declares node 24.x" }
Test-Tool "npm.cmd" "--version" "comes with Node.js" | Out-Null
Test-Tool "git" "--version" "install Git for Windows" | Out-Null

$pgBin = @(Get-ChildItem "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName "bin" } | Where-Object { Test-Path (Join-Path $_ "pg_dump.exe") }) | Select-Object -First 1
if ($pgBin) { Write-Result PASS "PostgreSQL client tools" $pgBin } else { Write-Result WARN "PostgreSQL tools not found in C:\Program Files\PostgreSQL" "PostgreSQL 16 must be installed on this VM, or the database must live elsewhere" }
$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
if ($pgService) { $pgService | ForEach-Object { Write-Result PASS "PostgreSQL service $($_.Name)" "$($_.Status)" } } else { Write-Result WARN "No PostgreSQL Windows service found" }

# ---------------------------------------------------------------- project
Write-Section "Project folder"
if (Test-Path -LiteralPath $ProjectPath) {
  Write-Result PASS "Project folder exists" $ProjectPath
  $head = (& git -C $ProjectPath log -1 --format="%h %ad %s" --date=short 2>&1 | Select-Object -First 1)
  Write-Host ("Latest commit on the VM: {0}" -f $head)
  if (Test-Path -LiteralPath (Join-Path $ProjectPath "backend\.env")) { Write-Result PASS "backend\.env present" "contents not printed" } else { Write-Result FAIL "backend\.env missing" "the backend would start without its settings" }
  if (Test-Path -LiteralPath (Join-Path $ProjectPath "node_modules")) { Write-Result PASS "node_modules present" } else { Write-Result WARN "node_modules missing" "run npm ci in the project folder" }
} else {
  Write-Result WARN "Project folder not found" "$ProjectPath (expected by scripts\update-vm-server.ps1; clone the repository there)"
}

$task = Get-ScheduledTask -TaskName "DrinkGroupBuyBackend" -ErrorAction SilentlyContinue
if ($task) { Write-Result PASS "Auto-start task DrinkGroupBuyBackend" "$($task.State)" } else { Write-Result WARN "No auto-start task yet" "the backend only runs while someone keeps its window open" }

# ---------------------------------------------------------------- network
Write-Section "Network addresses"
$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }
foreach ($a in $addresses) {
  $kind = if ($a.IPAddress -match "^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)") { "private (campus/LAN only)" } else { "PUBLIC" }
  Write-Host ("  {0,-18} {1,-16} {2}" -f $a.InterfaceAlias, $a.IPAddress, $kind)
}
$gateway = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
if ($gateway) { Write-Host ("Default gateway: {0}" -f $gateway.NextHop) }

Write-Section "Listening ports and firewall"
foreach ($port in (@($BackendPorts) + 5432 + 80 + 443 | Select-Object -Unique)) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    Write-Host ("  port {0}: LISTENING ({1}, bound to {2})" -f $port, $proc.ProcessName, $listener.LocalAddress)
  } else {
    Write-Host ("  port {0}: not listening" -f $port)
  }
}
# A rule opens the port for any program only if it names that exact port, or names no port AND no program.
# Rules that say "any port" but belong to one specific program (most of the 80+ default rules) do not count.
$inboundAllow = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue)
foreach ($port in $BackendPorts) {
  $matching = @()
  foreach ($rule in $inboundAllow) {
    $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    if (-not $portFilter -or $portFilter.Protocol -ne "TCP") { continue }
    if ($portFilter.LocalPort -eq "$port") { $matching += $rule; continue }
    if ($portFilter.LocalPort -eq "Any") {
      $appFilter = $rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
      if ($appFilter -and $appFilter.Program -eq "Any") { $matching += $rule }
    }
  }
  if ($matching.Count -gt 0) {
    Write-Result PASS "Inbound firewall allows TCP $port" ("rule(s): " + (($matching | Select-Object -First 3 | ForEach-Object { $_.DisplayName }) -join "; "))
  } else {
    Write-Result WARN "No inbound firewall rule for TCP $port" "phones on the campus network cannot reach the backend until one is added (profiles Domain/Private/Public are not distinguished here)"
  }
}

foreach ($port in $BackendPorts) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    if ($health.ok) { Write-Result PASS "Backend answers on 127.0.0.1:$port/health" "$($health.service)" }
  } catch {}
}

# ---------------------------------------------------------------- outbound
Write-Section "Outbound internet (what the backend and the install need)"
function Test-Outbound {
  param([string]$Name, [string]$Url, [string]$WhyItMatters)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
    Write-Result PASS $Name "HTTP $($response.StatusCode)"
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status) {
      # Any HTTP answer, even 401/403/404, proves the network path and TLS work.
      Write-Result PASS $Name "reachable (HTTP $status)"
    } else {
      Write-Result FAIL $Name "cannot connect: $($_.Exception.Message). $WhyItMatters"
    }
  }
}
Test-Outbound "GitHub (git pull)" "https://github.com" "updates by git pull will not work"
Test-Outbound "npm registry (npm ci)" "https://registry.npmjs.org/" "dependencies cannot be installed"
Test-Outbound "Firebase token verification" "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com" "Google sign-in will fail because the backend cannot verify Firebase tokens"
Test-Outbound "Expo push service" "https://exp.host/--/api/v2/push/send" "push notifications will not be delivered"
Test-Outbound "LINE Pay sandbox API" "https://sandbox-api-pay.line.me/" "LINE Pay sandbox payments will fail"

try {
  $publicIp = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec $TimeoutSec).ToString().Trim()
  Write-Host ("Public IP seen from the internet: {0}" -f $publicIp)
} catch {
  Write-Host "Public IP: could not be determined (outbound blocked or no internet)"
}

# ---------------------------------------------------------------- summary
Write-Section "Summary"
Write-Host ("PASS {0}   WARN {1}   FAIL {2}" -f $script:counts.PASS, $script:counts.WARN, $script:counts.FAIL)
Write-Host "Copy everything above and send it back."

# A report tool: never leave a stale exit code from the last native command behind.
exit 0

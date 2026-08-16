<#
.SYNOPSIS
    Installs HydroMonitor's FastAPI backend (main.py) as a Windows service via NSSM,
    so monitoring survives reboots, crashes, and closed terminals.

.DESCRIPTION
    Without this, the whole deployment is `python main.py` in a terminal window: a reboot,
    an accidental Ctrl-C, or an unhandled exception silently ends data collection, and the
    ESP32 keeps POSTing into a void. NSSM wraps the process with restart-on-failure and
    log redirection.

    Run from an ELEVATED PowerShell prompt (service installation requires admin):
        .\scripts\install-service.ps1

    Useful afterwards:
        nssm status  HydroMonitor
        nssm restart HydroMonitor
        nssm edit    HydroMonitor      # GUI for every setting below
        .\scripts\install-service.ps1 -Uninstall

    NSSM itself is not bundled -- install it first with `choco install nssm` or from
    https://nssm.cc/download and make sure nssm.exe is on PATH.

.NOTES
    AppDirectory matters: main.py resolves webconfig.json, calibration.json, history.db,
    and frontend/dist RELATIVE TO THE WORKING DIRECTORY. A service started in the wrong
    directory comes up "healthy" but serves no dashboard and writes its database somewhere
    unexpected.

    HYDRO_DEV is deliberately NOT set here -- see the autoreload comment in main.py.
#>
[CmdletBinding()]
param(
    [string] $ServiceName = 'HydroMonitor',
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's directory, so the script works from any cwd.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Python   = Join-Path $RepoRoot '.venv\Scripts\python.exe'
$LogDir   = Join-Path $RepoRoot 'logs'

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    throw "nssm.exe not found on PATH. Install it (choco install nssm) or add it to PATH, then re-run."
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must run from an elevated (Administrator) PowerShell prompt."
}

if ($Uninstall) {
    nssm stop   $ServiceName
    nssm remove $ServiceName confirm
    Write-Host "Removed service '$ServiceName'. Logs left in $LogDir." -ForegroundColor Yellow
    return
}

if (-not (Test-Path $Python)) {
    throw "Python interpreter not found at $Python. Create the venv first: python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
}
if (-not (Test-Path (Join-Path $RepoRoot 'frontend\dist'))) {
    Write-Warning "frontend\dist not found -- the service will start but '/' will 404 until you run: cd frontend; npm install; npm run build"
}
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

nssm install $ServiceName $Python 'main.py'
nssm set $ServiceName AppDirectory $RepoRoot
nssm set $ServiceName DisplayName  'HydroMonitor water quality backend'
nssm set $ServiceName Description  'FastAPI backend: ESP32 sensor ingestion, dashboard WebSocket fan-out, UDP discovery.'
nssm set $ServiceName Start        SERVICE_AUTO_START

# Restart on any unexpected exit, backing off 10s so a crash-loop does not spin the CPU.
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 10000

# Redirect stdout/stderr to files and rotate at ~10 MB -- main.py prints every reading,
# so an unrotated log grows without bound at one line per 2 seconds.
nssm set $ServiceName AppStdout       (Join-Path $LogDir 'hydromonitor.out.log')
nssm set $ServiceName AppStderr       (Join-Path $LogDir 'hydromonitor.err.log')
nssm set $ServiceName AppRotateFiles  1
nssm set $ServiceName AppRotateOnline 1
nssm set $ServiceName AppRotateBytes  10485760

# Force UTF-8: main.py prints emoji in its startup banner, and a service's stdout is not a
# console, so Python would otherwise pick cp1252 and raise UnicodeEncodeError on launch.
nssm set $ServiceName AppEnvironmentExtra 'PYTHONIOENCODING=utf-8' 'PYTHONUNBUFFERED=1'

nssm start $ServiceName

Write-Host ""
Write-Host "Service '$ServiceName' installed and started." -ForegroundColor Green
Write-Host "  Dashboard: http://localhost:8080/"
Write-Host "  Logs:      $LogDir"
Write-Host "  Status:    nssm status $ServiceName"
Write-Host ""
Write-Host "Reminder: UDP discovery needs an inbound firewall rule on port 8888 --" -ForegroundColor Yellow
Write-Host '  netsh advfirewall firewall add rule name="HydroMonitor UDP Discovery" dir=in action=allow protocol=UDP localport=8888' -ForegroundColor Yellow

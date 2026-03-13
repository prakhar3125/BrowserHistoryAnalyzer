# ================================================================
#  Chromium Forensics SOC -- Dev Environment Setup & Launcher
#  Usage: powershell -ExecutionPolicy Bypass -File start.ps1
# ================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------
#  Helpers
# ----------------------------------------------------------------
function Write-Banner {
    Clear-Host
    Write-Host ""
    Write-Host "  ================================================" -ForegroundColor Cyan
    Write-Host "   CHROMIUM FORENSICS SOC  --  Dev Launcher       " -ForegroundColor Cyan
    Write-Host "  ================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step   { param($msg) Write-Host "  >> $msg" -ForegroundColor Cyan }
function Write-Ok     { param($msg) Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn   { param($msg) Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Write-Fail   { param($msg) Write-Host "  XX  $msg" -ForegroundColor Red }
function Write-Info   { param($msg) Write-Host "      $msg" -ForegroundColor DarkGray }
function Write-Spacer {             Write-Host "" }

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Test-Command {
    param($cmd)
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ----------------------------------------------------------------
#  STEP 0 -- Execution policy
# ----------------------------------------------------------------
function Ensure-ExecutionPolicy {
    $policy = Get-ExecutionPolicy -Scope CurrentUser
    if ($policy -eq "Restricted" -or $policy -eq "AllSigned") {
        Write-Warn "Execution policy is '$policy'. Setting to RemoteSigned..."
        try {
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
            Write-Ok "Execution policy updated."
        } catch {
            Write-Warn "Could not update policy. Continuing anyway."
        }
    }
}

# ----------------------------------------------------------------
#  STEP 1 -- Project files
# ----------------------------------------------------------------
function Assert-ProjectFiles {
    Write-Step "Checking project files..."

    $required = @("server.py", "package.json")
    $missing  = @()

    foreach ($f in $required) {
        if (Test-Path $f) {
            Write-Ok "Found: $f"
        } else {
            $missing += $f
            Write-Fail "Missing: $f"
        }
    }

    if ($missing.Count -gt 0) {
        Write-Spacer
        Write-Fail "Required files missing. Run this script from the project root."
        Write-Info "  cd path\to\your\project"
        Write-Info "  powershell -ExecutionPolicy Bypass -File start.ps1"
        Write-Spacer
        Read-Host "Press Enter to exit"
        exit 1
    }

    if (-not (Test-Path "src\App.jsx")) {
        Write-Warn "src\App.jsx not found -- React frontend may not render."
    } else {
        Write-Ok "Found: src\App.jsx"
    }

    Write-Spacer
}

# ----------------------------------------------------------------
#  STEP 2 -- Python
# ----------------------------------------------------------------
function Ensure-Python {
    Write-Step "Checking Python..."

    $script:PythonCmd = $null

    foreach ($cmd in @("python", "python3", "py")) {
        if (Test-Command $cmd) {
            try {
                $ver = & $cmd --version 2>&1
                if ($ver -match "Python (\d+)\.(\d+)") {
                    $major = [int]$Matches[1]
                    $minor = [int]$Matches[2]
                    if ($major -ge 3 -and $minor -ge 8) {
                        $script:PythonCmd = $cmd
                        Write-Ok "Python found: $ver  (command: $cmd)"
                        break
                    } else {
                        Write-Warn "Python $ver is too old (need 3.8+). Will install newer."
                    }
                }
            } catch { }
        }
    }

    if (-not $script:PythonCmd) {
        Write-Warn "Python 3.8+ not found. Installing via winget..."

        if (-not (Test-Command "winget")) {
            Write-Fail "winget not available on this system."
            Write-Info "Install Python 3.11+ manually: https://www.python.org/downloads/"
            Read-Host "Press Enter to exit"
            exit 1
        }

        try {
            winget install Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
            Refresh-Path

            foreach ($cmd in @("python", "python3", "py")) {
                if (Test-Command $cmd) {
                    $ver = & $cmd --version 2>&1
                    if ($ver -match "Python 3\.") {
                        $script:PythonCmd = $cmd
                        Write-Ok "Python installed: $ver"
                        break
                    }
                }
            }

            if (-not $script:PythonCmd) {
                Write-Fail "Python installed but not found in PATH. Reopen terminal and retry."
                Read-Host "Press Enter to exit"
                exit 1
            }
        } catch {
            Write-Fail "winget install failed: $_"
            Write-Info "Install manually: https://www.python.org/downloads/"
            Read-Host "Press Enter to exit"
            exit 1
        }
    }

    Write-Spacer
}

# ----------------------------------------------------------------
#  STEP 3 -- Node.js
# ----------------------------------------------------------------
function Ensure-Node {
    Write-Step "Checking Node.js..."

    $nodeOk = $false

    if (Test-Command "node") {
        $nodeVer = & node --version 2>&1
        if ($nodeVer -match "v(\d+)") {
            $major = [int]$Matches[1]
            if ($major -ge 18) {
                Write-Ok "Node.js found: $nodeVer"
                $nodeOk = $true
            } else {
                Write-Warn "Node.js $nodeVer is too old (need 18+). Will install newer."
            }
        }
    }

    if (-not $nodeOk) {
        Write-Warn "Node.js 18+ not found. Installing via winget..."

        if (-not (Test-Command "winget")) {
            Write-Fail "winget not available."
            Write-Info "Install Node.js 20 LTS manually: https://nodejs.org/"
            Read-Host "Press Enter to exit"
            exit 1
        }

        try {
            winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
            Refresh-Path

            if (Test-Command "node") {
                $nodeVer = & node --version 2>&1
                Write-Ok "Node.js installed: $nodeVer"
            } else {
                Write-Fail "Node.js installed but not in PATH. Reopen terminal and retry."
                Read-Host "Press Enter to exit"
                exit 1
            }
        } catch {
            Write-Fail "winget install failed: $_"
            Write-Info "Install manually: https://nodejs.org/"
            Read-Host "Press Enter to exit"
            exit 1
        }
    }

    if (Test-Command "npm") {
        $npmVer = & npm --version 2>&1
        Write-Ok "npm found: v$npmVer"
    } else {
        Write-Fail "npm not found. Reinstall Node.js from https://nodejs.org/"
        Read-Host "Press Enter to exit"
        exit 1
    }

    Write-Spacer
}

# ----------------------------------------------------------------
#  STEP 4 -- Python packages
# ----------------------------------------------------------------
function Ensure-PythonPackages {
    Write-Step "Checking Python packages..."

    $packages = @(
        [PSCustomObject]@{ name = "flask";      import = "flask"      },
        [PSCustomObject]@{ name = "flask-cors"; import = "flask_cors" }
    )

    $toInstall = @()

    foreach ($pkg in $packages) {
        # Redirect stderr to null -- suppresses DeprecationWarnings from Flask 3.x
        $check = & $script:PythonCmd -W ignore -c "import $($pkg.import)" 2>$null
        if ($LASTEXITCODE -eq 0) {
            # Use importlib.metadata instead of .__version__ (works Flask 2.x and 3.x)
            $ver = & $script:PythonCmd -W ignore -c @"
try:
    import importlib.metadata
    print(importlib.metadata.version('$($pkg.name)'))
except Exception:
    print('installed')
"@ 2>$null
            Write-Ok "$($pkg.name) installed  (v$($ver.Trim()))"
        } else {
            Write-Warn "$($pkg.name) not found -- will install."
            $toInstall += $pkg.name
        }
    }

    if ($toInstall.Count -gt 0) {
        Write-Info "Installing: $($toInstall -join ', ')"
        try {
            $pipArgs = @("-m", "pip", "install", "--upgrade") + $toInstall
            & $script:PythonCmd @pipArgs
            if ($LASTEXITCODE -ne 0) { throw "pip exited with code $LASTEXITCODE" }
            Write-Ok "Python packages installed."
        } catch {
            Write-Fail "pip install failed: $_"
            Write-Info "Try manually: $script:PythonCmd -m pip install flask flask-cors"
            Read-Host "Press Enter to exit"
            exit 1
        }
    }

    Write-Spacer
}


# ----------------------------------------------------------------
#  STEP 5 -- npm install
# ----------------------------------------------------------------
function Ensure-NpmPackages {
    Write-Step "Checking npm packages..."

    $needsInstall = $false

    if (-not (Test-Path "node_modules")) {
        Write-Warn "node_modules not found -- running npm install."
        $needsInstall = $true
    } else {
        $pkgTime = (Get-Item "package.json").LastWriteTime
        $nmTime  = (Get-Item "node_modules").LastWriteTime
        if ($pkgTime -gt $nmTime) {
            Write-Warn "package.json is newer than node_modules -- running npm install."
            $needsInstall = $true
        } else {
            Write-Ok "node_modules is up-to-date."
        }
    }

    if ($needsInstall) {
        try {
            npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed with code $LASTEXITCODE" }
            Write-Ok "npm packages installed."
        } catch {
            Write-Fail "npm install failed: $_"
            Read-Host "Press Enter to exit"
            exit 1
        }
    }

    if (-not (Test-Path "node_modules\lucide-react")) {
        Write-Warn "lucide-react missing -- running npm install to fix..."
        npm install
    } else {
        Write-Ok "lucide-react present."
    }

    Write-Spacer
}

# ----------------------------------------------------------------
#  STEP 6 -- Port check
# ----------------------------------------------------------------
function Assert-PortFree {
    param([int]$Port)

    $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($inUse) {
        Write-Warn "Port $Port is already in use."
        $ans = Read-Host "    Kill the process on port $Port? [y/N]"
        if ($ans -match "^[Yy]") {
            $procId = ($inUse | Select-Object -First 1).OwningProcess
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Write-Ok "Process $procId killed. Port $Port is free."
        } else {
            Write-Warn "Skipped. server.py may fail to bind port $Port."
        }
    } else {
        Write-Ok "Port $Port is free."
    }
}

# ----------------------------------------------------------------
#  STEP 7 -- Launch servers via temp scripts (avoids string escaping)
# ----------------------------------------------------------------
function Start-Servers {
    Write-Step "Launching servers..."
    Write-Spacer

    $projectDir  = $PWD.Path
    $pythonCmd   = $script:PythonCmd

    # Write temp launcher for Flask
    $flaskScript = Join-Path $env:TEMP "chromium_forensics_flask.ps1"
    $flaskContent = @"
Set-Location '$projectDir'
`$Host.UI.RawUI.WindowTitle = 'Flask Backend -- port 5000'
Write-Host ''
Write-Host '  Flask Backend - server.py' -ForegroundColor Cyan
Write-Host '  http://localhost:5000' -ForegroundColor DarkCyan
Write-Host '  (Keep this window open)' -ForegroundColor DarkGray
Write-Host ''
& '$pythonCmd' server.py
Write-Host ''
Write-Host '  Flask server stopped.' -ForegroundColor Red
Read-Host 'Press Enter to close'
"@
    $flaskContent | Out-File -FilePath $flaskScript -Encoding UTF8 -Force

    # Write temp launcher for Vite
    $viteScript = Join-Path $env:TEMP "chromium_forensics_vite.ps1"
    $viteContent = @"
Set-Location '$projectDir'
`$Host.UI.RawUI.WindowTitle = 'React Vite Dev -- port 5173'
Write-Host ''
Write-Host '  React Vite Dev Server' -ForegroundColor Magenta
Write-Host '  http://localhost:5173' -ForegroundColor DarkMagenta
Write-Host '  (Keep this window open)' -ForegroundColor DarkGray
Write-Host ''
npm run dev
Write-Host ''
Write-Host '  Vite server stopped.' -ForegroundColor Red
Read-Host 'Press Enter to close'
"@
    $viteContent | Out-File -FilePath $viteScript -Encoding UTF8 -Force

    # Launch Flask window
    Write-Info "Starting Flask backend   -> http://localhost:5000"
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", $flaskScript

    # Small delay so Flask binds before Vite starts
    Start-Sleep -Seconds 2

    # Launch Vite window
    Write-Info "Starting Vite frontend   -> http://localhost:5173"
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", $viteScript

    Write-Spacer
}

# ----------------------------------------------------------------
#  STEP 8 -- Wait for Vite then open browser
# ----------------------------------------------------------------
function Open-Browser {
    Write-Step "Waiting for Vite to be ready..."

    $timeout  = 30
    $elapsed  = 0
    $ready    = $false

    while ($elapsed -lt $timeout) {
        Start-Sleep -Seconds 1
        $elapsed++
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:5173" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {
            Write-Host "." -NoNewline -ForegroundColor DarkGray
        }
    }

    Write-Host ""

    if ($ready) {
        Write-Ok "Vite is ready! Opening browser..."
        Start-Process "http://localhost:5173"
    } else {
        Write-Warn "Vite did not respond within ${timeout}s."
        Write-Info "Open manually: http://localhost:5173"
    }

    Write-Spacer
}

# ----------------------------------------------------------------
#  SUMMARY
# ----------------------------------------------------------------
function Write-Summary {
    Write-Host "  +------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |       CHROMIUM FORENSICS SOC -- RUNNING        |" -ForegroundColor Cyan
    Write-Host "  +------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |                                                |" -ForegroundColor DarkCyan
    Write-Host "  |  Frontend  http://localhost:5173               |" -ForegroundColor Green
    Write-Host "  |  Backend   http://localhost:5000               |" -ForegroundColor Green
    Write-Host "  |                                                |" -ForegroundColor DarkCyan
    Write-Host "  |  Both servers run in their own windows.        |" -ForegroundColor DarkGray
    Write-Host "  |  Close those windows to stop them.             |" -ForegroundColor DarkGray
    Write-Host "  |                                                |" -ForegroundColor DarkCyan
    Write-Host "  +------------------------------------------------+" -ForegroundColor Cyan
    Write-Spacer
}

# ----------------------------------------------------------------
#  MAIN
# ----------------------------------------------------------------
try {
    Write-Banner
    Ensure-ExecutionPolicy
    Assert-ProjectFiles
    Ensure-Python
    Ensure-Node
    Ensure-PythonPackages
    Ensure-NpmPackages
    Assert-PortFree -Port 5000
    Start-Servers
    Open-Browser
    Write-Summary
} catch {
    Write-Spacer
    Write-Fail "Unexpected error: $_"
    Write-Info $_.ScriptStackTrace
    Write-Spacer
    Read-Host "Press Enter to exit"
    exit 1
}

Read-Host "Press Enter to close this setup window"

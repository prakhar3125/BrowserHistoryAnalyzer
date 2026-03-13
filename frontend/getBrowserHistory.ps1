<#
.SYNOPSIS
    Forensic History Collector for Defender Live Response.
    Merges WAL into main DB before staging, so uploaded files parse correctly.
.FIXES
    - WAL no longer deleted when checkpoint fails (data loss bug)
    - Checkpoint mode changed from TRUNCATE to FULL (works under shared lock)
    - LASTEXITCODE checked before removing WAL/SHM
    - Removed unnecessary journal_mode=WAL pragma (caused spurious write txn)
    - Partial checkpoint (busy=1) now surfaces as warning + WAL kept alongside DB
.EXAMPLE
    run Collect-ChromiumHistory.ps1 -Parameters "-Chrome -Edge"
#>

param(
    [switch]$Chrome,
    [switch]$Edge,
    [switch]$Brave
)

if (-not ($Chrome -or $Edge -or $Brave)) {
    $Chrome = $true
    $Edge   = $true
    $Brave  = $true
}

$Timestamp   = Get-Date -Format 'yyyyMMdd_HHmmss'
$StagingPath = "C:\Windows\Temp\HistoryCollection_$Timestamp"
$WorkPath    = "C:\Windows\Temp\HistoryWork_$Timestamp"

New-Item -ItemType Directory -Path $StagingPath -Force | Out-Null
New-Item -ItemType Directory -Path $WorkPath    -Force | Out-Null

# ----------------------------------------------------------------
# Browser target map
# ----------------------------------------------------------------
$TargetBrowsers = @{}
if ($Edge)   { $TargetBrowsers["Edge"]   = "Microsoft\Edge\User Data" }
if ($Chrome) { $TargetBrowsers["Chrome"] = "Google\Chrome\User Data" }
if ($Brave)  { $TargetBrowsers["Brave"]  = "BraveSoftware\Brave-Browser\User Data" }

# ----------------------------------------------------------------
# Warn if browsers are running (WAL will have uncommitted pages)
# ----------------------------------------------------------------
$BrowserProcs = @{
    "Edge"   = "msedge"
    "Chrome" = "chrome"
    "Brave"  = "brave"
}
foreach ($b in $BrowserProcs.Keys) {
    if ($TargetBrowsers.ContainsKey($b)) {
        if (Get-Process -Name $BrowserProcs[$b] -ErrorAction SilentlyContinue) {
            Write-Host "[!] WARNING: $b is currently RUNNING -- WAL has uncommitted pages" -ForegroundColor Yellow
        }
    }
}

# ----------------------------------------------------------------
# Check if Python is available for WAL checkpoint
# ----------------------------------------------------------------
$PythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3\.") {
            $PythonCmd = $cmd
            Write-Host "[+] Python found: $ver -- WAL merge enabled" -ForegroundColor Green
            break
        }
    } catch { }
}
if (-not $PythonCmd) {
    Write-Host "[!] Python not found -- WAL will be included raw (recent activity may be missing from React tool)" -ForegroundColor Yellow
}

# ----------------------------------------------------------------
# Lock-safe raw file copy (FileShare.ReadWrite bypasses browser lock)
# ----------------------------------------------------------------
function Copy-LockedFile {
    param([string]$Source, [string]$Destination)
    try {
        $src  = [System.IO.File]::Open($Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $dest = [System.IO.File]::Create($Destination)
        $src.CopyTo($dest)
        $src.Close()
        $dest.Close()
        return $true
    } catch {
        Write-Host "    [!] Copy failed: $Source" -ForegroundColor Red
        Write-Host "        $($_.Exception.Message)" -ForegroundColor DarkRed
        return $false
    }
}

# ----------------------------------------------------------------
# WAL merge via Python
#
# FIX 1: Uses wal_checkpoint(FULL) instead of wal_checkpoint(TRUNCATE)
#         FULL syncs WAL frames into the main DB under a shared lock.
#         TRUNCATE requires an exclusive lock and fails silently when
#         the browser is open -- leaving the DB with missing recent rows.
#
# FIX 2: Python script now exits with code 1 on partial checkpoint
#         (busy=1 means the browser still holds frames in WAL).
#
# FIX 3: WAL/SHM are only deleted when LASTEXITCODE == 0.
#         Previously they were always deleted, so a failed checkpoint
#         would destroy the WAL before its data was merged -- data loss.
#
# FIX 4: Removed `PRAGMA journal_mode=WAL` -- this opened a write
#         transaction on a read-only forensic copy before the checkpoint,
#         which is unnecessary and could corrupt the work copy.
# ----------------------------------------------------------------
function Merge-WalCheckpoint {
    param([string]$HistoryPath)

    $WorkDir = Join-Path $WorkPath ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

    $WorkDB  = Join-Path $WorkDir "History"
    $WorkWAL = Join-Path $WorkDir "History-wal"
    $WorkSHM = Join-Path $WorkDir "History-shm"

    $ok = Copy-LockedFile -Source $HistoryPath -Destination $WorkDB
    if (-not $ok) { return $null }

    if (Test-Path "$HistoryPath-wal") {
        Copy-LockedFile -Source "$HistoryPath-wal" -Destination $WorkWAL | Out-Null
    } else {
        Write-Host "    [i] No WAL file found -- main DB used as-is" -ForegroundColor DarkGray
        return $WorkDB
    }
    if (Test-Path "$HistoryPath-shm") {
        Copy-LockedFile -Source "$HistoryPath-shm" -Destination $WorkSHM | Out-Null
    }

    if ($PythonCmd) {
        # FIX 1 + FIX 4: Use FULL checkpoint, no journal_mode write, exit 1 on partial
        $PyScript = @"
import sqlite3, sys

db_path = sys.argv[1]

try:
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA locking_mode=NORMAL')   # ensure we don't hold exclusive lock
    # FIX 1: FULL merges WAL frames into main DB under shared lock.
    #        TRUNCATE was used before -- it requires exclusive lock and fails
    #        silently when the browser is open, producing an incomplete DB.
    busy, log, checkpointed = conn.execute('PRAGMA wal_checkpoint(FULL)').fetchone()
    conn.commit()
    conn.close()

    if busy:
        # FIX 2: Partial checkpoint -- browser is holding some WAL frames.
        # Signal PowerShell to keep WAL alongside the DB so no data is lost.
        print('PARTIAL checkpoint: {}/{} frames merged -- browser lock held, WAL kept'.format(checkpointed, log))
        sys.exit(1)
    else:
        print('FULL checkpoint OK -- {}/{} frames merged'.format(checkpointed, log))
        sys.exit(0)

except Exception as e:
    print('checkpoint FAILED: ' + str(e))
    sys.exit(1)
"@
        $PyScriptPath = Join-Path $WorkDir "checkpoint.py"
        $PyScript | Out-File -FilePath $PyScriptPath -Encoding UTF8 -Force

        Write-Host "    [~] Merging WAL..." -ForegroundColor Cyan
        $result = & $PythonCmd $PyScriptPath $WorkDB 2>&1

        # FIX 3: Only delete WAL/SHM when the checkpoint fully succeeded.
        #        Before this fix they were always deleted -- if the checkpoint
        #        failed, recent WAL data was gone with no recovery possible.
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    [+] $result" -ForegroundColor Green
            Remove-Item -Path $WorkWAL    -ErrorAction SilentlyContinue
            Remove-Item -Path $WorkSHM    -ErrorAction SilentlyContinue
        } else {
            Write-Host "    [!] $result" -ForegroundColor Yellow
            Write-Host "    [i] WAL kept alongside DB -- recent rows preserved" -ForegroundColor DarkGray
            # Leave WAL/SHM in place so they are staged with the DB
        }

        Remove-Item -Path $PyScriptPath -ErrorAction SilentlyContinue

    } else {
        Write-Host "    [i] WAL included without checkpoint (Python unavailable)" -ForegroundColor DarkGray
    }

    return $WorkDB
}

# ----------------------------------------------------------------
# Main collection loop
# ----------------------------------------------------------------
$CollectedCount = 0
$UserProfiles   = Get-ChildItem "C:\Users" -Directory

foreach ($User in $UserProfiles) {
    foreach ($Browser in $TargetBrowsers.Keys) {
        $BasePath = Join-Path $User.FullName "AppData\Local\$($TargetBrowsers[$Browser])"
        if (-not (Test-Path $BasePath)) { continue }

        # FIX 5: Added -File so we never match a directory named "History"
        $HistoryFiles = Get-ChildItem -Path $BasePath -Filter "History" -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch "System Profile|Guest Profile|\.Trash|Temp" }

        foreach ($File in $HistoryFiles) {
            # FIX 6: Build ProfileName from the relative path under BasePath, not just
            #        $File.Parent.Name.  When the parent folder name is empty (junction
            #        points, non-ASCII username expansion issues) $File.Parent.Name returns
            #        "" -- causing all profiles to share the same filename and overwrite
            #        each other so only the last (smallest) file survives in staging.
            #
            #        Using the relative path e.g. "Default", "Profile 1", "Profile 2"
            #        gives a stable, unique, human-readable label.
            $RelPath     = $File.FullName.Substring($BasePath.Length).TrimStart('\')
            $ProfileName = [System.IO.Path]::GetDirectoryName($RelPath) -replace '\\', '_'
            if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = "Default" }
            $SafeProfile  = $ProfileName -replace '[^a-zA-Z0-9_-]', '_'

            $SafeUser     = $User.Name -replace '[^a-zA-Z0-9_-]', '_'
            $DestBaseName = "${SafeUser}_${Browser}_${SafeProfile}_History.db"

            # FIX 7: Collision guard -- if two profiles somehow resolve to the same name
            #        (e.g. both sanitise to "Profile_1"), append a counter rather than
            #        silently overwriting the first file.
            $DestFile = Join-Path $StagingPath $DestBaseName
            if (Test-Path $DestFile) {
                $Counter = 2
                do {
                    $DestBaseName = "${SafeUser}_${Browser}_${SafeProfile}_${Counter}_History.db"
                    $DestFile     = Join-Path $StagingPath $DestBaseName
                    $Counter++
                } while (Test-Path $DestFile)
                Write-Host "    [i] Name collision resolved -- using $DestBaseName" -ForegroundColor DarkGray
            }

            Write-Host ""
            Write-Host "[+] Collecting: $($User.Name) | ${Browser} | ${ProfileName}" -ForegroundColor Cyan

            $MergedPath = Merge-WalCheckpoint -HistoryPath $File.FullName

            if ($MergedPath -and (Test-Path $MergedPath)) {
                Copy-Item -Path $MergedPath -Destination $DestFile -Force
                $SizeKB = [math]::Round((Get-Item $DestFile).Length / 1KB, 1)
                Write-Host "    [+] Staged: $DestBaseName ($SizeKB KB)" -ForegroundColor Green
                $CollectedCount++

                # Stage WAL/SHM alongside DB when checkpoint was partial/skipped
                $WalWork = "$MergedPath-wal"
                $ShmWork = "$MergedPath-shm"
                if (Test-Path $WalWork) {
                    Copy-Item -Path $WalWork -Destination "$DestFile-wal" -Force
                    Write-Host "    [+] Also staged: $DestBaseName-wal (partial checkpoint -- recent rows here)" -ForegroundColor Yellow
                }
                if (Test-Path $ShmWork) {
                    Copy-Item -Path $ShmWork -Destination "$DestFile-shm" -Force
                    Write-Host "    [+] Also staged: $DestBaseName-shm" -ForegroundColor DarkGray
                }
            } else {
                Write-Host "    [!] Skipped -- copy failed" -ForegroundColor Red
            }
        }
    }
}

# ----------------------------------------------------------------
# Cleanup work dir
# ----------------------------------------------------------------
Remove-Item -Path $WorkPath -Recurse -Force -ErrorAction SilentlyContinue

# ----------------------------------------------------------------
# Zip and report
# ----------------------------------------------------------------
$ZipFile = "$StagingPath.zip"

if ((Get-ChildItem $StagingPath -ErrorAction SilentlyContinue).Count -gt 0) {

    Write-Host ""
    Write-Host "[~] Creating zip..." -ForegroundColor Cyan
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($StagingPath, $ZipFile)
    Remove-Item -Path $StagingPath -Recurse -Force

    $Hash      = (Get-FileHash -Path $ZipFile -Algorithm SHA256).Hash
    $ZipSizeMB = [math]::Round((Get-Item $ZipFile).Length / 1MB, 1)

    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  COLLECTION COMPLETE" -ForegroundColor Green
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  Files collected : $CollectedCount"
    Write-Host "  Output          : $ZipFile"
    Write-Host "  Size            : $ZipSizeMB MB"
    Write-Host "  SHA256          : $Hash" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan

    if ((Get-Item $ZipFile).Length -gt 2.8GB) {
        Write-Host ""
        Write-Host "[!] WARNING: Zip exceeds 3GB -- getfile may fail." -ForegroundColor Red
        Write-Host "    Re-run with -Chrome, -Edge, or -Brave separately." -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "[>>>] PASTE THIS TO DOWNLOAD:" -ForegroundColor White
    Write-Host "getfile `"$ZipFile`"" -ForegroundColor Cyan

} else {
    Write-Host ""
    Write-Host "[!] No history files were collected." -ForegroundColor Yellow
    Remove-Item -Path $StagingPath -Recurse -Force -ErrorAction SilentlyContinue
}
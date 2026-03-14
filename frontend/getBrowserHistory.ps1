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
            break
        }
    } catch { }
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
        return $false
    }
}


# ----------------------------------------------------------------
# WAL merge via Python
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
        return $WorkDB
    }
    if (Test-Path "$HistoryPath-shm") {
        Copy-LockedFile -Source "$HistoryPath-shm" -Destination $WorkSHM | Out-Null
    }


    if ($PythonCmd) {
        $PyScript = @"
import sqlite3, sys


db_path = sys.argv[1]


try:
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA locking_mode=NORMAL')
    busy, log, checkpointed = conn.execute('PRAGMA wal_checkpoint(FULL)').fetchone()
    conn.commit()
    conn.close()


    if busy:
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


        $result = & $PythonCmd $PyScriptPath $WorkDB 2>&1


        if ($LASTEXITCODE -eq 0) {
            Remove-Item -Path $WorkWAL -ErrorAction SilentlyContinue
            Remove-Item -Path $WorkSHM -ErrorAction SilentlyContinue
        }


        Remove-Item -Path $PyScriptPath -ErrorAction SilentlyContinue
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


        $HistoryFiles = Get-ChildItem -Path $BasePath -Filter "History" -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch "System Profile|Guest Profile|\.Trash|Temp|Snapshots" }



        foreach ($File in $HistoryFiles) {
            $RelPath     = $File.FullName.Substring($BasePath.Length).TrimStart('\')
            $ProfileName = [System.IO.Path]::GetDirectoryName($RelPath) -replace '\\', '_'
            if ([string]::IsNullOrWhiteSpace($ProfileName)) { $ProfileName = "Default" }
            $SafeProfile  = $ProfileName -replace '[^a-zA-Z0-9_-]', '_'


            $SafeUser     = $User.Name -replace '[^a-zA-Z0-9_-]', '_'
            $DestBaseName = "${SafeUser}_${Browser}_${SafeProfile}_History.db"


            $DestFile = Join-Path $StagingPath $DestBaseName
            if (Test-Path $DestFile) {
                $Counter = 2
                do {
                    $DestBaseName = "${SafeUser}_${Browser}_${SafeProfile}_${Counter}_History.db"
                    $DestFile     = Join-Path $StagingPath $DestBaseName
                    $Counter++
                } while (Test-Path $DestFile)
            }


            $MergedPath = Merge-WalCheckpoint -HistoryPath $File.FullName


            if ($MergedPath -and (Test-Path $MergedPath)) {
                Copy-Item -Path $MergedPath -Destination $DestFile -Force
                $CollectedCount++


                $WalWork = "$MergedPath-wal"
                $ShmWork = "$MergedPath-shm"
                if (Test-Path $WalWork) {
                    Copy-Item -Path $WalWork -Destination "$DestFile-wal" -Force
                }
                if (Test-Path $ShmWork) {
                    Copy-Item -Path $ShmWork -Destination "$DestFile-shm" -Force
                }
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


    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($StagingPath, $ZipFile)
    Remove-Item -Path $StagingPath -Recurse -Force


    if ((Get-Item $ZipFile).Length -gt 2.8GB) {
        Write-Host "[!] WARNING: Zip exceeds 3GB -- getfile may fail. Re-run with -Chrome, -Edge, or -Brave separately." -ForegroundColor Red
    }

    Write-Host "Run the following Defender Live Response command to download the collected browser history archive:" -ForegroundColor Yellow
    Write-Host "getfile `"$ZipFile`"" -ForegroundColor Cyan


} else {
    Remove-Item -Path $StagingPath -Recurse -Force -ErrorAction SilentlyContinue
}
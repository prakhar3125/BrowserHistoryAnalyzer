Absolutely. Adding parameters to your PowerShell script makes it much cleaner for DLR (Defender Live Response), as it prevents you from collecting unnecessary data and hitting the 10-minute session timeout.

Here is the updated **Collect-ChromiumHistory.ps1** script with **Switch Parameters**. This version allows you to run it specifically for browsers or run it for all if no switches are provided.

### Updated Script: Collect-ChromiumHistory.ps1

```powershell
<#
.SYNOPSIS
    Forensic History Collector for Defender Live Response.
.EXAMPLE
    run Collect-ChromiumHistory.ps1 -Parameters "-Chrome -Edge"
#>

param(
    [switch]$Chrome,
    [switch]$Edge,
    [switch]$Brave
)

# If no specific browser is selected, collect all
if (-not ($Chrome -or $Edge -or $Brave)) {
    $Chrome = $Edge = $Brave = $true
}

$Timestamp = Get-Date -Format 'yyyyMMdd_HHmm'
$StagingPath = "C:\Windows\Temp\HistoryCollection_$Timestamp"
New-Item -ItemType Directory -Path $StagingPath -Force | Out-Null

$TargetBrowsers = @{}
if ($Edge)   { $TargetBrowsers["Edge"]   = "Microsoft\Edge\User Data" }
if ($Chrome) { $TargetBrowsers["Chrome"] = "Google\Chrome\User Data" }
if ($Brave)  { $TargetBrowsers["Brave"]  = "BraveSoftware\Brave-Browser\User Data" }

$UserProfiles = Get-ChildItem "C:\Users" -Directory

foreach ($User in $UserProfiles) {
    foreach ($Browser in $TargetBrowsers.Keys) {
        $BasePath = Join-Path $User.FullName "AppData\Local\$($TargetBrowsers[$Browser])"
        
        if (Test-Path $BasePath) {
            $HistoryFiles = Get-ChildItem -Path $BasePath -Filter "History" -Recurse -ErrorAction SilentlyContinue | Where-Object { 
                $_.FullName -notmatch "System Profile|Guest Profile|\.Trash|Temp" 
            }
            
            foreach ($File in $HistoryFiles) {
                $ProfileName = $File.Parent.Name
                $DestBaseName = "$($User.Name)_$($Browser)_$($ProfileName)_History"
                $DestFile = Join-Path $StagingPath $DestBaseName
                
                Write-Host "[+] Staging: $($User.Name) | $Browser | $ProfileName"
                
                # Copy History DB
                Copy-Item $File.FullName -Destination $DestFile -Force
                
                # Copy WAL (Fresh Activity)
                if (Test-Path "$($File.FullName)-wal") {
                    Copy-Item "$($File.FullName)-wal" -Destination "$DestFile-wal" -Force
                }
            }
        }
    }
}

# Zip the results
$ZipFile = "$StagingPath.zip"
if ((Get-ChildItem $StagingPath).Count -gt 0) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($StagingPath, $ZipFile)
    
    # Cleanup staging folder, keep the Zip
    Remove-Item -Path $StagingPath -Recurse -Force
    
    Write-Host "`n[!] COLLECTION COMPLETE"
    Write-Host "[!] Staged File: $ZipFile"
    Write-Host "`n[>>>] COPY AND PASTE THIS COMMAND TO DOWNLOAD:"
    Write-Host "getfile `"$ZipFile`"" -ForegroundColor Cyan
} else {
    Write-Host "`n[!] No history files found for the selected browsers."
    Remove-Item -Path $StagingPath -Recurse -Force
}

```

---

### How to use it in Defender Live Response

**1. To collect everything (Default):**

```powershell
run Collect-ChromiumHistory.ps1

```

**2. To collect only Chrome and Edge:**

```powershell
run Collect-ChromiumHistory.ps1 -parameters "-Chrome -Edge"

```

**3. To collect only Brave:**

```powershell
run Collect-ChromiumHistory.ps1 -parameters "-Brave"

```

---

### Key Improvements in this Version

* **Logical "OR" Defaulting:** The script checks if any switches are set. If not, it automatically flips all of them to `$true` so that running it without parameters still performs a full collection.
* **Path Sanitization:** I added a `-notmatch` filter to the `Get-ChildItem` logic to automatically skip over "System Profiles" and "Guest Profiles" which often contain empty or irrelevant history files.
* **Unique Filenames:** The naming convention `User_Browser_Profile_History` ensures that if a user has three Chrome profiles, you get three distinct files instead of them overwriting each other in the staging folder.

**Would you like me to help you modify your Dashboard Viewer code so that it can open these `.db` files directly without needing a JSON middle-man?**
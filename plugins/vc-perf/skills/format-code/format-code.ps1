# Format C# code using dotnet format
# This script formats C# files using the nearest solution file
# Groups files by solution and formats them in batches for better performance
# Usage: pwsh format-code.ps1 <file-path1> [<file-path2> [<file-path3> ...]]
# Example: pwsh format-code.ps1 "src/File1.cs" "src/File2.cs" "src/File3.cs"

param(
    [Parameter(Mandatory=$true, ValueFromRemainingArguments=$true)]
    [string[]]$FilePaths
)

# Setup logging
# Try to find project root from script location
$projectRoot = $null

# Script is at .claude/skills/format-code/format-code.ps1
# Project root is 3 levels up from script directory
$skillsDir = Split-Path -Path $PSScriptRoot -Parent
$claudeDir = Split-Path -Path $skillsDir -Parent
$projectRoot = Split-Path -Path $claudeDir -Parent

# If still not found, use current directory
if (-not $projectRoot -or -not (Test-Path $projectRoot)) {
    $projectRoot = Get-Location
}

$logFile = Join-Path $projectRoot ".claude/format-code.log"
$logDir = Split-Path -Path $logFile -Parent
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message)

    try {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $logLine = "$timestamp | $Message`r`n"
        # Use .NET method which closes file handle immediately after write
        [System.IO.File]::AppendAllText($logFile, $logLine, [System.Text.Encoding]::UTF8)
    }
    catch {
        # Silently ignore write errors to prevent script failure
    }
}

Write-Log "=== Format script started ==="
Write-Log "Project root: $projectRoot"
Write-Log "File paths (raw): $($FilePaths -join ', ')"

# Function to find .sln file in directory or parent directories
function Find-SolutionFile {
    param([string]$startPath)

    $currentPath = $startPath
    $searchDepth = 0
    while ($currentPath -and $searchDepth -lt 10) {
        Write-Log "  Searching in: $currentPath (depth: $searchDepth)"
        if (Test-Path $currentPath) {
            $slnFiles = Get-ChildItem -Path $currentPath -Filter "*.sln" -ErrorAction SilentlyContinue
            if ($slnFiles) {
                $found = $slnFiles[0].FullName
                Write-Log "  Found solution: $found"
                return $found
            }
            else {
                Write-Log "  No .sln files found in: $currentPath"
            }
        }
        else {
            Write-Log "  Path does not exist: $currentPath"
        }

        $parentPath = Split-Path -Path $currentPath -Parent
        if ($parentPath -eq $currentPath -or [string]::IsNullOrEmpty($parentPath)) {
            Write-Log "  Reached root directory"
            break
        }
        $currentPath = $parentPath
        $searchDepth++
    }
    Write-Log "  Solution not found after searching $searchDepth levels"
    return $null
}

# Use project root as workspace root
$workspaceRoots = @($projectRoot)
Write-Log "Using project root as workspace root: $projectRoot"

# Resolve and filter C# files
$resolvedFiles = @()
foreach ($filePath in $FilePaths) {
    # Resolve file path to absolute path
    if (-not [System.IO.Path]::IsPathRooted($filePath)) {
        # Relative path - resolve relative to project root or current directory
        if ($projectRoot) {
            $filePath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $filePath))
        }
        else {
            $filePath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $filePath))
        }
    }

    # Check if file exists
    if (-not (Test-Path $filePath)) {
        Write-Log "WARNING: File does not exist: $filePath"
        Write-Host "⚠ File not found: $filePath" -ForegroundColor Yellow
        continue
    }

    # Only process C# files
    if ($filePath.EndsWith(".cs")) {
        $resolvedFiles += $filePath
        Write-Log "Added C# file: $filePath"
    }
    else {
        Write-Log "Skipping non-C# file: $filePath"
    }
}

if ($resolvedFiles.Count -eq 0) {
    Write-Log "No C# files to format"
    Write-Host "No C# files to format" -ForegroundColor Yellow
    exit 0
}

Write-Log "Processing $($resolvedFiles.Count) C# file(s)"

# Group files by solution
$filesBySolution = @{}
$filesWithoutSolution = @()

foreach ($filePath in $resolvedFiles) {
    $solutionPath = $null

    # First, try to find .sln in the file's directory or parent directories
    $fileDir = Split-Path -Path $filePath -Parent
    if ($fileDir) {
        Write-Log "Searching for .sln for file: $filePath"
        $solutionPath = Find-SolutionFile -startPath $fileDir
        if ($solutionPath) {
            Write-Log "Found solution in file directory: $solutionPath"
        }
    }

    # If not found, search in workspace roots
    if (-not $solutionPath) {
        Write-Log "Solution not found in file directory, searching workspace roots"
        foreach ($root in $workspaceRoots) {
            Write-Log "Searching in workspace root: $root"
            $solutionPath = Find-SolutionFile -startPath $root
            if ($solutionPath) {
                Write-Log "Found solution in workspace root: $solutionPath"
                break
            }
        }
    }

    if ($solutionPath) {
        $normalizedSolutionPath = [System.IO.Path]::GetFullPath($solutionPath)
        if (-not $filesBySolution.ContainsKey($normalizedSolutionPath)) {
            $filesBySolution[$normalizedSolutionPath] = @()
        }
        $filesBySolution[$normalizedSolutionPath] += $filePath
    }
    else {
        $filesWithoutSolution += $filePath
    }
}

# Format files grouped by solution
$totalFormatted = 0
$totalErrors = 0

foreach ($solutionPath in $filesBySolution.Keys) {
    $files = $filesBySolution[$solutionPath]
    Write-Log "Formatting $($files.Count) file(s) with solution: $solutionPath"

    $solutionDir = Split-Path -Path $solutionPath -Parent
    $solutionName = Split-Path -Path $solutionPath -Leaf
    Write-Log "Solution directory: $solutionDir"
    Write-Log "Solution name: $solutionName"

    # Calculate relative paths from solution directory to files
    $normalizedSolutionDir = [System.IO.Path]::GetFullPath($solutionDir)
    $relativeFilePaths = @()

    foreach ($filePath in $files) {
        $normalizedFilePath = [System.IO.Path]::GetFullPath($filePath)
        $relativeFilePath = $filePath

        try {
            # Use case-insensitive comparison for Windows paths
            if ($normalizedFilePath.StartsWith($normalizedSolutionDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                # Get relative path using System.IO.Path
                $relativeFilePath = [System.IO.Path]::GetRelativePath($solutionDir, $filePath)
                Write-Log "Relative file path: $relativeFilePath"
            }
            else {
                Write-Log "WARNING: File path is not under solution directory"
                Write-Log "  Solution dir: $normalizedSolutionDir"
                Write-Log "  File path: $normalizedFilePath"
                # Try to calculate relative path anyway
                $relativeFilePath = [System.IO.Path]::GetRelativePath($solutionDir, $filePath)
                Write-Log "Calculated relative path anyway: $relativeFilePath"
            }
        }
        catch {
            Write-Log "ERROR calculating relative path: $($_.Exception.Message)"
            # Fallback to absolute path if relative path calculation fails
            $relativeFilePath = $filePath
        }

        $relativeFilePaths += $relativeFilePath
    }

    # Format all files for this solution in one command
    # Build flat array of arguments: --include file1 --include file2 ...
    $includeArgs = @()
    foreach ($relativeFilePath in $relativeFilePaths) {
        $includeArgs += "--include"
        $includeArgs += $relativeFilePath
    }
    Write-Log "Command: cd `"$solutionDir`" ; dotnet format --no-restore $solutionName $($includeArgs -join ' ')"

    try {
        Push-Location $solutionDir
        Write-Log "Changed directory to: $(Get-Location)"

        $formatOutput = & dotnet format --no-restore $solutionName @includeArgs 2>&1
        $exitCode = $LASTEXITCODE
        Write-Log "dotnet format exit code: $exitCode"
        Write-Log "dotnet format output: $($formatOutput -join '`n')"

        if ($exitCode -eq 0) {
            Write-Host "✓ Formatted $($files.Count) file(s) with solution: $solutionName" -ForegroundColor Green
            $totalFormatted += $files.Count
        }
        else {
            Write-Host "⚠ Formatting completed with warnings for $($files.Count) file(s): $solutionName" -ForegroundColor Yellow
            $totalFormatted += $files.Count
        }
    }
    catch {
        Write-Log "ERROR executing dotnet format: $($_.Exception.Message)"
        Write-Host "✗ Error formatting files with solution $solutionName : $($_.Exception.Message)" -ForegroundColor Red
        $totalErrors += $files.Count
    }
    finally {
        Pop-Location
    }
}

# Handle files without solution (fallback)
foreach ($filePath in $filesWithoutSolution) {
    Write-Log "WARNING: No solution file found for: $filePath, trying fallback"
    $fileDir = Split-Path -Path $filePath -Parent
    if ($fileDir) {
        Write-Log "Trying to format using file directory: $fileDir"
        try {
            Push-Location $fileDir
            Write-Log "Changed directory to: $(Get-Location)"

            $fileName = Split-Path -Path $filePath -Leaf
            $formatOutput = & dotnet format --no-restore . --include $fileName 2>&1
            $exitCode = $LASTEXITCODE
            Write-Log "dotnet format (fallback) exit code: $exitCode"
            Write-Log "dotnet format (fallback) output: $($formatOutput -join '`n')"

            if ($exitCode -eq 0) {
                Write-Host "✓ Formatted (fallback): $filePath" -ForegroundColor Green
                $totalFormatted++
            }
            else {
                Write-Host "⚠ Formatting completed with warnings (fallback): $filePath" -ForegroundColor Yellow
                $totalFormatted++
            }
        }
        catch {
            Write-Log "ERROR executing dotnet format (fallback): $($_.Exception.Message)"
            Write-Host "✗ Error formatting $filePath (fallback): $($_.Exception.Message)" -ForegroundColor Red
            $totalErrors++
        }
        finally {
            Pop-Location
        }
    }
    else {
        Write-Log "ERROR: Cannot determine file directory for fallback: $filePath"
        Write-Host "✗ Cannot format $filePath : No solution file found and cannot determine file directory" -ForegroundColor Red
        $totalErrors++
    }
}

Write-Log "=== Format script completed ==="
Write-Log "Total formatted: $totalFormatted, Total errors: $totalErrors"

if ($totalFormatted -gt 0) {
    Write-Host "✓ Formatting completed: $totalFormatted file(s) formatted" -ForegroundColor Green
}
if ($totalErrors -gt 0) {
    Write-Host "✗ Formatting errors: $totalErrors file(s) failed" -ForegroundColor Red
    exit 1
}

exit 0

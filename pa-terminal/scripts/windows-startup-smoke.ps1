param(
    [Parameter(Mandatory = $true)]
    [string]$Executable
)

$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$logDirectory = Join-Path ([IO.Path]::GetTempPath()) ('paterminal-startup-' + [guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($logDirectory)
$stdout = Join-Path $logDirectory 'stdout.log'
$stderr = Join-Path $logDirectory 'stderr.log'
$appProcess = $null

try {
    $appProcess = Start-Process -FilePath $executablePath -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # Keep the process handle so Windows PowerShell can report early exit codes.
    [void]$appProcess.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $windowReady = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($appProcess.WaitForExit(250)) {
            throw ('Application exited during startup: {0} (0x{0:X8})' -f $appProcess.ExitCode)
        }
        $appProcess.Refresh()
        if ($appProcess.MainWindowHandle -ne 0 -and $appProcess.Responding) {
            $windowReady = $true
            break
        }
    }
    if (-not $windowReady) {
        throw 'Application did not create a responsive window within 30 seconds.'
    }
    # Catch failures in setup / initial page-load callbacks after window creation.
    if ($appProcess.WaitForExit(5000)) {
        throw ('Application exited after creating its window: {0} (0x{0:X8})' -f $appProcess.ExitCode)
    }
    $appProcess.Refresh()
    if ($appProcess.MainWindowHandle -eq 0 -or -not $appProcess.Responding) {
        throw 'Application window stopped responding during startup.'
    }
    if (-not $appProcess.CloseMainWindow() -or -not $appProcess.WaitForExit(10000)) {
        throw 'Application did not shut down after closing its window.'
    }
    if ($appProcess.ExitCode -ne 0) {
        throw ('Application crashed while closing: {0} (0x{0:X8})' -f $appProcess.ExitCode)
    }
    Write-Host 'Windows startup passed: responsive window and clean shutdown.'
} finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        [void]$appProcess.CloseMainWindow()
        if (-not $appProcess.WaitForExit(5000)) {
            $appProcess.Kill()
            $appProcess.WaitForExit()
        }
    }
    foreach ($log in @($stdout, $stderr)) {
        if (Test-Path -LiteralPath $log) {
            Get-Content -LiteralPath $log
        }
    }
    Write-Host "Startup logs: $logDirectory"
}

$ErrorActionPreference = 'Stop'
$executable = (Resolve-Path (Join-Path $PSScriptRoot '..\target\release\dreamcraft.exe')).Path
$logPath = Join-Path $env:TEMP "dreamcraft-desktop-smoke-$PID.log"
$oldBrowserSetting = $env:DREAMCRAFT_NO_BROWSER
$oldSmokeSetting = $env:DREAMCRAFT_DESKTOP_SMOKE
$oldLogPath = $env:DREAMCRAFT_DESKTOP_LOG
Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
$env:DREAMCRAFT_NO_BROWSER = $null
$env:DREAMCRAFT_DESKTOP_SMOKE = '1'
$env:DREAMCRAFT_DESKTOP_LOG = $logPath
$process = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 250
    }
    $process.Refresh()
    if (-not $process.HasExited) { throw 'Native desktop smoke did not finish within 45 seconds.' }
    $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { '' }
    if ($process.ExitCode -ne 0 -or $log -notmatch 'DREAMCRAFT_DESKTOP_STARTED' -or $log -notmatch 'DREAMCRAFT_DESKTOP_READY' -or $log -notmatch 'DREAMCRAFT_DESKTOP_SMOKE_CLOSED' -or $log -notmatch 'DREAMCRAFT_DESKTOP_CLOSED') {
        throw "Native desktop startup did not reach and close the ready editor window. Exit code: $($process.ExitCode). Log: $log"
    }
    [pscustomobject]@{ executable = $executable; exitCode = $process.ExitCode; checkpoints = @('splash and WebView2 created', 'editor initialized in native window', 'window lifecycle closed cleanly'); result = 'passed' } | ConvertTo-Json -Compress
}
finally {
    $process.Refresh()
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    if ($null -eq $oldBrowserSetting) { Remove-Item Env:DREAMCRAFT_NO_BROWSER -ErrorAction SilentlyContinue } else { $env:DREAMCRAFT_NO_BROWSER = $oldBrowserSetting }
    if ($null -eq $oldSmokeSetting) { Remove-Item Env:DREAMCRAFT_DESKTOP_SMOKE -ErrorAction SilentlyContinue } else { $env:DREAMCRAFT_DESKTOP_SMOKE = $oldSmokeSetting }
    if ($null -eq $oldLogPath) { Remove-Item Env:DREAMCRAFT_DESKTOP_LOG -ErrorAction SilentlyContinue } else { $env:DREAMCRAFT_DESKTOP_LOG = $oldLogPath }
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
}

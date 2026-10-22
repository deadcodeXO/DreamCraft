param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,
    [string]$Executable = (Join-Path $PSScriptRoot '..\target\release\dreamcraft.exe')
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $ProjectPath).Path
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'ProjectPath must be an existing directory.' }
$executable = (Resolve-Path -LiteralPath $Executable).Path
$tempRoot = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\') + '\'
$stage = Join-Path $env:TEMP "dreamcraft-customer-site-qa-$PID"
$appData = Join-Path $env:TEMP "dreamcraft-customer-qa-data-$PID"
$stdoutPath = Join-Path $env:TEMP "dreamcraft-customer-qa-$PID.out"
$stderrPath = Join-Path $env:TEMP "dreamcraft-customer-qa-$PID.err"
foreach ($path in @($stage, $appData, $stdoutPath, $stderrPath)) {
    if (-not [IO.Path]::GetFullPath($path).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a QA path outside TEMP: $path"
    }
}
$oldLocalAppData = $env:LOCALAPPDATA
$oldNoBrowser = $env:DREAMCRAFT_NO_BROWSER
$process = $null
$baseUrl = $null
function Get-ProjectDigest {
    param([string]$Path)
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        Get-ChildItem -LiteralPath $Path -File -Recurse -Force | Where-Object {
            $_.FullName.Substring($Path.Length).Split([IO.Path]::DirectorySeparatorChar) -notcontains '.dreamcraft' -and
            $_.FullName.Substring($Path.Length).Split([IO.Path]::DirectorySeparatorChar) -notcontains '.git' -and
            -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
        } | Sort-Object FullName | ForEach-Object {
            $relative = $_.FullName.Substring($Path.Length).Replace('\', '/')
            $hash.AppendData([Text.Encoding]::UTF8.GetBytes($relative))
            $hash.AppendData([IO.File]::ReadAllBytes($_.FullName))
        }
        return ([BitConverter]::ToString($hash.GetHashAndReset())).Replace('-', '')
    }
    finally { $hash.Dispose() }
}
$sourceDigestBefore = Get-ProjectDigest $source
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    & robocopy $source $stage /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XD (Join-Path $source '.dreamcraft') (Join-Path $source '.git') /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Could not stage the website (robocopy exit code $LASTEXITCODE)." }

    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    $env:LOCALAPPDATA = $appData
    $env:DREAMCRAFT_NO_BROWSER = '1'
    $process = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 200
        if (Test-Path -LiteralPath $stdoutPath) {
            $line = Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($line -match 'http://127\.0\.0\.1:\d+') { $baseUrl = $Matches[0]; break }
        }
    }
    if (-not $baseUrl) { throw "DreamCraft did not start. $((Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue))" }

    $headers = @{ Origin = $baseUrl }
    $opened = Invoke-WebRequest -Uri "$baseUrl/api/projects/open" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ path = $stage } | ConvertTo-Json -Compress) -UseBasicParsing
    $project = $opened.Content | ConvertFrom-Json
    $files = (Invoke-WebRequest -Uri "$baseUrl/api/files" -Headers $headers -UseBasicParsing).Content | ConvertFrom-Json
    $filePaths = @($files | Where-Object kind -eq 'file' | ForEach-Object { $_.path.Replace('\', '/') })
    $html = @($files | Where-Object { $_.kind -eq 'file' -and $_.path -match '\.(html?|php)$' })
    $css = @($files | Where-Object { $_.kind -eq 'file' -and $_.path -match '\.css$' })
    $javascript = @($files | Where-Object { $_.kind -eq 'file' -and $_.path -match '\.(m?js|cjs)$' })

    $findings = [Collections.Generic.List[string]]::new()
    foreach ($page in $html) {
        $segments = $page.path.Replace('\', '/').Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) }
        $pageResponse = Invoke-WebRequest -Uri "$baseUrl/api/file/$($segments -join '/')" -Headers $headers -UseBasicParsing
        $content = $pageResponse.Content
        if ($content -notmatch '<!doctype\s+html') { $findings.Add("Missing HTML doctype: $($page.path)") }
        $baseTag = [regex]::Match($content, '<base\b[^>]*href\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase')
        $documentUrl = "http://dreamcraft.invalid/site/$($page.path.Replace('\', '/'))"
        if ($baseTag.Success) { try { $documentUrl = ([Uri]::new([Uri]$documentUrl, $baseTag.Groups[1].Value)).AbsoluteUri } catch {} }
        foreach ($match in [regex]::Matches($content, '(?:href|src|poster)\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase')) {
            $reference = $match.Groups[1].Value.Trim()
            if (-not $reference -or $reference -match '^(?:https?:|data:|blob:|#|mailto:|tel:|javascript:|//)') { continue }
            try {
                $target = [Uri]::new([Uri]$documentUrl, $reference)
                if ($target.Host -ne 'dreamcraft.invalid') { continue }
                $relative = [Uri]::UnescapeDataString(($target.AbsolutePath -replace '^/site/', '').TrimStart('/'))
                if ($target.AbsolutePath -match '/$') { $relative += 'index.html' }
                if (-not ($filePaths | Where-Object { $_ -ieq $relative })) { $findings.Add("Unresolved local reference in $($page.path): $reference") }
            } catch { $findings.Add("Invalid local reference in $($page.path): $reference") }
        }
    }

    $snapshotResponse = Invoke-WebRequest -Uri "$baseUrl/api/publish" -Method Post -Headers $headers -UseBasicParsing
    $snapshot = $snapshotResponse.Content | ConvertFrom-Json
    $browserList = (Invoke-WebRequest -Uri "$baseUrl/api/browsers" -Headers $headers -UseBasicParsing).Content | ConvertFrom-Json
    $runtime = 'skipped: no installed Chromium-family browser'
    $runtimeIssues = 0
    $browser = @($browserList | Where-Object { $_.id -in @('edge', 'chrome', 'chromium', 'brave') } | Select-Object -First 1)
    if ($browser.Count) {
        $snapshotUrl = [Uri]::new([Uri]$baseUrl, $snapshot.url).AbsoluteUri
        $body = @{ browser_id = $browser[0].id; url = $snapshotUrl } | ConvertTo-Json -Compress
        $report = Invoke-WebRequest -Uri "$baseUrl/api/preview/browser-test" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing
        $runtimeReport = $report.Content | ConvertFrom-Json
        $runtimeIssues = $runtimeReport.issues.Count
        $runtime = "completed: $($runtimeReport.browser), loaded=$($runtimeReport.loaded), findings=$runtimeIssues"
        foreach ($issue in $runtimeReport.issues) { $findings.Add("Runtime $($issue.severity): $($issue.path) · $($issue.message)") }
    }

    $edgeExecutable = if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe' }
    if (-not $edgeExecutable -or -not (Test-Path -LiteralPath $edgeExecutable)) { $edgeExecutable = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
    $editorUi = 'skipped: Microsoft Edge not installed'
    if (Test-Path -LiteralPath $edgeExecutable) {
        $uiPath = "__dreamcraft-customer-ui-$PID.html"
        $uiHtml = @"
<!doctype html><meta charset="utf-8"><pre id="result">CUSTOMER-UI-CHECKING</pre><iframe id="editor" src="$baseUrl/"></iframe><script>
(async()=>{const out=document.getElementById('result');try{const frame=document.getElementById('editor');await new Promise((resolve,reject)=>{if(frame.contentDocument?.readyState==='complete'){resolve();return}frame.addEventListener('load',resolve,{once:true});setTimeout(()=>reject(new Error('DreamCraft editor did not load')),15000)});const doc=frame.contentDocument;const wait=async(p,label)=>{for(let i=0;i<300;i++){if(p())return;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error('Timed out: '+label)};await wait(()=>doc.querySelector('.CodeMirror')?.CodeMirror&&doc.getElementById('themeToggle'),'editor initialization');const currentProject=(await(await fetch('/api/projects')).json()).current;doc.getElementById('projectOpenPath').value=currentProject;doc.getElementById('projectBrowse').click();await wait(()=>doc.getElementById('folderPickerModal').style.display==='grid'&&doc.getElementById('folderPickerLocation').textContent===currentProject,'themed folder browser');await wait(()=>Array.from(doc.querySelectorAll('.folder-picker-row-name')).some(row=>row.textContent==='admin'),'folder listing');doc.getElementById('folderPickerSelect').click();if(doc.getElementById('projectOpenPath').value!==currentProject)throw new Error('The folder browser did not fill the website path');const liveToggle=doc.getElementById('liveDiagnosticsToggle');liveToggle.click();await wait(()=>liveToggle.getAttribute('aria-pressed')==='false','disable live diagnostics');liveToggle.click();await wait(()=>liveToggle.getAttribute('aria-pressed')==='true','enable live diagnostics');const theme=doc.getElementById('themeToggle');theme.click();await wait(()=>doc.documentElement.dataset.theme==='light','light theme');theme.click();await wait(()=>doc.documentElement.dataset.theme==='dark','dark theme');doc.getElementById('codeMode').click();await wait(()=>doc.getElementById('codeMode').classList.contains('on')&&doc.getElementById('codeView').style.display==='block','Code view');doc.getElementById('splitMode').click();await wait(()=>doc.getElementById('splitMode').classList.contains('on')&&doc.getElementById('canvas').classList.contains('split'),'Code/Design view');doc.getElementById('codeSplitMode').click();await wait(()=>doc.getElementById('codeSplitMode').classList.contains('on')&&doc.getElementById('canvas').classList.contains('codesplit'),'Code/Code view');doc.getElementById('designMode').click();await wait(()=>doc.getElementById('designMode').classList.contains('on')&&doc.getElementById('codeView').style.display==='none','Design view');const editor=doc.querySelector('.CodeMirror').CodeMirror;const marker='<!-- DreamCraft staged customer-site edit check -->';editor.replaceRange(marker+'\n<a href="/admin/">Admin route check</a>\n<div id="dreamcraft-live-check"></div><div id="dreamcraft-live-check"></div>\n',{line:0,ch:0});doc.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}));await wait(()=>doc.getElementById('saveLabel')?.textContent==='All changes saved','source save');await wait(()=>doc.getElementById('liveDiagnosticsPanel')&&!doc.getElementById('liveDiagnosticsPanel').classList.contains('hide')&&doc.getElementById('liveDiagnosticsList').textContent.includes('Duplicate id'), 'on-edit live diagnostics');if(doc.getElementById('liveDiagnosticsList').textContent.includes('Local href target "/admin/" was not found'))throw new Error('A directory index link was falsely reported missing');const diagnostic=doc.querySelector('.live-diagnostic-row');if(!diagnostic)throw new Error('No clickable live diagnostic was rendered');diagnostic.click();await wait(()=>doc.getElementById('codeMode').classList.contains('on')&&doc.getElementById('cursorPosition').textContent.startsWith('Ln 2,'),'diagnostic source-line navigation');const saved=await fetch('/api/file/index.html');if(!(await saved.text()).includes(marker))throw new Error('The source edit did not persist in the staged project');const phpPath='__dreamcraft-php-completion-check.php';const phpSource='<?php\nclass ProjectHintRecord {}\n$projectHintDatabase = null;\n';const phpWrite=await fetch('/api/file/'+phpPath,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:phpSource})});if(!phpWrite.ok)throw new Error('Could not create staged PHP completion fixture');await doc.defaultView.loadTree();await new Promise(resolve=>setTimeout(resolve,500));await doc.defaultView.openFile(phpPath);await wait(()=>doc.getElementById('languageStatus').textContent==='PHP','PHP source mode');doc.getElementById('codeMode').click();await wait(()=>doc.getElementById('codeMode').classList.contains('on'),'PHP Code view');const phpEditor=doc.querySelector('.CodeMirror').CodeMirror;phpEditor.setValue('<?php\nProject');phpEditor.setCursor({line:1,ch:7});doc.defaultView.showProjectHints(phpEditor);await wait(()=>{doc.defaultView.showProjectHints(phpEditor);return doc.querySelector('.CodeMirror-hints')?.textContent.includes('ProjectHintRecord')},'PHP project-symbol completion');phpEditor.setValue('<?php\n$_S');phpEditor.setCursor({line:1,ch:3});doc.defaultView.showProjectHints(phpEditor);await wait(()=>{doc.defaultView.showProjectHints(phpEditor);return doc.querySelector('.CodeMirror-hints')?.textContent.includes('$_SERVER')},'PHP superglobal completion');doc.getElementById('siteReportCompatibility').checked=false;doc.getElementById('siteReportRuntime').checked=false;doc.getElementById('siteReportsBtn').click();await wait(()=>doc.getElementById('siteReportsModal').style.display==='grid','Site Reports dialog');doc.getElementById('siteReportsRun').click();await wait(()=>!doc.getElementById('siteReportsRun').disabled&&doc.getElementById('siteReportStatus').textContent.startsWith('Scanned '),'accessibility site report');const runtime=doc.getElementById('siteReportRuntime');runtime.checked=true;runtime.dispatchEvent(new Event('change',{bubbles:true}));const select=doc.getElementById('siteReportBrowser');await wait(()=>select.multiple&&select.options.length>0,'multi-browser selector');if(!select.selectedOptions.length)throw new Error('No supported browser was selected in the runtime matrix');const priorStatus=doc.getElementById('siteReportStatus').textContent;doc.getElementById('siteReportsRun').click();await wait(()=>doc.getElementById('siteReportStatus').textContent!==priorStatus,'runtime report start');await wait(()=>!doc.getElementById('siteReportsRun').disabled&&doc.getElementById('siteReportStatus').textContent.startsWith('Scanned '),'runtime browser matrix');out.textContent='CUSTOMER-UI-OK'}catch(error){out.textContent='CUSTOMER-UI-FAILED: '+error.message}})();
</script>
"@
        $uiPathSegments = $uiPath.Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) }
        Invoke-WebRequest -Uri "$baseUrl/api/file/$($uiPathSegments -join '/')" -Method Put -Headers $headers -ContentType 'application/json' -Body (@{ content = $uiHtml } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        $uiProfile = Join-Path $env:TEMP "dreamcraft-customer-edge-$PID"
        $uiStdout = Join-Path $env:TEMP "dreamcraft-customer-edge-$PID.out"
        $uiStderr = Join-Path $env:TEMP "dreamcraft-customer-edge-$PID.err"
        Remove-Item -LiteralPath $uiStdout, $uiStderr -Force -ErrorAction SilentlyContinue
        $uiProcess = Start-Process -FilePath $edgeExecutable -WindowStyle Hidden -PassThru -RedirectStandardOutput $uiStdout -RedirectStandardError $uiStderr -ArgumentList @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', "--user-data-dir=`"$uiProfile`"", '--virtual-time-budget=45000', '--timeout=55000', '--dump-dom', "$baseUrl/site/$uiPath")
        try {
            $uiDeadline = [DateTime]::UtcNow.AddSeconds(60)
            while ([DateTime]::UtcNow -lt $uiDeadline) { $uiProcess.Refresh(); if ($uiProcess.HasExited) { break }; Start-Sleep -Milliseconds 250 }
            $uiProcess.Refresh()
            if (-not $uiProcess.HasExited) { Stop-Process -Id $uiProcess.Id -Force -ErrorAction SilentlyContinue; throw 'Customer-site editor UI smoke exceeded 60 seconds.' }
            $dom = if (Test-Path -LiteralPath $uiStdout) { Get-Content -LiteralPath $uiStdout -Raw } else { '' }
            if ($dom -notmatch 'CUSTOMER-UI-OK') {
                $browserError = if (Test-Path -LiteralPath $uiStderr) { Get-Content -LiteralPath $uiStderr -Raw } else { '' }
                throw "Theme and view-mode UI workflow failed. DOM: $dom Browser: $browserError"
            }
            $editorUi = 'passed: themed folder browsing, dark/light themes, PHP project-symbol and superglobal hints, Design/Code/Split modes, live lint/source jump, staged save, accessibility and runtime reports'
        }
        finally {
            $uiProcess.Refresh()
            if (-not $uiProcess.HasExited) { Stop-Process -Id $uiProcess.Id -Force -ErrorAction SilentlyContinue }
            $profilePrefix = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\') + '\'
            $resolvedProfile = [IO.Path]::GetFullPath($uiProfile)
            if (-not $resolvedProfile.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to close an Edge process outside the isolated customer QA profile.' }
            Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($resolvedProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            foreach ($path in @($uiProfile, $uiStdout, $uiStderr)) { if (Test-Path -LiteralPath $path) { $resolved = (Resolve-Path -LiteralPath $path).Path; if ($resolved.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue } } }
            try { Invoke-WebRequest -Uri "$baseUrl/api/file/$($uiPathSegments -join '/')" -Method Delete -Headers $headers -UseBasicParsing | Out-Null } catch {}
        }
    }

    $sourceDigestAfter = Get-ProjectDigest $source
    if ($sourceDigestAfter -ne $sourceDigestBefore) { throw 'The original customer website changed during the staged-copy validation.' }
    $result = if ($findings.Count) { 'completed-with-runtime-warnings' } else { 'passed' }
    [pscustomobject]@{
        project = $project.name
        stagedCopy = $stage
        sourceUntouched = ($sourceDigestAfter -eq $sourceDigestBefore)
        files = $filePaths.Count
        htmlPages = $html.Count
        stylesheets = $css.Count
        javascriptFiles = $javascript.Count
        publishedSnapshotUrl = $snapshot.url
        browserRuntime = $runtime
        runtimeFindings = $runtimeIssues
        editorUi = $editorUi
        totalFindings = $findings.Count
        findings = @($findings | Select-Object -First 50)
        result = $result
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    if ($baseUrl) {
        try { Invoke-WebRequest -Uri "$baseUrl/api/device-preview/stop" -Method Post -Headers @{ Origin = $baseUrl } -UseBasicParsing | Out-Null } catch {}
    }
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    if ($null -eq $oldNoBrowser) { Remove-Item Env:DREAMCRAFT_NO_BROWSER -ErrorAction SilentlyContinue } else { $env:DREAMCRAFT_NO_BROWSER = $oldNoBrowser }
    if ($null -eq $oldLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $oldLocalAppData }
    foreach ($path in @($stage, $appData, $stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $path) {
            $resolved = (Resolve-Path -LiteralPath $path).Path
            if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to clean a QA path outside TEMP: $resolved" }
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

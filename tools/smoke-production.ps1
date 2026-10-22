$ErrorActionPreference = 'Stop'
$executable = (Resolve-Path (Join-Path $PSScriptRoot '..\target\release\dreamcraft.exe')).Path
$stdoutPath = Join-Path $env:TEMP 'dreamcraft-production-smoke.out.log'
$stderrPath = Join-Path $env:TEMP 'dreamcraft-production-smoke.err.log'
$oldBrowserSetting = $env:DREAMCRAFT_NO_BROWSER
$oldLocalAppData = $env:LOCALAPPDATA
$smokeAppData = Join-Path $env:TEMP "dreamcraft-production-smoke-data-$PID"
$databaseSmokePath = "__dreamcraft-smoke-$PID.sqlite"
$browserSmokePath = "__dreamcraft-browser-smoke-$PID.html"
$preprocessorSmokePrefix = "__dreamcraft-preprocessor-smoke-$PID"
$publishedRootHtmlPath = "__dreamcraft-published-root-$PID.html"
$publishedRootCssPath = "__dreamcraft-published-root-$PID.css"
$devicePreviewStarted = $false
$devicePreviewUiResult = 'skipped: Microsoft Edge not installed'
function Remove-SmokeTempPaths {
    param([string[]]$Paths)
    $tempPrefix = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\') + '\'
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $resolved = (Resolve-Path -LiteralPath $path).Path
        if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to remove a smoke-test path outside TEMP: $resolved" }
        try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop } catch { if (Test-Path -LiteralPath $resolved) { throw } }
    }
}
function Invoke-WebRequestAllowError {
    param([Parameter(Mandatory)][string]$Uri, [string]$Method = 'Get', [hashtable]$Headers = @{}, [string]$ContentType, [string]$Body)
    try {
        $parameters = @{ Uri = $Uri; Method = $Method; Headers = $Headers; UseBasicParsing = $true; ErrorAction = 'Stop' }
        if ($PSBoundParameters.ContainsKey('ContentType')) { $parameters.ContentType = $ContentType }
        if ($PSBoundParameters.ContainsKey('Body')) { $parameters.Body = $Body }
        return Invoke-WebRequest @parameters
    } catch {
        $response = $_.Exception.Response
        if (-not $response) { throw }
        $content = ''
        if ($response.PSObject.Properties['Content']) { $content = [string]$response.Content }
        elseif ($response.GetResponseStream()) { $reader = [System.IO.StreamReader]::new($response.GetResponseStream()); try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() } }
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = $content; Headers = $response.Headers }
    }
}
function Close-SmokeBrowserProfile {
    param([string]$ProfilePath)
    $tempPrefix = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\') + '\'
    $resolved = [System.IO.Path]::GetFullPath($ProfilePath)
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing to close a browser outside the smoke profile: $resolved" }
    $matchingProcesses = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($resolved, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
    foreach ($browserProcess in $matchingProcesses) { Stop-Process -Id $browserProcess.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($matchingProcesses) { Start-Sleep -Milliseconds 250 }
}
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
$env:LOCALAPPDATA = $smokeAppData
$env:DREAMCRAFT_NO_BROWSER = '1'
$process = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
try {
    $baseUrl = $null
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 200
        if (Test-Path $stdoutPath) {
            $line = Get-Content $stdoutPath -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($line -match 'http://127\.0\.0\.1:\d+') {
                $baseUrl = $Matches[0]
                break
            }
        }
    }
    if (-not $baseUrl) {
        $details = Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue
        throw "Production executable did not announce its loopback URL. $details"
    }

    $folderRoots = (Invoke-WebRequest -Uri "$baseUrl/api/folders" -UseBasicParsing).Content | ConvertFrom-Json
    if (-not $folderRoots.roots -or @($folderRoots.roots).Count -eq 0) { throw 'The themed folder browser did not receive any available drives.' }
    $smokeFolderPath = [Uri]::EscapeDataString((Join-Path $smokeAppData 'DreamCraft'))
    $smokeFolderList = (Invoke-WebRequest -Uri "$baseUrl/api/folders?path=$smokeFolderPath" -UseBasicParsing).Content | ConvertFrom-Json
    if (-not $smokeFolderList.current -or @($smokeFolderList.folders | Where-Object name -eq 'sites').Count -ne 1) { throw 'The themed folder browser could not navigate local folders.' }

    $homePage = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing
    if ($homePage.StatusCode -ne 200 -or $homePage.Content -notmatch 'DreamCraft' -or $homePage.Content -notmatch 'themeStyles' -or $homePage.Content -notmatch 'siteReportRuntime' -or $homePage.Content -notmatch 'visualMediaQueries' -or $homePage.Content -notmatch 'mqViewport' -or $homePage.Content -notmatch 'assetLibraryModal' -or $homePage.Content -notmatch 'assetLibraryGrid' -or $homePage.Content -notmatch 'nativeWindowControls' -or $homePage.Content -notmatch 'M12 21 18.4 4' -or $homePage.Content -notmatch '/emmet.js' -or $homePage.Content -notmatch 'preprocessorModal' -or $homePage.Content -notmatch 'projectBrowse' -or $homePage.Content -notmatch 'folderPickerModal' -or $homePage.Content -notmatch 'folderPickerList' -or $homePage.Content -notmatch 'workspaceLayoutsModal' -or $homePage.Content -notmatch 'workspaceLayoutSave' -or $homePage.Content -notmatch 'devicePreviewModal' -or $homePage.Content -notmatch 'devicePreviewBtn' -or $homePage.Content -notmatch 'databaseGenerateAuth' -or $homePage.Content -notmatch 'databaseAuthProtect' -or $homePage.Content -notmatch '/workspace-layouts.css' -or $homePage.Content -notmatch '/device-preview.css' -or $homePage.Content -notmatch '/live-diagnostics.css' -or $homePage.Content -notmatch '/file-dialog.css' -or $homePage.Content -notmatch '/preprocessors.css') {
        throw 'Embedded editor home did not return the DreamCraft page.'
    }
    $splashPage = Invoke-WebRequest -Uri "$baseUrl/splash" -UseBasicParsing
    if ($splashPage.StatusCode -ne 200 -or $splashPage.Content -notmatch 'setStartupProgress' -or $splashPage.Content -notmatch 'role="progressbar"') {
        throw 'The embedded native startup window page is missing its accessible progress UI.'
    }
    $script = Invoke-WebRequest -Uri "$baseUrl/app.js" -UseBasicParsing
    if ($script.StatusCode -ne 200 -or $script.Content -notmatch 'bootstrapComponentMarkup' -or $script.Content -notmatch 'executeRemoteManagement' -or $script.Content -notmatch 'inspectCompatibilityHtml' -or $script.Content -notmatch 'generatePhpDataPage' -or $script.Content -notmatch 'generatePhpAuthentication' -or $script.Content -notmatch 'connectRemoteDatabase' -or $script.Content -notmatch 'function applyTheme' -or $script.Content -notmatch 'dreamcraft.theme' -or $script.Content -notmatch 'refreshVisualMediaQueries' -or $script.Content -notmatch 'beginMediaQueryResize' -or $script.Content -notmatch 'setResponsiveViewport' -or $script.Content -notmatch 'openAssetLibrary' -or $script.Content -notmatch 'renderAssetLibrary' -or $script.Content -notmatch 'insertLibraryImage' -or $script.Content -notmatch 'insertLibraryCssUrl' -or $script.Content -notmatch 'dreamcraft-ready' -or $script.Content -notmatch 'rewriteProjectRootUrls' -or $script.Content -notmatch 'Fold all code blocks' -or $script.Content -notmatch 'Unfold all code blocks' -or $script.Content -notmatch 'code-split' -or $script.Content -notmatch 'renderRelatedFiles' -or $script.Content -notmatch 'installWorkspaceResizers' -or $script.Content -notmatch 'restoreWorkspaceLayoutState' -or $script.Content -notmatch 'renderNamedWorkspaceLayouts' -or $script.Content -notmatch 'openDevicePreviewDialog' -or $script.Content -notmatch 'startDevicePreview' -or $script.Content -notmatch 'stopDevicePreview' -or $script.Content -notmatch 'copyDevicePreviewUrl' -or $script.Content -notmatch 'scheduleLiveDiagnostics' -or $script.Content -notmatch 'renderLiveDiagnostics' -or $script.Content -notmatch 'expandEmmetAtCursor' -or $script.Content -notmatch 'runGitBranch' -or $script.Content -notmatch 'renderGitTagControls' -or $script.Content -notmatch 'runGitTag' -or $script.Content -notmatch 'runGitRevert' -or $script.Content -notmatch 'compilePreprocessorFile' -or $script.Content -notmatch 'pollPreprocessorWatch' -or $script.Content -notmatch 'function openFolderPicker' -or $script.Content -notmatch 'function loadFolderPicker' -or $script.Content -match 'dialog:pick-project-folder|dreamcraftSetProjectFolder' -or $script.Content -notmatch "'Ctrl-Q'") {
        throw 'Embedded JavaScript is missing the shipped workflows.'
    }
    if ($script.Content -notmatch 'phpCompletions' -or $script.Content -notmatch 'phpSymbols' -or $script.Content -notmatch "mode === 'php'") { throw 'PHP code completions were not embedded in the production editor.' }
    $emmet = Invoke-WebRequest -Uri "$baseUrl/emmet.js" -UseBasicParsing
    if ($emmet.StatusCode -ne 200 -or $emmet.Content -notmatch 'expandHtml' -or $emmet.Content -notmatch 'expandCss') { throw 'The Emmet expansion module did not ship in the executable.' }
    foreach ($asset in @(
        @{ path = '/preprocessors.css'; pattern = 'preprocessor-modal' },
        @{ path = '/file-dialog.css'; pattern = 'folder-picker-modal' },
        @{ path = '/workspace-layouts.css'; pattern = 'workspace-layouts-modal' },
        @{ path = '/vendor/less/less.min.js'; pattern = 'less\.render|Less' },
        @{ path = '/vendor/less/LICENSE.txt'; pattern = 'Apache License' }
    )) {
        $response = Invoke-WebRequest -Uri "$baseUrl$($asset.path)" -UseBasicParsing
        if ($response.StatusCode -ne 200 -or $response.Content -notmatch $asset.pattern) { throw "Preprocessor or folder-picker asset did not ship: $($asset.path)" }
    }
    $sassPartialPath = "$preprocessorSmokePrefix-tokens.scss"
    $sassSourcePath = "$preprocessorSmokePrefix-main.scss"
    $sassOutputPath = "$preprocessorSmokePrefix-main.css"
    $lessPartialPath = "$preprocessorSmokePrefix-tokens.less"
    $lessSourcePath = "$preprocessorSmokePrefix-main.less"
    $lessOutputPath = "$preprocessorSmokePrefix-main-less.css"
    $lessPagePath = "$preprocessorSmokePrefix-less-check.html"
    $liveReloadPath = "$preprocessorSmokePrefix-live-reload.html"
    $deviceUiTestPath = "$preprocessorSmokePrefix-device-ui-check.html"
    $livePagePath = "$preprocessorSmokePrefix-live.html"
    $livePageSource = '<!doctype html><html><head><link rel="stylesheet" href="/css/site.css"></head><body><img src="/images/hero.png"><p>Live preview</p></body></html>'
    Invoke-WebRequest -Uri "$baseUrl/api/file/$livePagePath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = $livePageSource } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
    $liveVersionBefore = (Invoke-WebRequest -Uri "$baseUrl/api/preview/live-version" -UseBasicParsing).Content
    $livePage = Invoke-WebRequest -Uri "$baseUrl/site/$livePagePath" -UseBasicParsing
    if ($livePage.StatusCode -ne 200 -or $livePage.Headers['Cache-Control'] -notmatch 'no-store' -or $livePage.Content -notmatch 'href="/site/css/site.css"' -or $livePage.Content -notmatch 'src="/site/images/hero.png"' -or $livePage.Content -notmatch '/api/preview/live-version') { throw 'Live preview did not rewrite project URLs, disable caching, or inject its reload watcher.' }
    Invoke-WebRequest -Uri "$baseUrl/api/file/$livePagePath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = $livePageSource.Replace('Live preview', 'Updated live preview') } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
    $liveVersionAfter = (Invoke-WebRequest -Uri "$baseUrl/api/preview/live-version" -UseBasicParsing).Content
    if ($liveVersionAfter -eq $liveVersionBefore) { throw 'Live preview version did not change after a project file was saved.' }
    $publishedRootHtml = '<!doctype html><html><head><link rel="stylesheet" href="/styles.css?v=1"></head><body><a href="/">Home</a><img src="//cdn.example.test/asset.png"></body></html>'
    $publishedRootCss = '@import "/theme.css"; .published-root-smoke { background: url("/assets/hero.png"); }'
    Invoke-WebRequest -Uri "$baseUrl/api/file/$publishedRootHtmlPath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = $publishedRootHtml } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
    Invoke-WebRequest -Uri "$baseUrl/api/file/$publishedRootCssPath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = $publishedRootCss } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
    $publishedSnapshot = (Invoke-WebRequest -Uri "$baseUrl/api/publish" -Method Post -Headers @{ Origin = $baseUrl } -UseBasicParsing).Content | ConvertFrom-Json
    $publishedPrefix = $publishedSnapshot.url -replace '/index\.html$', ''
    $publishedHtml = Invoke-WebRequest -Uri "$baseUrl$publishedPrefix/$publishedRootHtmlPath" -UseBasicParsing
    $publishedCss = Invoke-WebRequest -Uri "$baseUrl$publishedPrefix/$publishedRootCssPath" -UseBasicParsing
    $publishedRootChecks = @(
        ($publishedHtml.Content.Contains("$publishedPrefix/styles.css?v=1")),
        ($publishedHtml.Content.Contains("$publishedPrefix/index.html")),
        ($publishedHtml.Content.Contains('//cdn.example.test/asset.png')),
        ($publishedCss.Content.Contains("$publishedPrefix/theme.css")),
        ($publishedCss.Content.Contains("$publishedPrefix/assets/hero.png"))
    )
    if ($publishedRootChecks -contains $false) { throw "Published snapshot did not preserve root-relative paths. Checks=$($publishedRootChecks -join ',') Prefix=$publishedPrefix HTML=$($publishedHtml.Content) CSS=$($publishedCss.Content)" }
    $sassPartial = Invoke-WebRequest -Uri "$baseUrl/api/file/$sassPartialPath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = '$smoke-accent: #754de8;' } | ConvertTo-Json -Compress) -UseBasicParsing
    $sassSource = Invoke-WebRequest -Uri "$baseUrl/api/file/$sassSourcePath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = ('@use "' + $preprocessorSmokePrefix + '-tokens" as *; $spacing: 12px; .preprocessor-smoke { color: $smoke-accent; .nested { gap: $spacing; } }') } | ConvertTo-Json -Compress) -UseBasicParsing
    $sassBuild = Invoke-WebRequest -Uri "$baseUrl/api/preprocessors/sass" -Method Post -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ path = $sassSourcePath; output = $sassOutputPath; style = 'expanded' } | ConvertTo-Json -Compress) -UseBasicParsing
    $sassCss = Invoke-WebRequest -Uri "$baseUrl/api/file/$sassOutputPath" -Headers @{ Origin = $baseUrl } -UseBasicParsing
    if ($sassPartial.StatusCode -ne 204 -or $sassSource.StatusCode -ne 204 -or $sassBuild.StatusCode -ne 200 -or $sassCss.Content -notmatch '\.preprocessor-smoke' -or $sassCss.Content -notmatch '#754de8' -or $sassCss.Content -notmatch 'gap: 12px') {
        throw "Sass import resolution or expanded CSS output failed: $($sassBuild.Content) $($sassCss.Content)"
    }
    $invalidSassPath = "$preprocessorSmokePrefix-invalid.scss"
    Invoke-WebRequest -Uri "$baseUrl/api/file/$invalidSassPath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = '.broken { color: $undefined-variable; }' } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
    $invalidSass = Invoke-WebRequestAllowError -Uri "$baseUrl/api/preprocessors/sass" -Method Post -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ path = $invalidSassPath; output = "$preprocessorSmokePrefix-invalid.css"; style = 'expanded' } | ConvertTo-Json -Compress)
    $invalidSassOutput = Invoke-WebRequestAllowError -Uri "$baseUrl/api/file/$preprocessorSmokePrefix-invalid.css"
    $unsafeSassPath = Invoke-WebRequestAllowError -Uri "$baseUrl/api/preprocessors/sass" -Method Post -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ path = $sassSourcePath; output = '../outside.css'; style = 'expanded' } | ConvertTo-Json -Compress)
    if ($invalidSass.StatusCode -ne 422 -or $invalidSassOutput.StatusCode -ne 404 -or $unsafeSassPath.StatusCode -ne 400) { throw 'Sass compiler diagnostics or output-path safety checks failed.' }

    $edgeExe = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
    if (-not (Test-Path -LiteralPath $edgeExe)) { $edgeExe = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
    $lessRuntimeResult = 'skipped: Microsoft Edge not installed'
    $liveBrowserResult = 'skipped: Microsoft Edge not installed'
    if (Test-Path -LiteralPath $edgeExe) {
        Invoke-WebRequest -Uri "$baseUrl/api/file/$lessPartialPath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = '@smoke-accent: #157347;' } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        Invoke-WebRequest -Uri "$baseUrl/api/file/$lessSourcePath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = '@import "' + $preprocessorSmokePrefix + '-tokens.less"; .less-preprocessor-smoke { color: @smoke-accent; .nested { width: 2 * 6px; } }' } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        $lessRuntimeHtml = @"
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Less compiler smoke</title><script src="$baseUrl/vendor/less/less.min.js"></script></head><body><pre id="result">COMPILING</pre><script>
(async()=>{const target=document.getElementById('result');try{const response=await fetch('$baseUrl/site/$lessSourcePath');if(!response.ok)throw new Error('Could not fetch Less entry point');const source=await response.text();const compiled=await less.render(source,{filename:'$baseUrl/site/$lessSourcePath',paths:['$baseUrl/site/'],javascriptEnabled:false});target.textContent='LESS-BROWSER-COMPILE-OK:'+compiled.css}catch(error){target.textContent='LESS-BROWSER-COMPILE-FAILED: '+error.message}})();
</script></body></html>
"@
        Invoke-WebRequest -Uri "$baseUrl/api/file/$lessPagePath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = $lessRuntimeHtml } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        $edgeProfile = Join-Path $env:TEMP "dreamcraft-less-headless-$PID"
        $edgeStdout = Join-Path $env:TEMP "dreamcraft-less-headless-$PID.out"
        $edgeStderr = Join-Path $env:TEMP "dreamcraft-less-headless-$PID.err"
        Remove-Item -LiteralPath $edgeStdout, $edgeStderr -Force -ErrorAction SilentlyContinue
        $edgeArgs = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', "--user-data-dir=`"$edgeProfile`"", '--virtual-time-budget=10000', '--timeout=20000', '--dump-dom', "$baseUrl/site/$lessPagePath")
        $edgeProcess = Start-Process -FilePath $edgeExe -ArgumentList $edgeArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $edgeStdout -RedirectStandardError $edgeStderr
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(35)
            while ([DateTime]::UtcNow -lt $deadline) { $edgeProcess.Refresh(); if ($edgeProcess.HasExited) { break }; Start-Sleep -Milliseconds 250 }
            $edgeProcess.Refresh()
            if (-not $edgeProcess.HasExited) { Stop-Process -Id $edgeProcess.Id -Force -ErrorAction SilentlyContinue; throw 'The isolated Less browser test did not finish within 35 seconds.' }
            $lessDom = if (Test-Path -LiteralPath $edgeStdout) { Get-Content -LiteralPath $edgeStdout -Raw } else { '' }
            if ($lessDom -notmatch 'LESS-BROWSER-COMPILE-OK' -or $lessDom -notmatch '\.less-preprocessor-smoke' -or $lessDom -notmatch '#157347' -or $lessDom -notmatch 'width: 12px') {
                $lessBrowserError = if (Test-Path -LiteralPath $edgeStderr) { Get-Content -LiteralPath $edgeStderr -Raw } else { '' }
                throw "Bundled Less browser compilation failed. DOM: $lessDom Browser output: $lessBrowserError"
            }
        } finally {
            $edgeProcess.Refresh()
            if (-not $edgeProcess.HasExited) { Stop-Process -Id $edgeProcess.Id -Force -ErrorAction SilentlyContinue }
            Close-SmokeBrowserProfile $edgeProfile
            Remove-SmokeTempPaths @($edgeProfile, $edgeStdout, $edgeStderr)
        }
        $lessRuntimeResult = 'passed: bundled Less.js, browser import, generated CSS file'

        $liveSecondPage = '<!doctype html><html lang="en"><meta charset="utf-8"><body><p id="state">LIVE-PREVIEW-RELOAD-OK</p></body></html>'
        $liveSecondPageJson = @{ content = $liveSecondPage } | ConvertTo-Json -Compress
        $liveReloadHtml = @"
<!doctype html><html lang="en"><meta charset="utf-8"><body><p id="state">WAITING-FOR-LIVE-RELOAD</p><script>
if(!sessionStorage.getItem('dreamcraft-live-smoke')){sessionStorage.setItem('dreamcraft-live-smoke','1');setTimeout(()=>fetch('$baseUrl/api/file/$liveReloadPath',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify($liveSecondPageJson)}),1800)}
</script></body></html>
"@
        Invoke-WebRequest -Uri "$baseUrl/api/file/$liveReloadPath" -Method Put -Headers @{ Origin = $baseUrl } -ContentType 'application/json' -Body (@{ content = $liveReloadHtml } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        $liveEdgeProfile = Join-Path $env:TEMP "dreamcraft-live-preview-headless-$PID"
        $liveEdgeStdout = Join-Path $env:TEMP "dreamcraft-live-preview-headless-$PID.out"
        $liveEdgeStderr = Join-Path $env:TEMP "dreamcraft-live-preview-headless-$PID.err"
        Remove-Item -LiteralPath $liveEdgeStdout, $liveEdgeStderr -Force -ErrorAction SilentlyContinue
        $liveEdgeArgs = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', "--user-data-dir=`"$liveEdgeProfile`"", '--virtual-time-budget=14000', '--timeout=25000', '--dump-dom', "$baseUrl/site/$liveReloadPath")
        $liveEdgeProcess = Start-Process -FilePath $edgeExe -ArgumentList $liveEdgeArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $liveEdgeStdout -RedirectStandardError $liveEdgeStderr
        try {
            $liveDeadline = [DateTime]::UtcNow.AddSeconds(35)
            while ([DateTime]::UtcNow -lt $liveDeadline) { $liveEdgeProcess.Refresh(); if ($liveEdgeProcess.HasExited) { break }; Start-Sleep -Milliseconds 250 }
            $liveEdgeProcess.Refresh()
            if (-not $liveEdgeProcess.HasExited) { Stop-Process -Id $liveEdgeProcess.Id -Force -ErrorAction SilentlyContinue; throw 'The live preview reload test did not finish within 35 seconds.' }
            $liveDom = if (Test-Path -LiteralPath $liveEdgeStdout) { Get-Content -LiteralPath $liveEdgeStdout -Raw } else { '' }
            if ($liveDom -notmatch 'LIVE-PREVIEW-RELOAD-OK') {
                $liveBrowserError = if (Test-Path -LiteralPath $liveEdgeStderr) { Get-Content -LiteralPath $liveEdgeStderr -Raw } else { '' }
                throw "External browser did not reload the changed project page. DOM: $liveDom Browser output: $liveBrowserError"
            }
        } finally {
            $liveEdgeProcess.Refresh()
            if (-not $liveEdgeProcess.HasExited) { Stop-Process -Id $liveEdgeProcess.Id -Force -ErrorAction SilentlyContinue }
            Close-SmokeBrowserProfile $liveEdgeProfile
            Remove-SmokeTempPaths @($liveEdgeProfile, $liveEdgeStdout, $liveEdgeStderr)
        }
        $liveBrowserResult = 'passed: Edge reloaded the project page after its file changed'

        $deviceUiHtml = @"
<!doctype html><html lang="en"><meta charset="utf-8"><body><pre id="result">DEVICE-UI-CHECKING</pre><iframe id="editor" src="$baseUrl/"></iframe><script>
(async()=>{const out=document.getElementById('result');try{const frame=document.getElementById('editor');await new Promise((resolve,reject)=>{if(frame.contentDocument?.readyState==='complete'){resolve();return}frame.addEventListener('load',resolve,{once:true});setTimeout(()=>reject(new Error('DreamCraft editor did not load')),12000)});const doc=frame.contentDocument;const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error('Timed out waiting for a DreamCraft device-preview control')};await wait(()=>doc.getElementById('devicePreviewBtn')&&doc.getElementById('devicePreviewStart'));const status=await fetch('/api/device-preview/status');if(!status.ok)throw new Error('Device-preview status returned HTTP '+status.status);doc.getElementById('devicePreviewBtn').click();await wait(()=>doc.getElementById('devicePreviewModal').style.display==='grid');doc.getElementById('devicePreviewStart').click();await wait(()=>doc.getElementById('devicePreviewUrl').value);const url=doc.getElementById('devicePreviewUrl').value;if(!url.includes('/preview/'))throw new Error('The editor did not display a tokenized device link');doc.getElementById('devicePreviewStop').click();await wait(()=>doc.getElementById('devicePreviewStop').disabled);out.textContent='DEVICE-PREVIEW-UI-OK'}catch(error){out.textContent='DEVICE-PREVIEW-UI-FAILED: '+error.message}})();
</script></body></html>
"@
        Invoke-WebRequest -Uri "$baseUrl/api/file/$deviceUiTestPath" -Method Put -Headers $localHeaders -ContentType 'application/json' -Body (@{ content = $deviceUiHtml } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        $deviceUiProfile = Join-Path $env:TEMP "dreamcraft-device-ui-headless-$PID"
        $deviceUiStdout = Join-Path $env:TEMP "dreamcraft-device-ui-headless-$PID.out"
        $deviceUiStderr = Join-Path $env:TEMP "dreamcraft-device-ui-headless-$PID.err"
        Remove-Item -LiteralPath $deviceUiStdout, $deviceUiStderr -Force -ErrorAction SilentlyContinue
        $deviceUiArgs = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', "--user-data-dir=`"$deviceUiProfile`"", '--virtual-time-budget=26000', '--timeout=35000', '--dump-dom', "$baseUrl/site/$deviceUiTestPath")
        $deviceUiProcess = Start-Process -FilePath $edgeExe -ArgumentList $deviceUiArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $deviceUiStdout -RedirectStandardError $deviceUiStderr
        try {
            $deviceUiDeadline = [DateTime]::UtcNow.AddSeconds(45)
            while ([DateTime]::UtcNow -lt $deviceUiDeadline) { $deviceUiProcess.Refresh(); if ($deviceUiProcess.HasExited) { break }; Start-Sleep -Milliseconds 250 }
            $deviceUiProcess.Refresh()
            if (-not $deviceUiProcess.HasExited) { Stop-Process -Id $deviceUiProcess.Id -Force -ErrorAction SilentlyContinue; throw 'The device-preview UI test did not finish within 45 seconds.' }
            $deviceUiDom = if (Test-Path -LiteralPath $deviceUiStdout) { Get-Content -LiteralPath $deviceUiStdout -Raw } else { '' }
            if ($deviceUiDom -notmatch 'DEVICE-PREVIEW-UI-OK') {
                $deviceUiError = if (Test-Path -LiteralPath $deviceUiStderr) { Get-Content -LiteralPath $deviceUiStderr -Raw } else { '' }
                throw "DreamCraft Device Preview UI did not complete its start/stop flow. DOM: $deviceUiDom Browser output: $deviceUiError"
            }
        } finally {
            $deviceUiProcess.Refresh()
            if (-not $deviceUiProcess.HasExited) { Stop-Process -Id $deviceUiProcess.Id -Force -ErrorAction SilentlyContinue }
            Close-SmokeBrowserProfile $deviceUiProfile
            Remove-SmokeTempPaths @($deviceUiProfile, $deviceUiStdout, $deviceUiStderr)
        }
        $devicePreviewUiResult = 'passed: Edge editor modal status, start, copyable token URL, and stop controls'
    }
    foreach ($foldAsset in @(
        @{ path = '/vendor/codemirror/addon/fold/foldcode.js'; pattern = 'foldAll' },
        @{ path = '/vendor/codemirror/addon/fold/foldgutter.js'; pattern = 'foldGutter' },
        @{ path = '/vendor/codemirror/addon/fold/xml-fold.js'; pattern = 'findMatchingClose' },
        @{ path = '/vendor/codemirror/addon/fold/brace-fold.js'; pattern = 'registerHelper\("fold", "brace"' },
        @{ path = '/vendor/codemirror/addon/fold/foldgutter.css'; pattern = 'CodeMirror-foldgutter-open' }
    )) {
        $fold = Invoke-WebRequest -Uri "$baseUrl$($foldAsset.path)" -UseBasicParsing
        if ($fold.StatusCode -ne 200 -or $fold.Content -notmatch $foldAsset.pattern) { throw "Code folding asset did not ship: $($foldAsset.path)" }
    }
    $compatibility = Invoke-WebRequest -Uri "$baseUrl/vendor/browser-compat/index.json" -UseBasicParsing
    if ($compatibility.StatusCode -ne 200 -or $compatibility.Content -notmatch '"packageVersion":"8.1.6"' -or $compatibility.Content -notmatch '"display.grid"') {
        throw 'The embedded browser compatibility index is missing or invalid.'
    }
    $compatibilityModule = Invoke-WebRequest -Uri "$baseUrl/compatibility.mjs" -UseBasicParsing
    if ($compatibilityModule.StatusCode -ne 200 -or $compatibilityModule.Content -notmatch 'compatibilityReasons') {
        throw 'The browser compatibility module did not ship in the executable.'
    }
    $jsAnalyzer = Invoke-WebRequest -Uri "$baseUrl/js-analyzer.mjs" -UseBasicParsing
    if ($jsAnalyzer.StatusCode -ne 200 -or $jsAnalyzer.Content -notmatch 'analyzeJavaScript') {
        throw 'The JavaScript browser compatibility analyzer did not ship in the executable.'
    }
    $phpScaffolder = Invoke-WebRequest -Uri "$baseUrl/php-scaffolder.mjs" -UseBasicParsing
    if ($phpScaffolder.StatusCode -ne 200 -or $phpScaffolder.Content -notmatch 'buildPhpDataPage' -or .Content -notmatch 'buildPhpAuthenticationFiles' -or $phpScaffolder.Content -notmatch 'DREAMCRAFT_DB_PASSWORD' -or $phpScaffolder.Content -notmatch 'pgsql:host' -or $phpScaffolder.Content -notmatch 'pageSize = 25' -or $phpScaffolder.Content -notmatch '\$h\(\$field' -or $phpScaffolder.Content -match '<\?= h\(') {
        throw 'The SQLite/MySQL/PostgreSQL PHP page generator or its record search, pagination, and escaping helpers did not ship in the executable.'
    }
    $localHeaders = @{ Origin = $baseUrl }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    $testingServerResult = 'skipped: Python runtime not installed'
    if ($python) {
        $testingSettings = @{ command = $python.Source; arguments = @('-m', 'http.server', '{port}', '--bind', '127.0.0.1', '--directory', '{project}') }
        Invoke-WebRequest -Uri "$baseUrl/api/testing/settings" -Method Put -Headers $localHeaders -ContentType 'application/json' -Body ($testingSettings | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        $testingStart = Invoke-WebRequest -Uri "$baseUrl/api/testing/start" -Method Post -Headers $localHeaders -UseBasicParsing
        $testingInfo = $testingStart.Content | ConvertFrom-Json
        if ($testingStart.StatusCode -ne 200 -or -not $testingInfo.running -or $testingInfo.url -notmatch '^http://127\.0\.0\.1:\d+$') { throw "Dynamic testing server did not start with a loopback URL: $($testingStart.Content)" }
        $testingPage = Invoke-WebRequestAllowError -Uri "$($testingInfo.url)/index.html"
        $testingStatus = Invoke-WebRequest -Uri "$baseUrl/api/testing/status" -Headers $localHeaders -UseBasicParsing
        if ($testingPage.StatusCode -ne 200 -or $testingPage.Content -notmatch 'Studio Atelier' -or $testingStatus.Content -notmatch '"running":true') { throw 'Dynamic testing-server process did not serve the active project or report its running state.' }
        Invoke-WebRequest -Uri "$baseUrl/api/testing/stop" -Method Post -Headers $localHeaders -UseBasicParsing | Out-Null
        if ((Invoke-WebRequest -Uri "$baseUrl/api/testing/status" -Headers $localHeaders -UseBasicParsing).Content -notmatch '"running":false') { throw 'Dynamic testing-server process did not stop.' }
        $testingServerResult = 'passed: Python HTTP server, {port}/{project} arguments, loopback readiness, project response, status, and stop'
    }
    $devicePreviewStatus = Invoke-WebRequest -Uri "$baseUrl/api/device-preview/status" -Headers $localHeaders -UseBasicParsing
    if ($devicePreviewStatus.StatusCode -ne 200 -or $devicePreviewStatus.Content -notmatch '"active":false') { throw 'The device-preview status route did not start in the stopped state.' }
    $deviceStart = Invoke-WebRequest -Uri "$baseUrl/api/device-preview/start" -Method Post -Headers $localHeaders -UseBasicParsing
    $deviceInfo = $deviceStart.Content | ConvertFrom-Json
    $devicePreviewStarted = $deviceInfo.active -eq $true
    if ($deviceStart.StatusCode -ne 200 -or -not $devicePreviewStarted -or $deviceInfo.url -notmatch '^http://\d{1,3}(\.\d{1,3}){3}:\d+/preview/[0-9a-f]{32}/index\.html$') { throw "Connected-device preview did not start with a tokenized LAN URL: $($deviceStart.Content)" }
    $devicePage = Invoke-WebRequest -Uri $deviceInfo.url -UseBasicParsing
    $deviceVersionUrl = $deviceInfo.url -replace '/index\.html$', '/live-version'
    $deviceVersionBefore = (Invoke-WebRequest -Uri $deviceVersionUrl -UseBasicParsing).Content
    $deviceOrigin = ([Uri]$deviceInfo.url).GetLeftPart([UriPartial]::Authority)
    $deviceApiResponse = Invoke-WebRequestAllowError -Uri "$deviceOrigin/api/files"
    $invalidDeviceTokenUrl = $deviceInfo.url -replace '/preview/([0-9a-f]{32})/', '/preview/00000000000000000000000000000000/'
    $invalidDeviceToken = Invoke-WebRequestAllowError -Uri $invalidDeviceTokenUrl
    if ($devicePage.StatusCode -ne 200 -or $devicePage.Headers['Cache-Control'] -notmatch 'no-store' -or $devicePage.Content -notmatch '/preview/[0-9a-f]{32}/live-version' -or $deviceApiResponse.StatusCode -ne 404 -or $invalidDeviceToken.StatusCode -ne 404) { throw 'Connected-device preview content, token restriction, or read-only route isolation failed.' }
    Invoke-WebRequest -Uri "$baseUrl/api/file/$livePagePath" -Method Put -Headers $localHeaders -ContentType 'application/json' -Body (@{ content = $livePageSource + '<!-- device change -->' } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
    $deviceVersionAfter = (Invoke-WebRequest -Uri $deviceVersionUrl -UseBasicParsing).Content
    if ($deviceVersionAfter -eq $deviceVersionBefore) { throw 'Connected-device live version did not change after the project was edited.' }
    Invoke-WebRequest -Uri "$baseUrl/api/device-preview/stop" -Method Post -Headers $localHeaders -UseBasicParsing | Out-Null
    $devicePreviewStarted = $false
    $devicePreviewStopped = Invoke-WebRequest -Uri "$baseUrl/api/device-preview/status" -Headers $localHeaders -UseBasicParsing
    if ($devicePreviewStopped.Content -notmatch '"active":false') { throw 'Connected-device preview did not stop cleanly.' }
    $browsers = Invoke-WebRequest -Uri "$baseUrl/api/browsers" -Headers $localHeaders -UseBasicParsing
    if ($browsers.StatusCode -ne 200 -or $browsers.Content -notmatch '^\s*\[') { throw 'Installed browser discovery did not return a browser list.' }
    $browserNames = @($browsers.Content | ConvertFrom-Json | ForEach-Object { $_.name })
    $invalidExternalPreview = Invoke-WebRequestAllowError -Uri "$baseUrl/api/preview/open-external" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body (@{ browser_id = 'edge'; url = 'https://example.com/' } | ConvertTo-Json -Compress)
    if ($invalidExternalPreview.StatusCode -ne 400) { throw "External preview URL validation returned HTTP $($invalidExternalPreview.StatusCode), expected 400." }
    $runtimeBrowser = @($browsers.Content | ConvertFrom-Json | Where-Object { $_.id -in @('edge', 'chrome', 'chromium', 'brave') } | Select-Object -First 1)
    $runtimeBrowserResult = 'skipped: no installed Chromium browser'
    if ($runtimeBrowser.Count -gt 0) {
        $runtimeHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Runtime diagnostics fixture</title></head><body><script>console.error("dreamcraft runtime console fixture"); throw new Error("dreamcraft runtime exception fixture");</script><img src="/missing-runtime-fixture.png"></body></html>'
        Invoke-WebRequest -Uri "$baseUrl/api/file/$browserSmokePath" -Method Put -Headers $localHeaders -ContentType 'application/json' -Body (@{ content = $runtimeHtml } | ConvertTo-Json -Compress) -UseBasicParsing | Out-Null
        try {
            $snapshot = Invoke-WebRequest -Uri "$baseUrl/api/publish" -Method Post -Headers $localHeaders -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
            $fixtureUrl = $snapshot.url.Replace('/index.html', "/$browserSmokePath")
            $snapshotUrl = [Uri]::new([Uri]$baseUrl, $fixtureUrl).AbsoluteUri
            $runtimeReport = Invoke-WebRequest -Uri "$baseUrl/api/preview/browser-test" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body (@{ browser_id = $runtimeBrowser[0].id; url = $snapshotUrl } | ConvertTo-Json -Compress) -UseBasicParsing
            $runtimeJson = $runtimeReport.Content | ConvertFrom-Json
            $runtimeIssueText = ($runtimeJson.issues | ForEach-Object { $_.message }) -join [Environment]::NewLine
            if (-not $runtimeJson.loaded -or $runtimeIssueText -notmatch 'runtime exception fixture' -or $runtimeIssueText -notmatch 'runtime console fixture' -or $runtimeIssueText -notmatch 'HTTP 404') {
                throw "Headless browser runtime diagnostics did not report all fixture failures: $($runtimeReport.Content)"
            }
            $runtimeBrowserResult = "passed: $($runtimeBrowser[0].name), $($runtimeJson.issues.Count) findings"
        } finally {
            try { Invoke-WebRequest -Uri "$baseUrl/api/file/$browserSmokePath" -Method Delete -Headers $localHeaders -UseBasicParsing | Out-Null } catch {}
        }
    }
    $remoteConnection = Invoke-WebRequest -Uri "$baseUrl/api/database/remote/connection" -Headers $localHeaders -UseBasicParsing
    if ($remoteConnection.StatusCode -ne 200 -or $remoteConnection.Content -notmatch '"connected":false') { throw 'The external database connection status route did not return a clean disconnected state.' }
    $invalidRemoteConnection = Invoke-WebRequestAllowError -Uri "$baseUrl/api/database/remote/connection" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body '{"engine":"invalid","name":"Smoke test","host":"127.0.0.1","port":3306,"database":"test","username":"test","password":""}'
    if ($invalidRemoteConnection.StatusCode -ne 400) { throw "External database engine validation returned HTTP $($invalidRemoteConnection.StatusCode), expected 400." }
    $disconnectRemote = Invoke-WebRequestAllowError -Uri "$baseUrl/api/database/remote/connection" -Method Delete -Headers $localHeaders
    if ($disconnectRemote.StatusCode -ne 204) { throw 'The external database disconnect route did not return 204.' }
    $databaseFiles = Invoke-WebRequest -Uri "$baseUrl/api/database/files" -Headers $localHeaders -UseBasicParsing
    if ($databaseFiles.StatusCode -ne 200) { throw 'The SQLite database browser endpoint did not respond.' }
    $database = Invoke-WebRequest -Uri "$baseUrl/api/database/create" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body (@{ path = $databaseSmokePath } | ConvertTo-Json -Compress) -UseBasicParsing
    if ($database.StatusCode -ne 200) { throw 'DreamCraft could not create a project SQLite database.' }
    $createTable = Invoke-WebRequest -Uri "$baseUrl/api/database/query" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body (@{ path = $databaseSmokePath; sql = 'CREATE TABLE smoke_test (id INTEGER PRIMARY KEY, label TEXT NOT NULL)'; params = @() } | ConvertTo-Json -Compress) -UseBasicParsing
    $insertRow = Invoke-WebRequest -Uri "$baseUrl/api/database/query" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body (@{ path = $databaseSmokePath; sql = 'INSERT INTO smoke_test(label) VALUES (?1)'; params = @('production smoke') } | ConvertTo-Json -Compress) -UseBasicParsing
    $selectRows = Invoke-WebRequest -Uri "$baseUrl/api/database/query" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body (@{ path = $databaseSmokePath; sql = 'SELECT id, label FROM smoke_test WHERE label = ?1'; params = @('production smoke') } | ConvertTo-Json -Compress) -UseBasicParsing
    $databaseSchema = Invoke-WebRequest -Uri "$baseUrl/api/database/schema" -Method Post -Headers $localHeaders -ContentType 'application/json' -Body (@{ path = $databaseSmokePath } | ConvertTo-Json -Compress) -UseBasicParsing
    if ($insertRow.Content -notmatch '"changes":1' -or $selectRows.Content -notmatch 'production smoke' -or $databaseSchema.Content -notmatch 'smoke_test' -or $databaseSchema.Content -notmatch '"primaryKeyOrder":1') {
        throw 'SQLite query execution, bound parameters, or schema inspection failed.'
    }

    $routes = @('/api/deploy/delete', '/api/deploy/rename', '/api/ftp/delete', '/api/ftp/rename', '/api/webdav/delete', '/api/webdav/rename')
    foreach ($route in $routes) {
        $body = if ($route.EndsWith('/rename')) { '{"from":"pages/old.html","to":"pages/new.html"}' } else { '{"paths":["pages/old.html"]}' }
        $response = Invoke-WebRequestAllowError -Uri "$baseUrl$route" -Method Post -ContentType 'application/json' -Body $body
        if ($response.StatusCode -ne 400) {
            throw "Route $route returned HTTP $($response.StatusCode), expected the registered unconfigured response 400."
        }
    }

    [pscustomobject]@{
        executable = $executable
        bytes = (Get-Item $executable).Length
        loopbackUrl = $baseUrl
        editorStatus = $homePage.StatusCode
        splashStatus = $splashPage.StatusCode
        embeddedScriptStatus = $script.StatusCode
        emmetStatus = $emmet.StatusCode
        compatibilityIndexStatus = $compatibility.StatusCode
        javascriptAnalyzerStatus = $jsAnalyzer.StatusCode
        phpScaffolderStatus = $phpScaffolder.StatusCode
        databaseCreateStatus = $database.StatusCode
        sassCompileStatus = $sassBuild.StatusCode
        lessRuntimeCompilation = $lessRuntimeResult
        liveExternalPreview = $liveBrowserResult
        connectedDevicePreview = 'passed: token-scoped LAN page, live revision, no editor API, start and stop'
        connectedDevicePreviewUi = $devicePreviewUiResult
        dynamicTestingServer = $testingServerResult
        publishedSnapshotRootAssets = 'passed: root-relative HTML, CSS, query, domain-root, and external CDN URLs'
        databaseSchemaStatus = $databaseSchema.StatusCode
        remoteDatabaseStatus = $remoteConnection.StatusCode
        remoteDatabaseValidationStatus = $invalidRemoteConnection.StatusCode
        externalBrowserDiscoveryStatus = $browsers.StatusCode
        externalBrowsers = $browserNames
        externalPreviewValidationStatus = $invalidExternalPreview.StatusCode
        runtimeBrowserDiagnostics = $runtimeBrowserResult
        registeredRemoteRoutes = $routes.Count
        result = 'passed'
    } | ConvertTo-Json -Compress
}
finally {
    if ($baseUrl) {
        try { Invoke-WebRequest -Uri "$baseUrl/api/device-preview/stop" -Method Post -Headers @{ Origin = $baseUrl } -UseBasicParsing | Out-Null } catch {}
        try { Invoke-WebRequest -Uri "$baseUrl/api/testing/stop" -Method Post -Headers @{ Origin = $baseUrl } -UseBasicParsing | Out-Null } catch {}
        try { Invoke-WebRequest -Uri "$baseUrl/api/file/$databaseSmokePath" -Method Delete -Headers @{ Origin = $baseUrl } -UseBasicParsing | Out-Null } catch {}
        try { Invoke-WebRequest -Uri "$baseUrl/api/file/$browserSmokePath" -Method Delete -Headers @{ Origin = $baseUrl } -UseBasicParsing | Out-Null } catch {}
        foreach ($path in @($sassOutputPath, $sassSourcePath, $sassPartialPath, $invalidSassPath, $preprocessorSmokePrefix + '-invalid.css', $lessOutputPath, $lessSourcePath, $lessPartialPath, $lessPagePath, $livePagePath, $liveReloadPath, $deviceUiTestPath, $publishedRootHtmlPath, $publishedRootCssPath)) {
            try { Invoke-WebRequest -Uri "$baseUrl/api/file/$path" -Method Delete -Headers @{ Origin = $baseUrl } -UseBasicParsing | Out-Null } catch {}
        }
    }
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    if ($null -eq $oldBrowserSetting) {
        Remove-Item Env:DREAMCRAFT_NO_BROWSER -ErrorAction SilentlyContinue
    }
    else {
        $env:DREAMCRAFT_NO_BROWSER = $oldBrowserSetting
    }
    if ($null -eq $oldLocalAppData) {
        Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
    }
    else {
        $env:LOCALAPPDATA = $oldLocalAppData
    }
    if (Test-Path -LiteralPath $smokeAppData) {
        $resolvedSmokeData = (Resolve-Path -LiteralPath $smokeAppData).Path
        $resolvedTemp = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\') + '\'
        if ($resolvedSmokeData.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedSmokeData -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}










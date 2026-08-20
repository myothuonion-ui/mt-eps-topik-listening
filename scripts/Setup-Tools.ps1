param(
  [switch]$SkipWhisper,
  [switch]$InstallPoTokenProvider,
  [switch]$UpdateYtDlp
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $ProjectRoot 'data\tools'
$YtDlp = Join-Path $ToolsDir 'yt-dlp.exe'
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
Write-Host '[TOOLS] MT EPS Listening Factory local tools setup' -ForegroundColor Cyan

function Has-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Install-LocalYtDlp {
  $temp = Join-Path $ToolsDir ("yt-dlp.{0}.download" -f [guid]::NewGuid())
  $backup = Join-Path $ToolsDir ("yt-dlp.{0}.backup" -f [guid]::NewGuid())
  try {
    Write-Host '[DOWNLOAD] Current yt-dlp standalone executable...' -ForegroundColor Yellow
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $temp
    $version = (& $temp --version 2>&1 | Select-Object -First 1).ToString().Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d{4}\.\d{2}\.\d{2}') { throw 'Downloaded yt-dlp executable failed its version check.' }
    if (Test-Path -LiteralPath $YtDlp) { Move-Item -LiteralPath $YtDlp -Destination $backup }
    try { Move-Item -LiteralPath $temp -Destination $YtDlp }
    catch { if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $YtDlp }; throw }
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] yt-dlp $version installed locally" -ForegroundColor Green
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

try {
  if (-not (Has-Command 'ffmpeg')) {
    if (Has-Command 'winget') {
      Write-Host '[INSTALL] FFmpeg...' -ForegroundColor Yellow
      winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) { throw "winget could not install FFmpeg (exit $LASTEXITCODE)." }
    } else { throw 'FFmpeg is missing and winget is unavailable. Install FFmpeg and FFprobe, add them to PATH, then rerun this script.' }
  } else { Write-Host '[OK] FFmpeg ready' -ForegroundColor Green }

  if (-not (Test-Path -LiteralPath $YtDlp) -or $UpdateYtDlp) { Install-LocalYtDlp }
  else {
    $installedVersion = (& $YtDlp --version 2>&1 | Select-Object -First 1).ToString().Trim()
    Write-Host "[OK] Local yt-dlp $installedVersion ready. Use the app's Update button to check/replace it safely." -ForegroundColor Green
  }

  if (-not $SkipWhisper) {
    if (-not (Has-Command 'whisper')) {
      $python = if (Has-Command 'python') { 'python' } elseif (Has-Command 'py') { 'py' } else { $null }
      if ($python) {
        Write-Host '[INSTALL] OpenAI Whisper CLI. This optional fallback can take several minutes...' -ForegroundColor Yellow
        & $python -m pip install -U openai-whisper
        if ($LASTEXITCODE -ne 0) { Write-Warning "Python could not install openai-whisper (exit $LASTEXITCODE). Captions-based jobs still work; rerun the displayed pip command before processing a source without Korean captions." }
      } else { Write-Warning 'Python was not found. Whisper is only required when Korean captions are unavailable. Install Python 3, then run: python -m pip install -U openai-whisper' }
    } else { Write-Host '[OK] Whisper ready' -ForegroundColor Green }
  } else { Write-Host '[SKIP] Whisper was explicitly skipped. It is only required when Korean captions are unavailable.' -ForegroundColor DarkGray }

  try {
    Add-Type -AssemblyName System.Speech
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $koreanVoices = @($speaker.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'ko-*' })
    $speaker.Dispose()
    if ($koreanVoices.Count -gt 0) { Write-Host ("[OK] Korean Windows TTS voice: {0}" -f $koreanVoices[0].VoiceInfo.Name) -ForegroundColor Green }
    else { Write-Warning 'No Korean Windows speech voice was found. Windows Local TTS requires: Settings > Time & language > Language & region > Korean > Language options > install Speech. Gemini TTS remains available.' }
  } catch { Write-Warning 'Windows System.Speech voice detection failed. Gemini TTS remains available.' }

  if ($InstallPoTokenProvider) {
    if (-not (Has-Command 'git')) { throw 'Git is required to install the optional PO Token provider.' }
    if (-not (Has-Command 'node')) { throw 'Node.js 20 or newer is required to build the optional PO Token provider.' }
    $providerRoot = Join-Path $ToolsDir 'bgutil-ytdlp-pot-provider'
    if (Test-Path -LiteralPath (Join-Path $providerRoot '.git')) {
      Write-Host '[UPDATE] PO Token provider source...' -ForegroundColor Yellow
      git -C $providerRoot pull --ff-only
      if ($LASTEXITCODE -ne 0) { throw "Could not update PO Token provider source (exit $LASTEXITCODE)." }
    } else {
      Write-Host '[INSTALL] PO Token provider source...' -ForegroundColor Yellow
      git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git $providerRoot
      if ($LASTEXITCODE -ne 0) { throw "Could not clone PO Token provider (exit $LASTEXITCODE)." }
    }
    $providerServer = Join-Path $providerRoot 'server'
    Push-Location $providerServer
    try {
      npm ci
      if ($LASTEXITCODE -ne 0) { throw "PO Token provider npm install failed (exit $LASTEXITCODE)." }
      npx tsc
      if ($LASTEXITCODE -ne 0) { throw "PO Token provider build failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
    $pluginSource = Join-Path $providerRoot 'yt_dlp_plugins'
    $pluginRoot = Join-Path $ToolsDir 'yt-dlp-plugins\yt_dlp_plugins'
    if (-not (Test-Path -LiteralPath $pluginSource)) { throw 'Provider build completed, but yt_dlp_plugins was not found in the provider checkout.' }
    New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
    Copy-Item -Path (Join-Path $pluginSource '*') -Destination $pluginRoot -Recurse -Force
    Write-Host '[OK] PO Token provider plugin + local script ready. Restart the Listening Factory.' -ForegroundColor Green
  } else {
    Write-Host '[OPTIONAL] PO Token provider is installed only when needed. Command:' -ForegroundColor DarkGray
    Write-Host '  powershell -File scripts\Setup-Tools.ps1 -InstallPoTokenProvider' -ForegroundColor DarkGray
  }

  Write-Host ''
  Write-Host 'Tool setup finished. If winget changed PATH, close and reopen the launcher once.' -ForegroundColor Cyan
  exit 0
} catch {
  Write-Error ("Tool setup failed: {0}" -f $_.Exception.Message)
  exit 1
}

param([switch]$SkipWhisper)
$ErrorActionPreference = 'Continue'
Write-Host '[TOOLS] MT EPS Listening Factory local tools setup' -ForegroundColor Cyan

function Has-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

if (-not (Has-Command 'ffmpeg')) {
  if (Has-Command 'winget') {
    Write-Host '[INSTALL] FFmpeg...' -ForegroundColor Yellow
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
  } else { Write-Warning 'FFmpeg missing and winget is unavailable. Install FFmpeg manually.' }
} else { Write-Host '[OK] FFmpeg ready' -ForegroundColor Green }

if (-not (Has-Command 'yt-dlp')) {
  if (Has-Command 'winget') {
    Write-Host '[INSTALL] yt-dlp...' -ForegroundColor Yellow
    winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements
  } else { Write-Host '[INFO] App can auto-download a private yt-dlp.exe into data/tools.' -ForegroundColor DarkGray }
} else { Write-Host '[OK] yt-dlp ready' -ForegroundColor Green }

if (-not $SkipWhisper) {
  if (-not (Has-Command 'whisper')) {
    $python = $null
    if (Has-Command 'python') { $python = 'python' } elseif (Has-Command 'py') { $python = 'py' }
    if ($python) {
      Write-Host '[INSTALL] OpenAI Whisper CLI. First install can take several minutes...' -ForegroundColor Yellow
      & $python -m pip install -U openai-whisper
    } else { Write-Warning 'Python not found. Whisper fallback cannot be installed automatically. Captions-based YouTube sources still work.' }
  } else { Write-Host '[OK] Whisper ready' -ForegroundColor Green }
}

Write-Host ''
Write-Host 'Tool setup finished. If winget changed PATH, close/reopen the app once.' -ForegroundColor Cyan

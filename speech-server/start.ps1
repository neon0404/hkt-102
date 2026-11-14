$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.cache\python'
$env:SPEECH_TOKEN = (Get-Content (Join-Path $PSScriptRoot '.cache\token') -Raw).Trim()
$env:SPEECH_HOST = (& 'C:\Program Files\Tailscale\tailscale.exe' ip -4 | Select-Object -First 1).Trim()
Write-Host "Речевой сервис: http://$($env:SPEECH_HOST):8791"
uv run --python-preference only-managed python server.py

# Речевой сервис на компьютере оператора

Распознавание голосовых (Whisper large-v3-turbo) и голос роликов (Silero v5) на видеокарте.
Сервер AI-маркетолога обращается к нему по Tailscale; если компьютер выключен — работает на своих моделях.

Запуск (PowerShell):

```powershell
cd speech-server
$env:SPEECH_TOKEN = '<тот же, что SPEECH_TOKEN в .env сервера>'
$env:SPEECH_HOST = '<адрес этого компьютера в Tailscale, например 100.64.0.7>'
uv run python server.py
```

На сервере в `.env`: `SPEECH_URL=http://<адрес в Tailscale>:8791`, `SPEECH_TOKEN=<токен>`.
Голоса Silero: `eugene`, `aidar` (мужские), `xenia`, `baya`, `kseniya` (женские) — переменная `TTS_SPEAKER`.

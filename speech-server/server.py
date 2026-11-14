import base64
import os
import subprocess
import threading
import time

_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
os.environ.setdefault("HF_HOME", os.path.join(_CACHE, "hf"))
os.environ.setdefault("TORCH_HOME", os.path.join(_CACHE, "torch"))

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

TOKEN = os.environ.get("SPEECH_TOKEN", "")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
STT_MODEL = os.environ.get("STT_MODEL", "openai/whisper-large-v3-turbo")
TTS_SPEAKER = os.environ.get("TTS_SPEAKER", "eugene")
TTS_RATE = 48000

app = FastAPI()
_lock = threading.Lock()
_asr = None
_tts = None


def check(token: str | None) -> None:
    if not TOKEN or token != TOKEN:
        raise HTTPException(status_code=401, detail="bad token")


def asr():
    global _asr
    if _asr is None:
        from transformers import pipeline
        _asr = pipeline(
            "automatic-speech-recognition", model=STT_MODEL, device=DEVICE,
            torch_dtype=torch.float16 if DEVICE == "cuda" else torch.float32,
        )
    return _asr


def tts():
    global _tts
    if _tts is None:
        model, _ = torch.hub.load("snakers4/silero-models", "silero_tts", language="ru", speaker="v5_ru", trust_repo=True)
        model.to(torch.device(DEVICE))
        _tts = model
    return _tts


def decode(audio: bytes) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-t", "180", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
        input=audio, capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE, "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None}


@app.post("/stt")
async def stt(request: Request, x_token: str | None = Header(default=None)):
    check(x_token)
    pcm = decode(await request.body())
    if len(pcm) < 8000:
        return {"text": ""}
    t0 = time.time()
    with _lock:
        out = asr()(pcm.copy(), generate_kwargs={"language": "russian", "task": "transcribe"}, return_timestamps=len(pcm) > 16000 * 28)
    text = " ".join(out["text"].split())
    print(f"[stt] {len(pcm) / 16000:.1f} с → {time.time() - t0:.2f} с: {text[:80]}", flush=True)
    return {"text": text}


@app.post("/tts")
async def synth(request: Request, x_token: str | None = Header(default=None)):
    check(x_token)
    body = await request.json()
    speaker = body.get("speaker") or TTS_SPEAKER
    clips = []
    t0 = time.time()
    with _lock:
        model = tts()
        for text in body.get("texts", []):
            text = " ".join(str(text).split())
            if not text:
                clips.append("")
                continue
            audio = model.apply_tts(text=text[:900], speaker=speaker, sample_rate=TTS_RATE, put_accent=True, put_yo=True)
            pcm = audio.detach().cpu().numpy().astype(np.float32)
            clips.append(base64.b64encode(pcm.tobytes()).decode())
    print(f"[tts] {len(clips)} реплик, {speaker} → {time.time() - t0:.2f} с", flush=True)
    return JSONResponse({"rate": TTS_RATE, "clips": clips})


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("SPEECH_HOST", "127.0.0.1")
    if os.environ.get("SPEECH_WARMUP", "1") == "1":
        asr(); tts()
        print("[speech] модели загружены", flush=True)
    uvicorn.run(app, host=host, port=int(os.environ.get("SPEECH_PORT", "8791")), log_level="warning")

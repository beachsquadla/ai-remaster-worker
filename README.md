# Hybrid Serverless AI Audio Remastering — Phase 1: Stem Separation MVP

A production-ready system that separates audio into individual stems (vocals, drums, bass, guitar, piano, other) using HTDemucs on RunPod Serverless GPU infrastructure. Designed to cost **~$0.005–0.008 per track** vs. $0.075+ on fal.ai.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│             │     │                  │     │                    │
│  Gradio UI  │────▶│  VPS API (3095)  │────▶│ RunPod Serverless  │
│  (Web App)  │     │  Node/Express     │     │  (HTDemucs Docker) │
│             │◀────│  + SQLite Job Mgr│◀────│                    │
└─────────────┘     └──────────────────┘     └────────────────────┘
                          │                          │
                          ▼                          ▼
                     ┌──────────┐             ┌──────────┐
                     │ Storage/  │             │  GPU     │
                     │ Stems Dir │             │  (CUDA)  │
                     └──────────┘             └──────────┘
```

### Components

| Component | Location | Technology |
|-----------|----------|------------|
| **RunPod Worker** | `docker/demucs-worker/` | Python, PyTorch 2.2.0, HTDemucs |
| **VPS API** | `api/` | Node.js, Express, SQLite |
| **Web UI** | `ui/` | Python, Gradio |
| **Config** | `runpod-config.json` | RunPod endpoint template |

## Prerequisites

1. **A Contabo VPS** (or similar) running Ubuntu 22.04+ with:
   - Node.js 18+ and npm
   - Python 3.11+ with pip
   - Ports 3095 (API) and 7860 (UI) available
   
2. **A RunPod account** with Serverless access:
   - RunPod API Key
   - Container Registry (Docker Hub, GitHub Container Registry, etc.)

3. **Docker** (for building the worker image):
   - Only needed on your build machine, not on the VPS
   - Docker Desktop or Docker Engine

## Setup Instructions

### 1. Build and Deploy the RunPod Worker

```bash
# Build the Docker image
cd docker/demucs-worker
docker build -t demucs-worker:latest .

# Tag and push to your container registry
docker tag demucs-worker:latest ghcr.io/YOUR_USERNAME/demucs-worker:latest
docker push ghcr.io/YOUR_USERNAME/demucs-worker:latest
```

### 2. Create a RunPod Serverless Endpoint

1. Log into [runpod.io](https://runpod.io) → **Serverless**
2. Click **"New Endpoint"**
3. Use the settings from `runpod-config.json`:
   - **Container Image**: Your pushed image URL
   - **GPU Type**: RTX 4090 or A100 (4090 is most cost-effective)
   - **Min Workers**: 1 (keeps 1 warm for fast cold starts)
   - **Max Workers**: 3 (scales up under load)
   - **Idle Timeout**: 30 seconds
   - **Container Disk**: 20 GB
4. Click **Create**
5. Note your **Endpoint ID** — you'll need it below

### 3. Set Up the VPS API

```bash
# Navigate to the AI Remaster directory
cd ~/beachside-premium/ai-remaster/api

# Install dependencies
npm install

# Set environment variables (add to ~/.bashrc or .env)
export RUNPOD_API_KEY="your_runpod_api_key_here"
export RUNPOD_ENDPOINT_ID="your_endpoint_id_here"
export PORT=3095

# Start the API
node server.js

# For production: use PM2
npm install -g pm2
pm2 start server.js --name ai-remaster-api
```

### 4. Launch the Web UI

```bash
# Install Python dependencies
pip install gradio requests

# Start the UI
cd ~/beachside-premium/ai-remaster/ui
python gradio_app.py --port 7860

# Optional: create a public share link for testing from mobile
python gradio_app.py --port 7860 --share

# For production: use PM2 or screen/tmux
pm2 start --interpreter python3 gradio_app.py --name ai-remaster-ui -- --port 7860
```

### 5. Firewall

Ensure ports are accessible:

```bash
# Allow API and UI ports
sudo ufw allow 3095/tcp
sudo ufw allow 7860/tcp
```

## API Reference

All endpoints are served from `http://YOUR_VPS:3095/api/remaster/`

### `POST /upload`
Upload an audio file for stem separation.

- **Method**: `POST`
- **Content-Type**: `multipart/form-data`
- **Field**: `file` (audio file)
- **Response**: `{ "job_id": "abc12345", "status": "processing" }`

### `GET /status/:jobId`
Check the status of a job.

- **Response**: `{ "job_id": "abc12345", "status": "done", "stems": ["vocals.wav", ...] }`

### `GET /result/:jobId`
Get the result of a completed job with download URLs.

- **Response**: `{ "job_id": "abc12345", "stems": [{ "name": "vocals.wav", "url": "...", "size": 1234 }] }`

### `POST /callback/:jobId`
Webhook endpoint for RunPod to POST results back. Internal use only.

### `GET /health`
Health check endpoint.

## Cost Analysis (Phase 1)

| Provider | Cost per Track | Notes |
|----------|---------------|-------|
| **This system** (RTX 4090) | ~$0.005–0.008 | 1-min track, <10s inference |
| fal.ai | $0.075+ | 15x more expensive |
| Replicate | $0.05+ | 10x more expensive |

Cost savings come from:
- Using RunPod Serverless (pay per second, not per request)
- NVIDIA RTX 4090 ($0.34/hr) instead of A100 ($1.10+/hr)
- Short inference times (5-15s for typical tracks)

## File Structure

```
~/beachside-premium/ai-remaster/
├── README.md                       # This file
├── runpod-config.json              # RunPod endpoint template
├── docker/
│   └── demucs-worker/
│       ├── Dockerfile              # Container build instructions
│       ├── handler.py              # RunPod Serverless handler
│       └── stem_mixer.py           # Stem mixing utility
├── api/
│   ├── package.json                # Node.js dependencies
│   ├── server.js                   # Express server (port 3095)
│   ├── job-manager.js              # SQLite job tracking
│   ├── routes/
│   │   └── remaster.js             # API routes
│   └── storage/                    # Uploads & processed stems
│       ├── uploads/                # Uploaded audio files
│       └── stems/                  # Separated stem files
└── ui/
    └── gradio_app.py               # Gradio web interface
```

## Troubleshooting

### "Could not connect to the API"
- Verify the API server is running: `pm2 status` or `ps aux | grep server.js`
- Check the port: `ss -tlnp | grep 3095`
- Verify firewall: `sudo ufw status`

### Job stuck on "processing"
- Check RunPod dashboard for the endpoint
- Verify `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` are set correctly
- Check the VPS API logs for callback errors

### Docker build fails
- Ensure CUDA 12.4 compatible GPU or use `--platform linux/amd64`
- Check available disk space (model weights need ~2GB)

### GPU not detected in Docker
- RunPod handles GPU passthrough automatically
- For local testing: `docker run --gpus all demucs-worker:latest`

## Next Steps (Future Phases)

- **Phase 2**: Build a custom demixing model (Demucs fine-tuned on specific genres)
- **Phase 3**: Integrate audio enhancement effects (EQ, compression, reverb)
- **Phase 4**: Full remastering pipeline with reference-track matching
- **Phase 5**: Telegram bot integration for mobile access

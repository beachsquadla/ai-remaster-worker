# =============================================================================
# Dockerfile for HTDemucs Stem Separation Worker (v2 — S3 Transfer)
# =============================================================================
# This container runs on RunPod Serverless and performs 6-stem audio separation
# using the HTDemucs model from Meta's Demucs library.
#
# Key design decisions (per Gemini architectural review):
#   1. S3-compatible transfer — audio is passed as a download URL, NOT Base64.
#      The VPS uploads to a temp S3 bucket, passes the URL to RunPod.
#      The worker downloads, processes, uploads results, and returns the URL.
#   2. Cold-start readiness — RunPod workers take 10-15s to spin up from idle.
#      The VPS-side job manager uses polling and the UI shows a progress bar.
#
# Base image: NVIDIA CUDA 12.4 runtime on Ubuntu 22.04 for GPU acceleration.
# =============================================================================

FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

# ---------------------------------------------------------------------------
# Install system dependencies
# ---------------------------------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-dev \
        python3-pip \
        ffmpeg \
        libsndfile1 \
        wget \
        curl \
        ca-certificates \
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set python3 to point to python3.11
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# ---------------------------------------------------------------------------
# Install Python packages
# ---------------------------------------------------------------------------
# PyTorch + CUDA 12.4 for GPU inference
RUN pip3 install --no-cache-dir torch==2.4.0 torchaudio==2.4.0 \
    --index-url https://download.pytorch.org/whl/cu124

RUN pip3 install --no-cache-dir \
    demucs \
    soundfile \
    librosa \
    requests \
    runpod \
    boto3  # S3-compatible upload for results

# ---------------------------------------------------------------------------
# Pre-cache the HTDemucs model weights (~400MB)
# ---------------------------------------------------------------------------
# This avoids cold-start download penalty on first request.
# Gemini confirmed: pre-caching weights is the right call.
RUN python3 -c "from demucs import pretrained; pretrained.get_model('htdemucs')" && \
    echo "HTDemucs model weights cached successfully"

# ---------------------------------------------------------------------------
# Copy application code
# ---------------------------------------------------------------------------
COPY handler.py /app/handler.py
COPY stem_mixer.py /app/stem_mixer.py

WORKDIR /app

# ---------------------------------------------------------------------------
# Start command
# ---------------------------------------------------------------------------
# RunPod Serverless expects the handler to start with runpod.serverless.start()
# The -u flag ensures unbuffered stdout/stderr for log visibility.
# ---------------------------------------------------------------------------
# S3/MinIO environment variables (for result upload)
# ---------------------------------------------------------------------------
ENV S3_ENDPOINT=http://144.126.147.170:9000
ENV S3_ACCESS_KEY=remaster-worker
ENV S3_SECRET_KEY=PWRVM63VXWSzFtstEJMqWphsyxwDoMP9
ENV S3_BUCKET=audio-remaster-temp
ENV S3_PUBLIC_URL=http://144.126.147.170:9000

# ---------------------------------------------------------------------------
# Start command
# ---------------------------------------------------------------------------
# RunPod Serverless expects the handler to start with runpod.serverless.start()
# The -u flag ensures unbuffered stdout/stderr for log visibility.
CMD ["python3", "-u", "handler.py"]

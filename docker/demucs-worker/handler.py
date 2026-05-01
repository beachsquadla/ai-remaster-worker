# =============================================================================
# RunPod Serverless Handler for HTDemucs Stem Separation (v3 — S3 Upload)
# =============================================================================
# This handler runs inside the RunPod Serverless environment.
#
# DATA TRANSFER STRATEGY:
#   INPUT:  VPS uploads audio to MinIO S3, passes the download URL to RunPod.
#           Worker downloads from URL — NO Base64 in API payloads.
#   OUTPUT: Worker uploads each stem WAV to MinIO S3, returns download URLs.
#           The VPS receives the URLs and serves them to the user.
#
# COLD-START STRATEGY:
#   RunPod Serverless cold-starts take 10-15s from idle. The VPS-side job
#   manager uses runsync which handles the cold-start retry loop.
#
# Audio: 44.1kHz, 16-bit, mono during processing.
# Output stems: 44.1kHz, 16-bit WAV files.
# =============================================================================

import os
import sys
import json
import tempfile
import tarfile
import logging
import shutil
import mimetypes
from pathlib import Path
from urllib.parse import urlparse

import runpod
import requests
import soundfile as sf
import torch as th
import boto3  # For S3-compatible upload (MinIO)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("demucs-handler")

# ---------------------------------------------------------------------------
# S3 Configuration (from environment variables)
# ---------------------------------------------------------------------------
S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://144.126.147.170:9000")
S3_ACCESS_KEY = os.environ.get("S3_ACCESS_KEY", "remaster-worker")
S3_SECRET_KEY = os.environ.get("S3_SECRET_KEY", "PWRVM63VXWSzFtstEJMqWphsyxwDoMP9")
S3_BUCKET = os.environ.get("S3_BUCKET", "audio-remaster-temp")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_PUBLIC_URL = os.environ.get("S3_PUBLIC_URL", "http://144.126.147.170:9000")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SUPPORTED_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
TARGET_SAMPLE_RATE = 44100
TARGET_SUBTYPE = "PCM_16"
REQUEST_TIMEOUT = 300
STEMS_DIR_PREFIX = "stems"


def get_s3_client():
    """Get a boto3 S3 client configured for MinIO."""
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        region_name=S3_REGION,
        config=boto3.session.Config(signature_version="s3v4"),
    )


def upload_to_s3(file_path, s3_key):
    """Upload a file to S3-compatible storage and return its public URL."""
    try:
        s3 = get_s3_client()
        # Determine content type
        content_type, _ = mimetypes.guess_type(file_path)
        if content_type is None:
            content_type = "audio/wav"

        extra_args = {
            "ContentType": content_type,
            "ACL": "public-read",
        }

        s3.upload_file(file_path, S3_BUCKET, s3_key, ExtraArgs=extra_args)
        url = f"{S3_PUBLIC_URL}/{S3_BUCKET}/{s3_key}"
        logger.info(f"Uploaded to S3: {url}")
        return url
    except Exception as e:
        logger.error(f"S3 upload failed for {file_path}: {e}")
        return None


def download_audio(audio_url, output_path):
    """Download audio from a URL to a local file using streaming."""
    logger.info(f"Downloading audio from: {audio_url}")
    response = requests.get(audio_url, stream=True, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    with open(output_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
    file_size = os.path.getsize(output_path)
    logger.info(f"Downloaded {file_size} bytes to {output_path}")


def run_demucs_separation(input_path, output_dir):
    """Run HTDemucs separation. Tries 6-stem model, falls back to 4-stem."""
    logger.info(f"Starting Demucs separation on: {input_path}")

    from demucs import pretrained
    from demucs.apply import apply_model
    import librosa

    # Try 6-stem model, fallback to 4-stem
    try:
        model = pretrained.get_model("htdemucs_6s")
        logger.info("Using htdemucs_6s model (6 stems)")
        model_name = "htdemucs_6s"
    except Exception:
        model = pretrained.get_model("htdemucs")
        logger.info("htdemucs_6s not available, using htdemucs (4 stems)")
        model_name = "htdemucs"

    # Load audio
    audio, sr = librosa.load(input_path, sr=None, mono=False)
    if audio.ndim == 1:
        audio = audio[None, :]

    # Resample to 44.1kHz if needed
    if sr != TARGET_SAMPLE_RATE:
        logger.info(f"Resampling from {sr}Hz to {TARGET_SAMPLE_RATE}Hz")
        audio = librosa.resample(
            audio, orig_sr=sr, target_sr=TARGET_SAMPLE_RATE, res_type="kaiser_fast"
        )
        sr = TARGET_SAMPLE_RATE

    audio_tensor = th.from_numpy(audio).float()
    device = "cuda" if th.cuda.is_available() else "cpu"
    audio_tensor = audio_tensor.to(device)
    model = model.to(device)
    audio_tensor = audio_tensor.unsqueeze(0)

    # Run inference
    logger.info(f"Running Demucs inference on {device}...")
    with th.no_grad():
        sources = apply_model(
            model, audio_tensor, device=device,
            shifts=1, split=True, overlap=0.25
        )
    logger.info(f"Inference complete. Sources shape: {sources.shape}")

    # Determine stem names
    if model_name == "htdemucs_6s":
        stem_names = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    else:
        stem_names = ["vocals", "drums", "bass", "other"]

    sources = sources.squeeze(0).cpu().numpy()
    track_name = Path(input_path).stem
    stem_output_dir = Path(output_dir) / model_name / track_name
    stem_output_dir.mkdir(parents=True, exist_ok=True)

    # Save each stem
    saved_stems = []
    for idx, stem_name in enumerate(stem_names):
        if idx < sources.shape[0]:
            stem_audio = sources[idx].T
            output_path = stem_output_dir / f"{stem_name}.wav"
            sf.write(str(output_path), stem_audio, sr, subtype=TARGET_SUBTYPE)
            saved_stems.append(str(output_path))
            logger.info(f"Saved stem: {output_path}")

    return str(stem_output_dir), saved_stems


# ===========================================================================
# RunPod Handler
# ===========================================================================
def handler(job):
    """
    RunPod serverless handler for audio stem separation.

    Job input:
        - audio_url: URL to download audio from (required)
        - job_id: Unique job ID for tracking (optional)

    Returns:
        Dict with status, stems (list of {name, url, size}), and metadata.
    """
    job_input = job.get("input", {})
    job_id = job.get("id", "unknown")
    vps_job_id = job_input.get("job_id", job_id)
    logger.info(f"Job {job_id} (VPS: {vps_job_id}) started")

    # Validate input
    audio_url = job_input.get("audio_url")
    if not audio_url:
        return {"status": "error", "error": "Missing required field: 'audio_url'", "job_id": vps_job_id}

    # Set up temp working directory
    temp_dir = tempfile.mkdtemp(prefix=f"demucs_{job_id}_")
    input_path = os.path.join(temp_dir, "input_audio")
    output_dir = os.path.join(temp_dir, "output")

    try:
        # Step 1: Download audio from URL
        download_audio(audio_url, input_path)

        # Step 2: Run Demucs separation
        stem_dir, saved_stems = run_demucs_separation(input_path, output_dir)
        if not saved_stems:
            raise RuntimeError("Demucs produced no stem files")

        # Step 3: Upload each stem to S3 and build result
        stem_results = []
        s3_stem_prefix = f"{STEMS_DIR_PREFIX}/{vps_job_id}"

        for stem_path in saved_stems:
            stem_name = os.path.basename(stem_path)
            s3_key = f"{s3_stem_prefix}/{stem_name}"
            public_url = upload_to_s3(stem_path, s3_key)

            stem_results.append({
                "name": stem_name,
                "url": public_url,
                "size": os.path.getsize(stem_path),
            })

        # Create a tar.gz archive of all stems for bulk download
        archive_path = os.path.join(temp_dir, "stems.tar.gz")
        with tarfile.open(archive_path, "w:gz") as tar:
            for stem_path in saved_stems:
                tar.add(stem_path, arcname=os.path.basename(stem_path))
        archive_key = f"{s3_stem_prefix}/stems.tar.gz"
        archive_url = upload_to_s3(archive_path, archive_key)
        archive_size = os.path.getsize(archive_path)

        # Count successful uploads
        uploaded_count = sum(1 for s in stem_results if s.get("url"))

        result = {
            "status": "completed",
            "job_id": vps_job_id,
            "stems": [s["name"] for s in stem_results],
            "stems_count": len(stem_results),
            "stems_uploaded": uploaded_count,
            "stem_urls": stem_results,
            "archive_url": archive_url,
            "archive_size": archive_size,
            "s3_prefix": s3_stem_prefix,
        }

        logger.info(f"Job {job_id} completed: {len(stem_results)} stems, {uploaded_count} uploaded to S3")
        return result

    except Exception as e:
        logger.error(f"Job {job_id} failed: {e}", exc_info=True)
        return {"status": "error", "error": str(e), "job_id": vps_job_id}

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ===========================================================================
# Entry point
# ===========================================================================
if __name__ == "__main__":
    logger.info("Starting Demucs RunPod Serverless handler (v3 - S3)...")
    runpod.serverless.start({"handler": handler})

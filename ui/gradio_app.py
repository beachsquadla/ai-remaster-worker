# =============================================================================
# Gradio Web UI for Stem Separation MVP
# =============================================================================
#
# This is a simple web interface for testing the stem separation system.
# Users can:
#   1. Upload an audio file (drag & drop or file picker)
#   2. Submit it for stem separation
#   3. Watch the job progress
#   4. View, listen to, and download separated stems
#   5. A/B toggle between the original audio and the re-summed full mix
#
# The UI communicates with the VPS-side Node.js API at http://localhost:3095
# (or the REMASTER_API_URL environment variable if set).
#
# Theme: Dark mode, professional look.
# =============================================================================

import os
import json
import time
import tempfile
import logging
from pathlib import Path

import gradio as gr
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# API base URL — defaults to localhost:3095, override with REMASTER_API_URL env var
API_BASE_URL = os.environ.get("REMASTER_API_URL", "http://localhost:3095")
API_UPLOAD_URL = f"{API_BASE_URL}/api/remaster/upload"
API_STATUS_URL = f"{API_BASE_URL}/api/remaster/status"
API_RESULT_URL = f"{API_BASE_URL}/api/remaster/result"

# Polling interval for job status (seconds)
POLL_INTERVAL = 2.0

# Maximum time to wait for a job to complete (seconds)
MAX_WAIT_TIME = 600  # 10 minutes — should be more than enough

# Supported audio formats for upload
SUPPORTED_FORMATS = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".aiff"]

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("gradio-ui")


# ---------------------------------------------------------------------------
# API helper functions
# ---------------------------------------------------------------------------

def upload_audio(file_path):
    """
    Upload an audio file to the remaster API for stem separation.
    
    Args:
        file_path: Path to the audio file on disk.
    
    Returns:
        Tuple of (success: bool, result: dict or error string).
    """
    if not file_path:
        return False, "No file selected. Please upload an audio file."

    # Validate file exists
    if not os.path.exists(file_path):
        return False, f"File not found: {file_path}"

    # Validate file extension
    ext = Path(file_path).suffix.lower()
    if ext not in SUPPORTED_FORMATS:
        return False, (
            f"Unsupported file format: '{ext}'. "
            f"Supported formats: {', '.join(SUPPORTED_FORMATS)}"
        )

    logger.info(f"Uploading file: {file_path}")

    try:
        with open(file_path, "rb") as f:
            files = {"file": (os.path.basename(file_path), f, "audio/mpeg")}
            response = requests.post(
                API_UPLOAD_URL,
                files=files,
                timeout=60,  # 60 second timeout for upload
            )

        if response.status_code == 201:
            data = response.json()
            logger.info(f"Upload successful. Job ID: {data.get('job_id')}")
            return True, data
        else:
            error_msg = f"Upload failed (HTTP {response.status_code}): {response.text}"
            logger.error(error_msg)
            return False, error_msg

    except requests.exceptions.ConnectionError:
        return False, (
            f"Could not connect to the API at {API_BASE_URL}. "
            f"Make sure the server is running."
        )
    except requests.exceptions.Timeout:
        return False, "Upload timed out. Please try again with a smaller file."
    except Exception as e:
        return False, f"Upload error: {str(e)}"


def poll_job_status(job_id, progress=None):
    """
    Poll the job status endpoint until the job completes or fails.
    
    Args:
        job_id: The job ID to poll.
        progress: Gradio progress bar object (optional).
    
    Returns:
        Tuple of (success: bool, result: dict or error string).
    """
    status_url = f"{API_STATUS_URL}/{job_id}"
    start_time = time.time()

    while time.time() - start_time < MAX_WAIT_TIME:
        try:
            response = requests.get(status_url, timeout=10)
            data = response.json()

            status = data.get("status", "unknown")
            elapsed = int(time.time() - start_time)

            # Update progress bar
            if progress:
                progress(
                    elapsed / MAX_WAIT_TIME,
                    desc=f"Status: {status} ({elapsed}s elapsed)",
                )

            if status == "done":
                logger.info(f"Job {job_id} completed after {elapsed}s")
                return True, data

            if status == "error":
                error_msg = data.get("error", "Unknown error")
                logger.error(f"Job {job_id} failed: {error_msg}")
                return False, f"Processing failed: {error_msg}"

            # Still queued or processing — wait and retry
            time.sleep(POLL_INTERVAL)

        except requests.exceptions.RequestException as e:
            logger.warning(f"Status poll error for job {job_id}: {e}")
            time.sleep(POLL_INTERVAL)

    # Timeout reached
    return False, (
        f"Timed out after {MAX_WAIT_TIME // 60} minutes. "
        f"The job may still be processing. Check the status endpoint."
    )


def fetch_job_result(job_id):
    """
    Fetch the detailed result of a completed job.
    
    Args:
        job_id: The completed job ID.
    
    Returns:
        Tuple of (success: bool, result: dict or error string).
    """
    result_url = f"{API_RESULT_URL}/{job_id}"

    try:
        response = requests.get(result_url, timeout=10)
        data = response.json()

        if data.get("status") == "done":
            return True, data
        else:
            return False, f"Job is not done yet (status: {data.get('status')})"

    except Exception as e:
        return False, f"Failed to fetch result: {str(e)}"


# =============================================================================
# Gradio UI functions
# =============================================================================

def process_audio(file):
    """
    Main processing function called when the user clicks "Separate Stems".
    
    This is a generator that yields updates for the Gradio UI:
      1. Shows upload progress
      2. Shows job status while processing
      3. Returns the results with stems and A/B comparison
    
    Args:
        file: Gradio file object from the upload component.
    """
    if file is None:
        yield (
            gr.update(value=""),  # original audio player
            gr.update(value=None),  # original audio file
            None,  # upload result text
            None,  # job ID display
            None,  # progress bar
            gr.update(visible=False),  # stems section
            gr.update(visible=False),  # A/B toggle
            gr.update(choices=[], value=None),  # stem selector
            None,  # stem play button
            None,  # stem download button
        )
        return

    # ------------------------------------------------------------------
    # Step 1: Upload the audio file
    # ------------------------------------------------------------------
    yield (
        gr.update(value=None),  # clear original player
        file,  # keep the original file ref
        "📤 Uploading audio file...",
        None,
        gr.update(value=0, visible=True),
        gr.update(visible=False),
        gr.update(visible=False),
        gr.update(choices=[], value=None),
        gr.update(value=None),
        gr.update(value=None),
    )

    success, result = upload_audio(file)

    if not success:
        yield (
            gr.update(value=None),
            file,
            f"❌ {result}",
            None,
            gr.update(value=None, visible=False),
            gr.update(visible=False),
            gr.update(visible=False),
            gr.update(choices=[], value=None),
            gr.update(value=None),
            gr.update(value=None),
        )
        return

    job_id = result.get("job_id", "unknown")

    # ------------------------------------------------------------------
    # Step 2: Poll for job completion
    # ------------------------------------------------------------------
    yield (
        gr.update(value=None),
        file,
        f"⏳ Processing job {job_id}... (this takes 15-60s)",
        f"Job: {job_id}",
        gr.update(value=0.1, visible=True),
        gr.update(visible=False),
        gr.update(visible=False),
        gr.update(choices=[], value=None),
        gr.update(value=None),
        gr.update(value=None),
    )

    success, status_data = poll_job_status(job_id)

    if not success:
        yield (
            gr.update(value=None),
            file,
            f"❌ {status_data}",
            f"Job: {job_id}",
            gr.update(value=None, visible=False),
            gr.update(visible=False),
            gr.update(visible=False),
            gr.update(choices=[], value=None),
            gr.update(value=None),
            gr.update(value=None),
        )
        return

    # ------------------------------------------------------------------
    # Step 3: Fetch the result
    # ------------------------------------------------------------------
    yield (
        gr.update(value=None),
        file,
        f"✅ Complete! Fetching stems...",
        f"Job: {job_id}",
        gr.update(value=0.9, visible=True),
        gr.update(visible=False),
        gr.update(visible=False),
        gr.update(choices=[], value=None),
        gr.update(value=None),
        gr.update(value=None),
    )

    success, result_data = fetch_job_result(job_id)

    if not success:
        yield (
            gr.update(value=None),
            file,
            f"❌ {result_data}",
            f"Job: {job_id}",
            gr.update(value=None, visible=False),
            gr.update(visible=False),
            gr.update(visible=False),
            gr.update(choices=[], value=None),
            gr.update(value=None),
            gr.update(value=None),
        )
        return

    # ------------------------------------------------------------------
    # Step 4: Display stems
    # ------------------------------------------------------------------
    stems = result_data.get("stems", [])
    stem_names = [s["name"] for s in stems]
    stem_urls = {s["name"]: s["url"] for s in stems}

    # Build a dictionary for Gradio dropdown choices
    stem_choices = [(s["name"], s["name"]) for s in stems]

    yield (
        gr.update(value=file),  # original file for player
        file,
        f"✅ Done! {len(stems)} stems extracted.",
        f"Job: {job_id}",
        gr.update(value=1.0, visible=False),
        gr.update(visible=True),  # show stems section
        gr.update(visible=True, value="Full Mix"),  # show A/B toggle
        gr.update(choices=stem_choices, value=stem_choices[0][0] if stem_choices else None),
        None,
        None,
    )


def on_stem_select(stem_name, job_id_state):
    """
    When a stem is selected from the dropdown, update the audio player.
    
    Args:
        stem_name: The selected stem name.
        job_id_state: The current job ID.
    """
    if not stem_name or not job_id_state:
        return None, None

    # Construct the URL for the stem file
    stem_url = f"{API_BASE_URL}/api/remaster/storage/stems/{job_id_state}/{stem_name}"
    return stem_url, stem_url


def load_original_audio(original_file):
    """
    Return the original audio file for the A/B player.
    """
    if original_file is None:
        return None
    return original_file


# =============================================================================
# Build the Gradio interface
# =============================================================================

# Custom CSS for dark theme and professional styling
CUSTOM_CSS = """
    .gradio-container {
        max-width: 900px !important;
        margin: 0 auto;
    }
    .main-header {
        text-align: center;
        margin-bottom: 1.5rem;
    }
    .main-header h1 {
        font-size: 1.8rem;
        font-weight: 700;
        margin-bottom: 0.25rem;
    }
    .main-header p {
        color: var(--body-text-color-subdued);
        font-size: 0.95rem;
    }
    .status-text {
        font-size: 1rem;
        padding: 0.75rem;
        border-radius: 8px;
        background: var(--background-fill-primary);
    }
    .stem-section {
        border-top: 1px solid var(--border-color-primary);
        padding-top: 1rem;
    }
    .footer {
        text-align: center;
        font-size: 0.8rem;
        color: var(--body-text-color-subdued);
        padding-top: 2rem;
    }
"""

with gr.Blocks(
    theme=gr.themes.Soft(
        primary_hue="blue",
        secondary_hue="slate",
        neutral_hue="slate",
        font=gr.themes.GoogleFont("Inter"),
    ),
    css=CUSTOM_CSS,
    title="AI Audio Stem Separator",
) as demo:

    # ------------------------------------------------------------------
    # Header
    # ------------------------------------------------------------------
    gr.HTML(
        """
        <div class="main-header">
            <h1>🎵 AI Audio Stem Separator</h1>
            <p>Upload any audio file and separate it into individual stems
               (vocals, drums, bass, guitar, piano, other) using HTDemucs.</p>
        </div>
        """
    )

    # ------------------------------------------------------------------
    # Upload section
    # ------------------------------------------------------------------
    with gr.Row():
        with gr.Column(scale=2):
            audio_input = gr.Audio(
                label="Upload Audio File",
                type="filepath",
                sources=["upload", "microphone"],
                interactive=True,
            )

        with gr.Column(scale=1):
            submit_btn = gr.Button(
                "🎧 Separate Stems",
                variant="primary",
                size="lg",
            )

    # ------------------------------------------------------------------
    # Status display
    # ------------------------------------------------------------------
    upload_status = gr.Markdown(
        value="Ready. Upload an audio file to begin.",
        elem_classes=["status-text"],
    )

    job_id_display = gr.Markdown(visible=False)

    progress_bar = gr.Progress(
        visible=False,
        show_label=False,
    )

    # ------------------------------------------------------------------
    # Stem results section
    # ------------------------------------------------------------------
    with gr.Column(visible=False, elem_classes=["stem-section"]) as stems_section:
        gr.Markdown("### 📂 Separated Stems")

        with gr.Row():
            with gr.Column(scale=2):
                stem_selector = gr.Dropdown(
                    label="Select a stem to preview",
                    choices=[],
                    interactive=True,
                    value=None,
                )

            with gr.Column(scale=1):
                download_all_btn = gr.Button(
                    "📥 Download All (tar.gz)",
                    variant="secondary",
                )

        stem_player = gr.Audio(
            label="Stem Preview",
            type="filepath",
            interactive=False,
        )

    # ------------------------------------------------------------------
    # A/B Comparison section
    # ------------------------------------------------------------------
    with gr.Column(visible=False) as ab_section:
        gr.Markdown("### 🔄 A/B Comparison")

        gr.Markdown(
            "Compare the **original** audio with the **full mix** "
            "(all stems re-summed together). Toggle between them to "
            "hear the difference."
        )

        with gr.Row():
            with gr.Column():
                gr.Markdown("**Original**")
                original_player = gr.Audio(
                    label=None,
                    type="filepath",
                    interactive=False,
                )

            with gr.Column():
                gr.Markdown("**Full Mix (Re-summed)**")
                # The full mix URL comes from the API as a virtual stem
                fullmix_player = gr.Audio(
                    label=None,
                    type="filepath",
                    interactive=False,
                )

    # ------------------------------------------------------------------
    # Footer
    # ------------------------------------------------------------------
    gr.HTML(
        """
        <div class="footer">
            <p>Powered by HTDemucs · RunPod Serverless · Phase 1 MVP</p>
        </div>
        """
    )

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    # State variables
    job_id_state = gr.State("")
    original_file_state = gr.State(None)
    result_data_state = gr.State({})

    def submit_audio(file):
        """
        Handle the submit button click.
        Uses the generator function process_audio() for progressive updates.
        """
        for update in process_audio(file):
            yield update

    # Wire up the submit button
    submit_event = submit_btn.click(
        fn=submit_audio,
        inputs=[audio_input],
        outputs=[
            original_player,
            original_file_state,
            upload_status,
            job_id_display,
            progress_bar,
            stems_section,
            ab_section,
            stem_selector,
            stem_player,
            None,  # download button placeholder
        ],
    )

    # When stem is selected, update the player
    stem_selector.change(
        fn=on_stem_select,
        inputs=[stem_selector, job_id_state],
        outputs=[stem_player, None],
    )

    # Show original audio for A/B comparison
    original_file_state.change(
        fn=load_original_audio,
        inputs=[original_file_state],
        outputs=[original_player],
    )

    # Handle the download all button
    def download_all(job_id):
        if not job_id:
            return None
        archive_url = f"{API_BASE_URL}/api/remaster/storage/stems/{job_id}/stems.tar.gz"
        return archive_url

    download_all_btn.click(
        fn=download_all,
        inputs=[job_id_state],
        outputs=[None],
    )

# =============================================================================
# Entry point
# =============================================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Launch the Gradio UI for the AI Stem Separator."
    )
    parser.add_argument(
        "--port",
        type=int,
        default=7860,
        help="Port to run the Gradio app on (default: 7860).",
    )
    parser.add_argument(
        "--share",
        action="store_true",
        help="Create a public share link (for testing from mobile).",
    )
    parser.add_argument(
        "--server",
        type=str,
        default=None,
        help="API server URL (default: http://localhost:3095).",
    )

    args = parser.parse_args()

    if args.server:
        os.environ["REMASTER_API_URL"] = args.server

    logger.info(
        f"Starting Gradio UI on port {args.port} "
        f"(API: {os.environ.get('REMASTER_API_URL', API_BASE_URL)})"
    )

    demo.launch(
        server_name="0.0.0.0",
        server_port=args.port,
        share=args.share,
        show_error=True,
    )

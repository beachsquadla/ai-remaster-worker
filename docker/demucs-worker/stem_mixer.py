# =============================================================================
# Stem Mixer Utility
# =============================================================================
# This module provides the mix_stems() function to re-combine separated audio
# stems with per-stem gain control. This is useful for:
#   - Creating an A/B comparison mix (original vs. re-summed stems)
#   - Building custom mixes (e.g., "vocals only" or "drums + bass")
#   - Adjusting stem levels before exporting
#
# All audio is standardized at 44.1kHz, 16-bit, mono/stereo as appropriate.
# =============================================================================

import os
import re
import numpy as np
import soundfile as sf
import logging

logger = logging.getLogger("stem_mixer")

# Default stem weights (all at unity gain, i.e., the full mix)
DEFAULT_STEM_WEIGHTS = {
    "vocals": 1.0,
    "drums": 1.0,
    "bass": 1.0,
    "guitar": 1.0,
    "piano": 1.0,
    "other": 1.0,
}


def _natural_sort_key(filename):
    """
    Generate a sort key that handles both text and numbers in filenames.
    This way 'bass.wav' sorts naturally regardless of prefix.
    """
    return [
        int(text) if text.isdigit() else text.lower()
        for text in re.split(r"(\d+)", filename)
    ]


def _validate_stems(stem_dir, expected_stems=None):
    """
    Check that the stem directory contains the expected WAV files.
    
    Args:
        stem_dir: Path to the directory containing stem WAV files.
        expected_stems: List of stem names expected (e.g., ['vocals', 'drums']).
                         If None, all the default stems are expected.
    
    Returns:
        List of valid stem file paths found in the directory.
    """
    if expected_stems is None:
        expected_stems = list(DEFAULT_STEM_WEIGHTS.keys())

    if not os.path.isdir(stem_dir):
        raise FileNotFoundError(f"Stem directory not found: {stem_dir}")

    # Look for WAV files in the stem directory
    found_stems = {}
    for fname in os.listdir(stem_dir):
        if fname.lower().endswith(".wav"):
            # Extract stem name by removing extension and any common prefixes
            name_no_ext = os.path.splitext(fname)[0].lower()
            for stem in expected_stems:
                if stem in name_no_ext:
                    found_stems[stem] = os.path.join(stem_dir, fname)
                    break

    missing = [s for s in expected_stems if s not in found_stems]
    if missing:
        logger.warning(f"Missing stems: {missing}. Continuing with available stems.")

    return found_stems


def mix_stems(stem_dir, stem_weights=None):
    """
    Mix selected stems back together with per-stem gain control.
    
    Args:
        stem_dir: Directory containing the separated WAV stem files.
        stem_weights: Dictionary mapping stem names to gain multipliers.
                      E.g., {"vocals": 1.5, "drums": 0.8, "bass": 1.0}.
                      Defaults to all-stems at unity gain (full mix).
    
    Returns:
        Tuple of (mixed_audio: np.ndarray, sample_rate: int).
        mixed_audio is a 2D array of shape (samples, channels).
    
    Raises:
        FileNotFoundError: If stem_dir doesn't exist or no valid stems found.
        ValueError: If the stem files have mismatched sample rates or lengths.
    """
    if stem_weights is None:
        stem_weights = DEFAULT_STEM_WEIGHTS

    # Find which stem files actually exist
    found_stems = _validate_stems(stem_dir, list(stem_weights.keys()))

    if not found_stems:
        raise FileNotFoundError(
            f"No valid stem WAV files found in {stem_dir}. "
            f"Demucs output must contain .wav files."
        )

    # Load the first stem to get reference dimensions
    reference_audio = None
    sample_rate = None
    mixed_audio = None

    for stem_name, stem_path in found_stems.items():
        gain = stem_weights.get(stem_name, 1.0)

        # Load the audio file
        audio, sr = sf.read(stem_path, always_2d=True)
        # audio shape: (num_samples, num_channels)

        if sample_rate is None:
            sample_rate = sr
        elif sr != sample_rate:
            raise ValueError(
                f"Sample rate mismatch for stem '{stem_name}': "
                f"expected {sample_rate}, got {sr}. All stems must have "
                f"the same sample rate."
            )

        if mixed_audio is None:
            mixed_audio = audio * gain
        else:
            # Handle length mismatches by truncating to the shortest length
            min_len = min(mixed_audio.shape[0], audio.shape[0])

            if audio.shape[0] != mixed_audio.shape[0]:
                logger.warning(
                    f"Stem '{stem_name}' has {audio.shape[0]} samples, "
                    f"reference has {mixed_audio.shape[0]} samples. "
                    f"Truncating to {min_len} samples."
                )

            mixed_audio = mixed_audio[:min_len, :] + (audio[:min_len, :] * gain)

    # Clip to [-1.0, 1.0] to prevent digital clipping
    mixed_audio = np.clip(mixed_audio, -1.0, 1.0)

    logger.info(
        f"Mixed {len(found_stems)} stems: "
        f"{', '.join(f'{k}:{stem_weights.get(k, 1.0):.1f}' for k in found_stems)}"
    )

    return mixed_audio, sample_rate


def save_mix(mixed_audio, sample_rate, output_path):
    """
    Save a mixed audio array to a WAV file.
    
    Args:
        mixed_audio: numpy array of shape (samples, channels).
        sample_rate: Sample rate of the audio.
        output_path: Path to save the WAV file.
    """
    sf.write(output_path, mixed_audio, sample_rate, subtype="PCM_16")
    logger.info(f"Saved mix to {output_path}")


# =============================================================================
# CLI entry point (for testing / standalone use)
# =============================================================================
if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Mix Demucs stem files with per-stem gain control."
    )
    parser.add_argument(
        "stem_dir",
        help="Directory containing stem WAV files from Demucs.",
    )
    parser.add_argument(
        "--output", "-o",
        default="mixed_output.wav",
        help="Output WAV file path (default: mixed_output.wav).",
    )
    parser.add_argument(
        "--weights", "-w",
        nargs="+",
        metavar="STEM=GAIN",
        help="Per-stem gain weights, e.g., vocals=1.5 drums=0.8",
    )

    args = parser.parse_args()

    # Parse custom weights if provided
    weights = None
    if args.weights:
        weights = {}
        for item in args.weights:
            try:
                stem, gain = item.split("=")
                weights[stem.strip()] = float(gain)
            except ValueError:
                logger.error(f"Invalid weight format: '{item}'. Use STEM=GAIN (e.g., vocals=1.5).")
                exit(1)

    try:
        mixed_audio, sr = mix_stems(args.stem_dir, stem_weights=weights)
        save_mix(mixed_audio, sr, args.output)
        logger.info(f"Done! Mixed audio saved to {args.output}")
    except Exception as e:
        logger.error(f"Failed to mix stems: {e}")
        exit(1)

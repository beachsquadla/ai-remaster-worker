// =============================================================================
// Remaster Routes — API endpoints for audio stem separation
// =============================================================================
//
// This module defines all the HTTP endpoints for the stem separation feature:
//   POST   /api/remaster/upload    — Upload audio, create job, send to RunPod
//   GET    /api/remaster/status/:id — Check job status
//   GET    /api/remaster/result/:id — Get job results (stem download URLs)
//   POST   /api/remaster/callback/:id — Receive results from RunPod webhook
//   GET    /api/remaster/storage/:filename — Serve stored stem/audio files
//
// =============================================================================

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const jobManager = require("../job-manager");

const router = express.Router();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const STORAGE_DIR = path.join(__dirname, "..", "storage");
const UPLOADS_DIR = path.join(STORAGE_DIR, "uploads");
const STEMS_DIR = path.join(STORAGE_DIR, "stems");
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB maximum upload

const TEMP_DIR = path.join(STORAGE_DIR, "temp");

// Ensure storage directories exist
[STORAGE_DIR, UPLOADS_DIR, STEMS_DIR, TEMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Multer configuration — handles file uploads
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // Generate a safe filename with timestamp to avoid collisions
    const ext = path.extname(file.originalname) || ".wav";
    const safeName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  // Accept common audio file types
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [
      ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".aiff",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowedExtensions.join(", ")}`));
    }
  },
});

// ---------------------------------------------------------------------------
// Helper: Get the public/base URL for constructing download links
// ---------------------------------------------------------------------------
function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

// ---------------------------------------------------------------------------
// POST /api/remaster
// ---------------------------------------------------------------------------
// Accepts a JSON body with { url, job_id } and submits directly to RunPod.
// This is the test/debug endpoint for the async workflow.
//
// Request: JSON with "url" (public/downloadable URL of audio) and optional "job_id"
// Response: { job_id, status, stems?, stemUrls?, error? }
// ---------------------------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const { url, job_id } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Missing required field: 'url'" });
    }

    const jobId = job_id || crypto.randomBytes(4).toString("hex");

    // Create job in DB if it doesn't exist
    let job = jobManager.getJob(jobId);
    if (!job) {
      job = jobManager.createJob(jobId || "direct-url", "direct-url");
    }
    jobManager.updateJobStatus(jobId, "processing");

    console.log(`[Remaster] POST /api/remaster — submitting job ${jobId} with URL: ${url}`);

    // Send to RunPod and wait for the result
    try {
      const result = await jobManager.sendToRunPod(jobId, url);
      return res.json({
        job_id: jobId,
        ...result,
      });
    } catch (err) {
      console.error(`[Remaster] RunPod error for job ${jobId}:`, err.message);
      jobManager.updateJobStatus(jobId, "error", { error: err.message });
      return res.status(500).json({
        job_id: jobId,
        status: "error",
        error: err.message,
      });
    }
  } catch (err) {
    console.error("[Remaster] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/remaster/upload
// ---------------------------------------------------------------------------
// Accepts an audio file upload, creates a job, and sends it to RunPod
// for stem separation. Returns the job ID so the client can poll for status.
//
// Request: multipart/form-data with field "file"
// Response: { job_id, status, message }
// ---------------------------------------------------------------------------
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded. Use field name 'file'." });
    }

    const originalFilename = req.file.originalname;
    const savedPath = req.file.path;

    console.log(`[Upload] Received file: ${originalFilename} (${req.file.size} bytes)`);

    // Create a job in the database
    const job = jobManager.createJob(originalFilename, savedPath);

    // Build the audio URL that RunPod can download from
    const baseUrl = getBaseUrl(req);
    const audioUrl = `${baseUrl}/api/remaster/storage/uploads/${req.file.filename}`;

    // Update status to 'processing' before sending to RunPod
    jobManager.updateJobStatus(job.id, "processing");

    // Send the job to RunPod Serverless via runsync (returns stems + S3 URLs)
    jobManager.sendToRunPod(job.id, audioUrl).catch((err) => {
      console.error(`[Upload] RunPod send failed for job ${job.id}:`, err.message);
      jobManager.updateJobStatus(job.id, "error", { error: `RunPod send failed: ${err.message}` });
    });

    // Respond immediately with the job ID
    return res.status(201).json({
      job_id: job.id,
      status: "processing",
      message: "Audio uploaded and sent for stem separation.",
    });
  } catch (err) {
    console.error("[Upload] Error:", err.message);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `File too large. Maximum is ${MAX_FILE_SIZE / 1024 / 1024} MB.` });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/remaster/status/:jobId
// ---------------------------------------------------------------------------
// Returns the current status of a stem separation job.
//
// Response: { job_id, status, original_filename, stems, created_at, completed_at, error }
// Status values: queued, processing, done, error
// ---------------------------------------------------------------------------
router.get("/status/:jobId", (req, res) => {
  try {
    const job = jobManager.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    return res.json({
      job_id: job.id,
      status: job.status,
      original_filename: job.original_filename,
      stems: JSON.parse(job.stems || "[]"),
      created_at: job.created_at,
      completed_at: job.completed_at,
      error: job.error || null,
    });
  } catch (err) {
    console.error("[Status] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/remaster/result/:jobId
// ---------------------------------------------------------------------------
// Returns the result of a completed job, including download URLs for each stem.
//
// Response: { job_id, status, stems: [{ name, url, size }] }
// ---------------------------------------------------------------------------
router.get("/result/:jobId", (req, res) => {
  try {
    const job = jobManager.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    if (job.status !== "done") {
      return res.json({
        job_id: job.id,
        status: job.status,
        message: "Job is not yet completed. Use /status to poll.",
      });
    }

    // Check if we have S3 URLs (from runsync) — use those directly
    let stemUrls = [];
    try {
      stemUrls = JSON.parse(job.stem_urls || "[]");
    } catch (e) {
      stemUrls = [];
    }

    const stemNames = JSON.parse(job.stems || "[]");

    if (stemUrls.length > 0) {
      // Return S3 URLs directly from the RunPod result
      return res.json({
        job_id: job.id,
        status: job.status,
        stems: stemUrls,
        archive: job.archive_url ? { name: "stems.tar.gz", url: job.archive_url } : null,
      });
    }

    // Fallback: build local file URLs (for backward compatibility)
    const baseUrl = getBaseUrl(req);
    const stems = stemNames.map((stemName) => {
      const stemPath = path.join(STEMS_DIR, job.id, stemName);
      const stats = fs.existsSync(stemPath) ? fs.statSync(stemPath) : null;
      return {
        name: stemName,
        url: `${baseUrl}/api/remaster/storage/stems/${job.id}/${stemName}`,
        size: stats ? stats.size : 0,
      };
    });

    // Also include the archive if it exists
    const archivePath = job.archive_path;
    const archive = archivePath && fs.existsSync(archivePath) ? {
      name: "stems.tar.gz",
      url: `${baseUrl}/api/remaster/storage/stems/${job.id}/stems.tar.gz`,
      size: fs.statSync(archivePath).size,
    } : null;

    return res.json({
      job_id: job.id,
      status: job.status,
      stems,
      archive,
    });
  } catch (err) {
    console.error("[Result] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Configure multer for the callback endpoint
// ---------------------------------------------------------------------------
// The callback route needs to accept both form fields AND file uploads
// (the tar.gz archive from RunPod). We create a local multer instance
// that stores files in a temp location for processing.
const callbackUpload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max for archives
});

// ---------------------------------------------------------------------------
// POST /api/remaster/callback/:jobId
// ---------------------------------------------------------------------------
// Webhook endpoint that receives stem separation results from RunPod.
// RunPod POSTs a tar.gz archive and a JSON list of stem names.
//
// Request: multipart/form-data with fields:
//   - archive (file): tar.gz containing stem WAV files
//   - stems (string): JSON-encoded array of stem filenames
//   - job_id (string): The original job ID for verification
//
// Response: { status: "ok" }
// ---------------------------------------------------------------------------
router.post("/callback/:jobId", callbackUpload.fields([
  { name: "archive", maxCount: 1 },
  { name: "stems", maxCount: 1 },
  { name: "job_id", maxCount: 1 },
]), async (req, res) => {
  const jobId = req.params.jobId;

  try {
    const job = jobManager.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    console.log(`[Callback] Received callback for job ${jobId}`);

    // Check if this is a multipart upload with the archive file
    // RunPod sends the archive as a multipart file upload.
    // With multer .fields(), req.files is { archive: [file], stems: [file], ... }
    if (req.files && req.files.archive && req.files.archive.length > 0) {
      const archiveFile = req.files.archive[0];
      const stemDir = path.join(STEMS_DIR, jobId);
      const archivePath = path.join(stemDir, "stems.tar.gz");

      // Create stem directory
      if (!fs.existsSync(stemDir)) {
        fs.mkdirSync(stemDir, { recursive: true });
      }

      // Move the uploaded archive to the stem directory
      fs.renameSync(archiveFile.path, archivePath);

      // Extract the tar.gz to get individual stem files
      const { execSync } = require("child_process");
      execSync(`tar -xzf "${archivePath}" -C "${stemDir}"`, {
        stdio: "pipe",
      });

      // Parse the list of stem names (sent as a JSON string field)
      let stemNames = [];
      if (req.body && req.body.stems) {
        try {
          stemNames = JSON.parse(req.body.stems);
        } catch (e) {
          // If the stems field is malformed, list the extracted files
          stemNames = fs.readdirSync(stemDir).filter((f) => f.endsWith(".wav"));
        }
      } else {
        stemNames = fs.readdirSync(stemDir).filter((f) => f.endsWith(".wav"));
      }

      // Store the result
      jobManager.storeJobResult(jobId, stemNames, stemDir, archivePath);

      console.log(`[Callback] Job ${jobId} completed with stems: ${stemNames.join(", ")}`);
      return res.json({ status: "ok", message: "Stems received and stored." });
    }

    // Handle JSON payload (alternative — RunPod can also POST JSON if configured)
    if (req.body && req.body.status === "completed") {
      // RunPod returned a completion status with stem metadata but no archive.
      // This happens when the handler returned { status: "completed", stems: [...] }
      const stemNames = req.body.stems || [];
      console.log(`[Callback] Job ${jobId} completed (JSON callback): ${stemNames.join(", ")}`);

      // If stems were returned but no archive was uploaded, mark done anyway
      jobManager.updateJobStatus(jobId, "done", { stems: stemNames });
      return res.json({ status: "ok" });
    }

    // Handle error status
    if (req.body && req.body.status === "error") {
      const errorMsg = req.body.error || "Unknown RunPod error";
      console.error(`[Callback] Job ${jobId} failed: ${errorMsg}`);
      jobManager.updateJobStatus(jobId, "error", { error: errorMsg });
      return res.json({ status: "ok", message: "Error recorded." });
    }

    // Unknown callback format
    console.warn(`[Callback] Unknown callback format for job ${jobId}:`, req.body);
    return res.status(400).json({ error: "Unknown callback format." });
  } catch (err) {
    console.error(`[Callback] Error processing callback for job ${jobId}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/remaster/storage/:type/:filename
// ---------------------------------------------------------------------------
// Serves stored files (uploads and stems) as static downloads.
// The :type parameter is either "uploads" or "stems".
//
// The :stemDir parameter is optional; when present it directs to
// /storage/stems/{jobId}/{filename}
// ---------------------------------------------------------------------------
router.get("/storage/:type/:filename", (req, res) => {
  const { type, filename } = req.params;

  // Validate the type to prevent directory traversal
  if (!["uploads", "stems"].includes(type)) {
    return res.status(400).json({ error: "Invalid storage type." });
  }

  const filePath = path.join(STORAGE_DIR, type, filename);

  // Security: ensure the resolved path is within the storage directory
  const resolvedPath = path.resolve(filePath);
  const storageResolved = path.resolve(STORAGE_DIR);
  if (!resolvedPath.startsWith(storageResolved)) {
    return res.status(403).json({ error: "Access denied." });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: "File not found." });
  }

  res.sendFile(resolvedPath);
});

// ---------------------------------------------------------------------------
// GET /api/remaster/storage/:type/:subdir/:filename
// ---------------------------------------------------------------------------
// Serves files nested one level deep (e.g., stems/jobId/filename.wav)
// ---------------------------------------------------------------------------
router.get("/storage/:type/:subdir/:filename", (req, res) => {
  const { type, subdir, filename } = req.params;

  // Validate the type
  if (!["uploads", "stems"].includes(type)) {
    return res.status(400).json({ error: "Invalid storage type." });
  }

  const filePath = path.join(STORAGE_DIR, type, subdir, filename);

  // Security: ensure the resolved path is within the storage directory
  const resolvedPath = path.resolve(filePath);
  const storageResolved = path.resolve(STORAGE_DIR);
  if (!resolvedPath.startsWith(storageResolved)) {
    return res.status(403).json({ error: "Access denied." });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: "File not found." });
  }

  res.sendFile(resolvedPath);
});

// ---------------------------------------------------------------------------
// GET /api/remaster/jobs
// ---------------------------------------------------------------------------
// Lists all jobs (for debugging / admin purposes).
// ---------------------------------------------------------------------------
router.get("/jobs", (req, res) => {
  try {
    const jobs = jobManager.getAllJobs();
    return res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        original_filename: j.original_filename,
        stems: JSON.parse(j.stems || "[]"),
        created_at: j.created_at,
        completed_at: j.completed_at,
        error: j.error || null,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/remaster/master
// ---------------------------------------------------------------------------
// Accepts an audio file, optional reference track, and a mastering preset.
// Runs the full DSP mastering pipeline on the VPS CPU.
//
// Request: multipart/form-data with fields:
//   - file (required): Audio file to master
//   - preset (optional): 'clean', 'warm', 'punchy', 'cinematic' (default: 'clean')
//   - reference (optional): Reference track for EQ matching
//
// Response: { job_id, status, message }
// ---------------------------------------------------------------------------
const PRESET_NAMES = ["clean", "warm", "punchy", "cinematic", "club_remix", "rnb_enhance", "hiphop_remix", "cinematic_atmos"];
const CREATIVE_PRESETS = new Set(["club_remix", "rnb_enhance", "hiphop_remix", "cinematic_atmos"]);

// Multer config for mastering — accepts target file + optional reference
const masterUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".aiff"];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported: ${path.extname(file.originalname)}`));
    }
  },
});

router.post("/master", masterUpload.fields([
  { name: "file", maxCount: 1 },
  { name: "reference", maxCount: 1 },
]), async (req, res) => {
  try {
    const targetFile = req.files?.file?.[0];
    if (!targetFile) {
      return res.status(400).json({ error: "No audio file uploaded. Use field name 'file'." });
    }

    const preset = PRESET_NAMES.includes(req.body?.preset) ? req.body.preset : "clean";
    const refFile = req.files?.reference?.[0] || null;
    const isCreative = CREATIVE_PRESETS.has(preset);

    const job = jobManager.createJob(
      `master_${targetFile.originalname}`,
      targetFile.path
    );
    jobManager.updateJobStatus(job.id, "processing", { preset, type: isCreative ? "creative_remix" : "master" });

    console.log(`[Master] Job ${job.id}: preset=${preset} (${isCreative ? "creative" : "standard"}), ref=${refFile?.originalname || 'none'}`);

    // Run mastering async on VPS CPU — use creative pipeline for creative presets
    const { execFile } = require("child_process");
    const studioDir = path.join(__dirname, "..", "..", "..", "..", "hermes-workspace", "studio-api", "mastering");
    const scriptPath = isCreative
      ? path.join(studioDir, "run_remix.py")
      : path.join(studioDir, "run_master.py");
    const outputPath = path.join(STORAGE_DIR, "stems", job.id, "mastered.wav");

    // Ensure output directory
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const args = [
      scriptPath,
      "--input", targetFile.path,
      "--output", outputPath,
      "--preset", preset,
    ];
    if (refFile) {
      args.push("--reference", refFile.path);
    }

    execFile("python3", args, (err, stdout, stderr) => {
      if (err) {
        console.error(`[Master] Job ${job.id} failed:`, stderr || err.message);
        jobManager.updateJobStatus(job.id, "error", {
          error: stderr || err.message,
          type: "master",
        });
      } else {
        try {
          const report = JSON.parse(stdout);
          console.log(`[Master] Job ${job.id} done:`, JSON.stringify(report).slice(0, 200));
          jobManager.updateJobStatus(job.id, "done", {
            output_path: outputPath,
            report,
            type: "master",
          });
        } catch (parseErr) {
          console.log(`[Master] Job ${job.id} done (raw output)`);
          jobManager.updateJobStatus(job.id, "done", {
            output_path: outputPath,
            type: "master",
          });
        }
      }
    });

    return res.status(201).json({
      job_id: job.id,
      status: "processing",
      preset,
      message: `Mastering started with "${preset}" preset.`,
    });
  } catch (err) {
    console.error("[Master] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/remaster/presets
// ---------------------------------------------------------------------------
// Returns the available mastering presets and their descriptions.
// ---------------------------------------------------------------------------
router.get("/presets", (req, res) => {
  return res.json({
    presets: {
      clean: { name: "Clean Studio", description: "Transparent, dynamic. Streaming-ready.", lufs: -14 },
      warm: { name: "Warm Analog", description: "Rich vintage tape warmth. For R&B, soul, acoustic.", lufs: -12 },
      punchy: { name: "Punchy & Loud", description: "Aggressive, loud master. For hip-hop, trap, EDM.", lufs: -9 },
      cinematic: { name: "Cinematic Wide", description: "Epic soundstage. For orchestral, ambient, trailers.", lufs: -14 },
      club_remix: { name: "Club Remix ✦", description: "Festival-ready with harmonies, synth layers & builds.", lufs: -9, creative: true },
      rnb_enhance: { name: "R&B Enhancement ✦", description: "Rich harmonies, warm pads & silky vocal layers.", lufs: -12, creative: true },
      hiphop_remix: { name: "Hip-Hop Remix ✦", description: "Heavy 808s, vocal layers & aggressive presence.", lufs: -9, creative: true },
      cinematic_atmos: { name: "Cinematic Atmos ✦", description: "Epic soundscape with evolving textures & depth.", lufs: -14, creative: true },
    },
  });
});

module.exports = router;

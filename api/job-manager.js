// =============================================================================
// Job Manager — SQLite-based job tracking for stem separation (v3 - runsync)
// =============================================================================
//
// This module manages the lifecycle of stem separation jobs:
//   1. Creating a new job when a user uploads audio
//   2. Tracking job status (queued → processing → done/error)
//   3. Sending jobs to RunPod Serverless via runsync
//   4. Receiving and storing processed results (stem URLs from S3)
//   5. Serving job status and results to the web UI
//
// RunPod communication strategy (runsync):
//   - Call /runsync with a long timeout (180s)
//   - If COMPLETED with stems/URLs → store result, mark done
//   - If IN_PROGRESS (cold start), sleep 15s and retry runsync
//   - Repeat until COMPLETED or max wait time (300s)
//
// Jobs are stored in an SQLite database at api/storage/jobs.db.
//
// =============================================================================

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const STORAGE_DIR = path.join(__dirname, "storage");

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const DB_PATH = path.join(STORAGE_DIR, "jobs.db");

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------
let db;

function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      original_filename TEXT,
      saved_path TEXT,
      stems TEXT DEFAULT '[]',
      stem_urls TEXT,
      stem_dir TEXT,
      archive_path TEXT,
      archive_url TEXT,
      runpod_job_id TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log(`[JobManager] Database initialized at ${DB_PATH}`);
}

// ---------------------------------------------------------------------------
// Job CRUD operations
// ---------------------------------------------------------------------------

function createJob(originalFilename, savedPath) {
  const jobId = crypto.randomBytes(4).toString("hex");

  db.prepare(
    `INSERT INTO jobs (id, status, original_filename, saved_path)
     VALUES (?, 'queued', ?, ?)`
  ).run(jobId, originalFilename, savedPath);

  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  console.log(`[JobManager] Created job ${jobId} for "${originalFilename}"`);
  return job;
}

function getJob(jobId) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
}

function getAllJobs() {
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all();
}

function updateJobStatus(jobId, status, extra = {}) {
  const updates = ["status = ?", "updated_at = datetime('now')"];
  const params = [status];

  if (extra.error !== undefined) {
    updates.push("error = ?");
    params.push(extra.error);
  }

  if (extra.stems) {
    updates.push("stems = ?");
    params.push(JSON.stringify(extra.stems));
  }

  if (extra.stemUrls) {
    updates.push("stem_urls = ?");
    params.push(JSON.stringify(extra.stemUrls));
  }

  if (extra.archiveUrl) {
    updates.push("archive_url = ?");
    params.push(extra.archiveUrl);
  }

  if (extra.stemDir) {
    updates.push("stem_dir = ?");
    params.push(extra.stemDir);
  }

  if (extra.runpodJobId) {
    updates.push("runpod_job_id = ?");
    params.push(extra.runpodJobId);
  }

  if (status === "done" || status === "error") {
    updates.push("completed_at = datetime('now')");
  }

  params.push(jobId);

  db.prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`).run(
    ...params
  );

  console.log(`[JobManager] Job ${jobId} status → ${status}`);
}

function storeJobResult(jobId, stems, stemDir, archivePath) {
  db.prepare(
    `UPDATE jobs
     SET status = 'done',
         stems = ?,
         stem_dir = ?,
         archive_path = ?,
         completed_at = datetime('now')
     WHERE id = ?`
  ).run(JSON.stringify(stems), stemDir, archivePath, jobId);

  console.log(
    `[JobManager] Stored result for job ${jobId}: ${stems.length} stems`
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTPS request and return the parsed JSON response.
 * Properly handles the req timeout by destroying on timeout.
 */
function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === "https:";
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const mod = isHttps ? https : http;
    const req = mod.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`
              )
            );
          }
        } catch (e) {
          reject(
            new Error(`Failed to parse response: ${data.slice(0, 200)}`)
          );
        }
      });
    });

    req.on("error", (e) =>
      reject(new Error(`Request failed: ${e.message}`))
    );

    // Timeout handling
    const timeoutMs = options.timeout || 180000; // default 180s
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s`));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// RunPod API — runsync with retry on IN_PROGRESS
// ---------------------------------------------------------------------------

/**
 * Send a job to RunPod Serverless via runsync and wait for the result.
 *
 * Strategy:
 *   1. Call /runsync with a long timeout
 *   2. If COMPLETED with stems → store result (stem URLs from S3), mark done
 *   3. If IN_PROGRESS (cold start), sleep 15s and retry runsync
 *   4. Repeat until COMPLETED or max wait time (300s) is reached
 *
 * @param {string} jobId - The VPS job ID.
 * @param {string} audioUrl - Public URL where RunPod can download the audio.
 * @returns {Promise<object>} { status, stems?, stemUrls?, error? }
 */
async function sendToRunPod(jobId, audioUrl) {
  const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
  const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;

  if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
    throw new Error("RunPod credentials not configured.");
  }

  const payload = {
    input: {
      audio_url: audioUrl,
      job_id: jobId,
    },
  };

  const postData = JSON.stringify(payload);
  const runsyncUrl = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/runsync`;
  const maxWaitMs = 300000; // 5 minutes max total wait
  const startTime = Date.now();
  let attempt = 1;

  while (Date.now() - startTime < maxWaitMs) {
    console.log(
      `[JobManager] runsync attempt ${attempt} for job ${jobId}`
    );

    try {
      const syncResult = await httpsRequest(
        runsyncUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RUNPOD_API_KEY}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
          timeout: 180000, // 180s — runsync internal timeout ~90s, but Node timeout covers network delays
        },
        postData
      );

      const runStatus = syncResult.status || "";
      const output = syncResult.output || {};
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      console.log(
        `[JobManager] runsync attempt ${attempt} result: status=${runStatus} (${elapsed}s elapsed)`
      );

      if (runStatus === "COMPLETED") {
        const outputStatus = output.status || "";
        const stemNames = output.stems || [];
        const stemUrls = output.stem_urls || [];
        const archiveUrl = output.archive_url || null;
        const stemsCount = output.stems_count || 0;

        console.log(
          `[JobManager] Job ${jobId} COMPLETED: ${stemsCount} stems, ${stemUrls.length} URLs`
        );

        if (outputStatus === "completed" && stemNames.length > 0) {
          // Store result in DB
          const updateExtra = {
            stems: stemNames,
            stemUrls: stemUrls.length > 0 ? stemUrls : undefined,
            archiveUrl: archiveUrl,
          };

          if (syncResult.id) {
            updateExtra.runpodJobId = syncResult.id;
          }

          updateJobStatus(jobId, "done", updateExtra);

          return {
            status: "completed",
            stems: stemNames,
            stemUrls: stemUrls,
            archiveUrl: archiveUrl,
            stemsCount: stemsCount,
          };
        }

        // COMPLETED but no stems in output
        console.log(
          `[JobManager] Job ${jobId} COMPLETED but no stems in output: ${JSON.stringify(output).slice(0, 300)}`
        );

        // Extract stem names from names array if they exist
        if (stemNames.length > 0) {
          updateJobStatus(jobId, "done", { stems: stemNames });
          return {
            status: "completed",
            stems: stemNames,
            stemUrls: [],
          };
        }

        // Still mark as done with empty stems
        updateJobStatus(jobId, "done", { stems: [] });
        return { status: "completed", stems: [], stemUrls: [] };
      }

      // IN_PROGRESS — worker is cold-booting, wait and retry runsync
      if (runStatus === "IN_PROGRESS") {
        console.log(
          `[JobManager] runsync attempt ${attempt} IN_PROGRESS — cold start, waiting 15s...`
        );
        attempt++;
        await sleep(15000);
        continue;
      }

      // FAILED — check output for details
      if (runStatus === "FAILED") {
        const errorMsg =
          output.error ||
          output.errorMessage ||
          "RunPod job failed (unknown reason)";
        console.error(
          `[JobManager] Job ${jobId} FAILED: ${errorMsg}`
        );
        updateJobStatus(jobId, "error", { error: errorMsg });
        return { status: "error", error: errorMsg };
      }

      // Unexpected status — retry
      console.log(
        `[JobManager] runsync attempt ${attempt} unexpected status: ${runStatus} — retrying`
      );
      attempt++;
      await sleep(15000);
      continue;
    } catch (syncErr) {
      // On timeout, check if we should retry
      console.log(
        `[JobManager] runsync attempt ${attempt} error: ${syncErr.message} — retrying in 15s`
      );
      attempt++;
      await sleep(15000);
      continue;
    }
  }

  // Exceeded max wait time
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const errorMsg = `RunPod job timed out after ${elapsed}s`;
  console.error(`[JobManager] ${errorMsg}`);
  updateJobStatus(jobId, "error", { error: errorMsg });
  return { status: "error", error: errorMsg };
}

// ---------------------------------------------------------------------------
// Initialize on module load
// ---------------------------------------------------------------------------
initDatabase();

// ---------------------------------------------------------------------------
// Export public API
// ---------------------------------------------------------------------------
module.exports = {
  createJob,
  getJob,
  getAllJobs,
  updateJobStatus,
  storeJobResult,
  sendToRunPod,
};

// =============================================================================
// Remaster API Server — Express.js on port 3095
// =============================================================================
//
// This server bridges the web UI (Gradio) and the RunPod Serverless worker.
// It handles:
//   1. Audio file uploads from the web UI
//   2. Job creation and tracking via SQLite
//   3. Dispatching jobs to RunPod Serverless
//   4. Receiving processed results via webhook callback
//   5. Serving stem files back to the UI for download and A/B comparison
//
// Runs on port 3095, separate from the Beachside Premium API (port 3090).
//
// =============================================================================

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3095;
const STORAGE_DIR = path.join(__dirname, "storage");

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Initialize Express
// ---------------------------------------------------------------------------
const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// CORS — allows the Gradio web UI and any other frontend to access the API.
// In production, you'd restrict this to specific origins.
app.use(
  cors({
    origin: "*", // Allow all origins for development; restrict in production
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse JSON request bodies (for non-multipart requests)
app.use(express.json({ limit: "50mb" }));

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Mount the remaster routes at /api/remaster
const remasterRoutes = require("./routes/remaster");
app.use("/api/remaster", remasterRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ai-remaster",
    version: "1.0.0",
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Error handling middleware
// ---------------------------------------------------------------------------

// Handle 404 for undefined routes
app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    message: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Server] Unhandled error:", err);

  // Multer errors
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "File too large",
      message: "Uploaded file exceeds the maximum allowed size.",
    });
  }

  if (err.name === "MulterError") {
    return res.status(400).json({
      error: "Upload error",
      message: err.message,
    });
  }

  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "production" ? "An unexpected error occurred." : err.message,
  });
});

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("============================================");
  console.log(`  AI Remaster API Server`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`  Storage: ${STORAGE_DIR}`);
  console.log(`  API Base: http://0.0.0.0:${PORT}/api/remaster`);
  console.log(`  Health:  http://0.0.0.0:${PORT}/health`);
  console.log("============================================");
});

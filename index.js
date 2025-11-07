// server-api/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const port = process.env.PORT || 3001;

// Trust reverse proxies (Render/Nginx) so req.ip, proto, etc. are correct
app.set("trust proxy", 1);

/* -----------------------------------------------------------------------------
 * CORS
 * --------------------------------------------------------------------------- */
const STATIC_ALLOWED = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",

  // GitHub Pages (your live front-end)
  "https://nolimitsmedia.github.io",

  // Custom domain (top-level)
  "https://checkin.mtgilead.org",
];

// Allow passing extra origins via env (comma-separated)
const envList = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Allow your Render public URL if provided
const renderPublic = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.PUBLIC_WEB_ORIGIN ||
  ""
).trim();
if (renderPublic) envList.push(renderPublic);

// Build allow set
const allowedOrigins = new Set([...STATIC_ALLOWED, ...envList]);

// Allow any *.mtgilead.org subdomain (e.g., app.mtgilead.org)
const allowMtGileadSub = /^https:\/\/([a-z0-9-]+\.)*mtgilead\.org$/i;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin / curl
      if (allowedOrigins.has(origin) || allowMtGileadSub.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

// Optional: fast-track OPTIONS preflight
app.options("*", cors());

/* -----------------------------------------------------------------------------
 * Body parsing
 * --------------------------------------------------------------------------- */
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

/* -----------------------------------------------------------------------------
 * Health checks (used by the frontend to auto-pick API base)
 * --------------------------------------------------------------------------- */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    name: "Check-in API",
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
  });
});

// Root info
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "Check-in API",
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
  });
});

/* -----------------------------------------------------------------------------
 * Routes
 * --------------------------------------------------------------------------- */
app.use("/api/users", require("./routes/users"));
app.use("/api/admins", require("./routes/admins"));
app.use("/api/events", require("./routes/events"));
app.use("/api/checkins", require("./routes/checkins"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/elders", require("./routes/elders"));
app.use("/api/familySearch", require("./routes/familySearch"));
app.use("/api/uploads", require("./routes/uploads"));
app.use("/api/families", require("./routes/families"));
app.use("/api/ministries", require("./routes/ministries"));
app.use("/api/import", require("./routes/import"));
app.use("/api/email", require("./routes/email"));

// ✅ Kiosk routes (frontend calls /api/kiosk/*)
app.use("/api/kiosk", require("./routes/kiosk"));

// Static files (avatars, etc.)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* -----------------------------------------------------------------------------
 * 404 and error handlers
 * --------------------------------------------------------------------------- */
app.use((req, res, _next) => {
  res.status(404).json({ message: "Not Found" });
});

app.use((err, _req, res, _next) => {
  console.error("Server error:", err?.stack || err?.message || err);
  const status =
    typeof err?.status === "number"
      ? err.status
      : err?.message?.includes("CORS")
      ? 403
      : 500;
  res.status(status).json({ message: err?.message || "Internal Server Error" });
});

/* -----------------------------------------------------------------------------
 * Start server
 * --------------------------------------------------------------------------- */
app.listen(port, () => {
  console.log(`✅ Server is running on http://localhost:${port}`);
  if (allowedOrigins.size) {
    console.log("✅ CORS allowed origins:");
    [...allowedOrigins].forEach((o) => console.log("   -", o));
    console.log("✅ Subdomain regex allowed:", allowMtGileadSub.toString());
  }
});

module.exports = app;

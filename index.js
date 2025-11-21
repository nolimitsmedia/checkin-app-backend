// server-api/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const port = process.env.PORT || 3001;

// Trust reverse proxies (Render/Nginx)
app.set("trust proxy", 1);

/* ---------------------------------------------------------------------------
 * CORS
 * ------------------------------------------------------------------------- */
const STATIC_ALLOWED = [
  // Local dev
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",

  // GitHub Pages
  "https://nolimitsmedia.github.io",

  // NEW: Check-in custom domain (correct version)
  "http://checkin.mtgileadfgim.org",
  "https://checkin.mtgileadfgim.org",
];

// Add env-provided origins (comma-separated)
const envList = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Add Render’s public URL if provided
const renderPublic = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.PUBLIC_WEB_ORIGIN ||
  ""
).trim();

if (renderPublic) envList.push(renderPublic);

// Build allow-list
const allowedOrigins = new Set([...STATIC_ALLOWED, ...envList]);

// Allow ANY *.mtgileadfgim.org subdomain
const allowDynamicSubdomain = /^https?:\/\/([a-z0-9-]+\.)*mtgileadfgim\.org$/i;

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser/cURL/no origin
      if (!origin) return cb(null, true);

      if (allowedOrigins.has(origin) || allowDynamicSubdomain.test(origin)) {
        return cb(null, true);
      }

      return cb(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Preflight
app.options(/.*/, cors());

/* ---------------------------------------------------------------------------
 * Body parsing
 * ------------------------------------------------------------------------- */
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

/* ---------------------------------------------------------------------------
 * Health checks
 * ------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------
 * Routes
 * ------------------------------------------------------------------------- */
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
app.use("/api/kiosk", require("./routes/kiosk"));

/* ---------------------------------------------------------------------------
 * Static uploads
 * ------------------------------------------------------------------------- */
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ---------------------------------------------------------------------------
 * 404 + Error handlers
 * ------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------
 * Start server
 * ------------------------------------------------------------------------- */
app.listen(port, () => {
  console.log(`✅ Server is running on http://localhost:${port}`);

  console.log("✅ CORS allowed origins:");
  [...allowedOrigins].forEach((o) => console.log("   -", o));

  console.log("✅ Subdomain regex allowed:", allowDynamicSubdomain.toString());
});

module.exports = app;

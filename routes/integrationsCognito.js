// server-api/routes/integrationsCognito.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/* ------------------------- Security ------------------------- */
function verifyWebhookSecret(req, res, next) {
  const expected = String(process.env.COGNITO_WEBHOOK_SECRET || "").trim();
  if (!expected) {
    return res.status(500).json({
      ok: false,
      message:
        "COGNITO_WEBHOOK_SECRET is not set (webhook endpoints are disabled).",
    });
  }

  const headerSecret = String(req.headers["x-nlm-webhook-secret"] || "").trim();
  const querySecret = String(req.query.secret || "").trim();

  // allow either header OR query secret
  const got = headerSecret || querySecret;

  if (!got || got !== expected) {
    console.warn("[Cognito] Invalid webhook secret", {
      got: got ? `${got.slice(0, 3)}***` : null,
      hasHeader: !!headerSecret,
      hasQuery: !!querySecret,
    });
    return res
      .status(401)
      .json({ ok: false, message: "Invalid webhook secret" });
  }

  next();
}

/* ------------------------- Helpers ------------------------- */
function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      const v = String(obj[k]).trim();
      if (v) return v;
    }
  }
  return null;
}

// Cognito can send nested objects; we want the actual entry fields.
// Your captured payload shape is: { entry: { ...fields... } }
function unwrapBody(body) {
  if (!body) return {};
  return body.entry || body.data || body.fields || body;
}

async function findUser({ email, phone }) {
  const emailNorm = email ? email.trim().toLowerCase() : null;
  const phoneDigits = digitsOnly(phone);

  if (emailNorm) {
    const r = await db.query(
      `SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [emailNorm]
    );
    if (r.rows[0]) return r.rows[0];
  }

  if (phoneDigits) {
    const r = await db.query(
      `
      SELECT * FROM users
      WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') = $1
      LIMIT 1
      `,
      [phoneDigits]
    );
    if (r.rows[0]) return r.rows[0];
  }

  return null;
}

async function createUser({ first_name, last_name, email, phone }) {
  const emailNorm = email ? email.trim().toLowerCase() : null;

  const r = await db.query(
    `
    INSERT INTO users (first_name, last_name, email, phone, role, active)
    VALUES ($1, $2, $3, $4, $5, true)
    RETURNING *
    `,
    [first_name, last_name, emailNorm, phone || null, "volunteer"]
  );
  return r.rows[0];
}

async function ensureMinistryByName(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Missing ministry");

  let r = await db.query(
    `SELECT id, name, COALESCE(is_active, true) AS is_active
     FROM ministries
     WHERE LOWER(name) = LOWER($1)
     LIMIT 1`,
    [n]
  );
  if (r.rows[0]) return r.rows[0];

  r = await db.query(
    `INSERT INTO ministries (name, is_active)
     VALUES ($1, true)
     RETURNING id, name, COALESCE(is_active, true) AS is_active`,
    [n]
  );
  return r.rows[0];
}

async function addUserToMinistry(user_id, ministry_id) {
  // Your user_ministries table shows user_id + ministry_id as PK,
  // so ON CONFLICT DO NOTHING should be safe.
  await db.query(
    `INSERT INTO user_ministries (user_id, ministry_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [user_id, ministry_id]
  );
}

async function removeUserFromMinistry(user_id, ministry_id) {
  await db.query(
    `DELETE FROM user_ministries WHERE user_id = $1 AND ministry_id = $2`,
    [user_id, ministry_id]
  );
}

/* ------------------------- Mapping ------------------------- */
function mapAddition(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  // Supports both JSON-names AND Cognito x-field IDs you captured:
  // x3 first, x5 last, x6 email, x8 ministry, x9 phone
  const first_name = pick(e, ["first_name", "Firstname", "FirstName", "x3"]);
  const last_name = pick(e, ["last_name", "LastName", "Lastname", "x5"]);
  const email = pick(e, ["email", "Email", "x6"]);
  const ministry = pick(e, ["ministry", "ApprovedMinistry", "Ministry", "x8"]);
  const phone = pick(e, ["phone", "Phone", "x9"]);

  return { first_name, last_name, email, phone, ministry };
}

function mapRemoval(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  // When you submit one Removal test, we can tighten these keys.
  const email = pick(e, ["email", "Email", "Email Address", "E-mail", "x6"]);
  const phone = pick(e, [
    "phone",
    "Phone",
    "Phone Number",
    "Mobile",
    "Cell",
    "x9",
  ]);

  const ministry = pick(e, [
    "ministry",
    "ministry_name",
    "RemovedMinistry",
    "Removed Ministry",
    "MinistryRemoved",
    "Ministry Removed",
    "MinistryToRemove",
    "Ministry to Remove",
    "x8", // if you reuse same dropdown field id
  ]);

  return { email, phone, ministry };
}

/* ------------------------- Routes ------------------------- */

// POST /api/integrations/cognito/volunteer-ministry/add
router.post(
  "/cognito/volunteer-ministry/add",
  verifyWebhookSecret,
  async (req, res) => {
    // ---- PING LOG: proves Cognito hit this endpoint ----
    console.log("[Cognito ADD] HIT", {
      at: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.ip,
      secret_present:
        !!req.query.secret || !!req.headers["x-nlm-webhook-secret"],
      db_host: process.env.PGHOST || null,
      db_name: process.env.PGDATABASE || null,
      body_top_keys: Object.keys(req.body || {}),
      entry_keys: Object.keys((req.body && req.body.entry) || {}),
    });

    try {
      const payload = mapAddition(req.body);

      // ---- PING LOG: shows parsed payload ----
      console.log("[Cognito ADD] payload", payload);

      if (!payload.ministry) {
        return res.status(400).json({ ok: false, message: "Missing ministry" });
      }
      if (!payload.email && !payload.phone) {
        return res.status(400).json({
          ok: false,
          message: "Missing identifier (email or phone)",
        });
      }

      // 1) find or create user
      let user = await findUser({ email: payload.email, phone: payload.phone });

      if (!user) {
        if (!payload.first_name || !payload.last_name) {
          return res.status(400).json({
            ok: false,
            message:
              "User not found; first_name and last_name are required to create a new user.",
          });
        }
        user = await createUser(payload);
      }

      // 2) ensure ministry exists
      const ministry = await ensureMinistryByName(payload.ministry);

      // 3) attach
      await addUserToMinistry(user.id, ministry.id);

      return res.json({
        ok: true,
        action: "added",
        user_id: user.id,
        ministry_id: ministry.id,
        ministry_name: ministry.name,
      });
    } catch (err) {
      console.error("[Cognito ADD] error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  }
);

// POST /api/integrations/cognito/volunteer-ministry/remove
router.post(
  "/cognito/volunteer-ministry/remove",
  verifyWebhookSecret,
  async (req, res) => {
    console.log("[Cognito REMOVE] HIT", {
      at: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.ip,
      db_host: process.env.PGHOST || null,
      db_name: process.env.PGDATABASE || null,
      body_top_keys: Object.keys(req.body || {}),
      entry_keys: Object.keys((req.body && req.body.entry) || {}),
    });

    try {
      const payload = mapRemoval(req.body);
      console.log("[Cognito REMOVE] payload", payload);

      if (!payload.ministry) {
        return res.status(400).json({ ok: false, message: "Missing ministry" });
      }
      if (!payload.email && !payload.phone) {
        return res.status(400).json({
          ok: false,
          message: "Missing identifier (email or phone)",
        });
      }

      const user = await findUser({
        email: payload.email,
        phone: payload.phone,
      });

      if (!user) {
        // treat as success (no-op)
        return res.json({
          ok: true,
          action: "noop",
          message: "User not found",
        });
      }

      const ministry = await ensureMinistryByName(payload.ministry);
      await removeUserFromMinistry(user.id, ministry.id);

      return res.json({
        ok: true,
        action: "removed",
        user_id: user.id,
        ministry_id: ministry.id,
        ministry_name: ministry.name,
      });
    } catch (err) {
      console.error("[Cognito REMOVE] error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  }
);

module.exports = router;

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
/**
 * Based on your captured Cognito payload:
 * - body.entry.Firstname
 * - body.entry.LastName
 * - body.entry.Email
 * - body.entry.Phone
 * - body.entry.ApprovedMinistry
 *
 * We still allow your preferred JSON names too (first_name, last_name, ministry)
 * so this stays compatible if you later enforce JSON names everywhere.
 */
function mapAddition(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  const first_name = pick(e, [
    "first_name",
    "firstName",
    "FirstName",
    "Firstname", // <- from your payload
    "First Name",
  ]);

  const last_name = pick(e, [
    "last_name",
    "lastName",
    "LastName", // <- from your payload
    "Last Name",
    "Lastname",
  ]);

  const email = pick(e, [
    "email",
    "Email", // <- from your payload
    "Email Address",
    "E-mail",
  ]);

  const phone = pick(e, [
    "phone",
    "Phone", // <- from your payload
    "Phone Number",
    "Mobile",
    "Cell",
  ]);

  const ministry = pick(e, [
    "ministry",
    "ministry_name",
    "ApprovedMinistry", // <- from your payload
    "Approved Ministry",
    "Ministry",
    "Ministry Approved",
  ]);

  return { first_name, last_name, email, phone, ministry };
}

function mapRemoval(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  const email = pick(e, ["email", "Email", "Email Address", "E-mail"]);
  const phone = pick(e, ["phone", "Phone", "Phone Number", "Mobile", "Cell"]);

  // We haven't captured the removal form payload yet, so support likely names.
  // When you submit one removal test, we can lock this to the exact key.
  const ministry = pick(e, [
    "ministry",
    "ministry_name",
    "RemovedMinistry",
    "Removed Ministry",
    "MinistryRemoved",
    "Ministry Removed",
    "MinistryToRemove",
    "Ministry to Remove",
  ]);

  return { email, phone, ministry };
}

/* ------------------------- Routes ------------------------- */

// POST /api/integrations/cognito/volunteer-ministry/add
router.post(
  "/cognito/volunteer-ministry/add",
  verifyWebhookSecret,
  async (req, res) => {
    try {
      const payload = mapAddition(req.body);

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
      console.error("Cognito add webhook error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  }
);

// POST /api/integrations/cognito/volunteer-ministry/remove
router.post(
  "/cognito/volunteer-ministry/remove",
  verifyWebhookSecret,
  async (req, res) => {
    try {
      const payload = mapRemoval(req.body);

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
      console.error("Cognito remove webhook error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  }
);

module.exports = router;

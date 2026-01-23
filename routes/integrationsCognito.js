// server-api/routes/integrationsCognito.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/* ------------------------- Debug helpers ------------------------- */
function nowIso() {
  return new Date().toISOString();
}

function maskSecret(s) {
  const str = String(s || "");
  if (!str) return "";
  if (str.length <= 4) return "*".repeat(str.length);
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

function ipChain(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    ""
  );
}

function topKeys(obj) {
  try {
    return obj && typeof obj === "object" ? Object.keys(obj) : [];
  } catch {
    return [];
  }
}

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

  const headerSecretRaw = String(
    req.headers["x-nlm-webhook-secret"] || "",
  ).trim();
  const querySecretRaw = String(req.query.secret || "").trim();

  let secretSource = "none";
  let got = "";

  if (headerSecretRaw) {
    secretSource = "header:x-nlm-webhook-secret";
    got = headerSecretRaw;
  } else if (querySecretRaw) {
    secretSource = "query:secret";
    got = querySecretRaw;
  }

  if (!got || got !== expected) {
    console.log("[Cognito] Invalid webhook secret", {
      at: nowIso(),
      endpoint: `${req.method} ${req.originalUrl}`,
      ip: ipChain(req),
      secretSource,
      got: maskSecret(got),
      expected: maskSecret(expected),
    });
    return res
      .status(401)
      .json({ ok: false, message: "Invalid webhook secret" });
  }

  // store for logging downstream
  req._cognitoSecretSource = secretSource;
  next();
}

/* ------------------------- Helpers ------------------------- */
function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      const v = typeof obj[k] === "string" ? obj[k].trim() : obj[k];
      if (typeof v === "string" && v) return v;
      if (typeof v !== "string" && v != null) return v;
    }
  }
  return null;
}

/**
 * Cognito can send:
 *  - { entry: { ... } }
 *  - or sometimes fields at top-level
 * Your latest working payload shows top-level fields (Form, first_name, etc.)
 * so we support both.
 */
function unwrapBody(body) {
  if (!body) return {};
  return body.entry || body.data || body.fields || body;
}

function parseYesNo(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

async function findUser({ email, phone }) {
  const emailNorm = email ? String(email).trim().toLowerCase() : null;
  const phoneDigits = digitsOnly(phone);

  if (emailNorm) {
    const r = await db.query(
      `SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [emailNorm],
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
      [phoneDigits],
    );
    if (r.rows[0]) return r.rows[0];
  }

  return null;
}

async function createUser({ first_name, last_name, email, phone }) {
  const emailNorm = email ? String(email).trim().toLowerCase() : null;

  const r = await db.query(
    `
    INSERT INTO users (first_name, last_name, email, phone, role, active)
    VALUES ($1, $2, $3, $4, $5, true)
    RETURNING *
    `,
    [first_name, last_name, emailNorm, phone || null, "volunteer"],
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
    [n],
  );
  if (r.rows[0]) return r.rows[0];

  r = await db.query(
    `INSERT INTO ministries (name, is_active)
     VALUES ($1, true)
     RETURNING id, name, COALESCE(is_active, true) AS is_active`,
    [n],
  );
  return r.rows[0];
}

async function addUserToMinistry(user_id, ministry_id) {
  await db.query(
    `INSERT INTO user_ministries (user_id, ministry_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [user_id, ministry_id],
  );
}

async function removeUserFromMinistry(user_id, ministry_id) {
  await db.query(
    `DELETE FROM user_ministries
     WHERE user_id = $1 AND ministry_id = $2`,
    [user_id, ministry_id],
  );
}

/* ------------------------- Mapping: Volunteer Ministry Addition (legacy) ------------------------- */
function mapVolunteerAddition(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  const first_name = pick(e, ["first_name", "Firstname", "FirstName", "x3"]);
  const last_name = pick(e, ["last_name", "LastName", "Lastname", "x5"]);
  const email = pick(e, ["email", "Email", "x6"]);
  const ministry = pick(e, ["ministry", "ApprovedMinistry", "Ministry", "x8"]);
  const phone = pick(e, ["phone", "Phone", "x9"]);

  return { first_name, last_name, email, phone, ministry };
}

function mapVolunteerRemoval(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  const email = pick(e, ["email", "Email", "Email Address", "E-mail"]);
  const phone = pick(e, ["phone", "Phone", "Phone Number", "Mobile", "Cell"]);

  // Template – update based on your removal form payload later
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

/* ------------------------- Mapping: Helps Member (Form ID 202) ------------------------- */
/**
 * Your test payload contains BOTH:
 *   Name: { First, Last, ... }
 *   FirstName / LastName (we created these hidden fields)
 *
 * We will prefer snake_case hidden fields if present:
 *   first_name, last_name
 *
 * IMPORTANT: In Cognito, make sure your hidden fields JSON Names are:
 *   first_name
 *   last_name
 *
 * Ministry field in your payload:
 *   MinistryApprovedFor
 *
 * New/Existing flag field:
 *   IsIndividualNewToHelpsMinistry  -> "Yes"/"No"
 */
function mapHelpsMember(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  // Prefer your DB-safe snake_case fields (hidden)
  const first_name =
    pick(e, ["first_name"]) ||
    pick(e, ["FirstName"]) ||
    pick(e, ["Name.First", "NameFirst"]); // fallback patterns (rare)

  const last_name =
    pick(e, ["last_name"]) ||
    pick(e, ["LastName"]) ||
    pick(e, ["Name.Last", "NameLast"]);

  // If Name object exists, use it as final fallback
  const nameObj = e && e.Name && typeof e.Name === "object" ? e.Name : null;
  const firstFromName =
    !first_name && nameObj ? pick(nameObj, ["First"]) : null;
  const lastFromName = !last_name && nameObj ? pick(nameObj, ["Last"]) : null;

  const email = pick(e, ["email", "Email"]);
  const phone = pick(e, ["phone", "Phone"]);

  const ministry =
    pick(e, ["ministry", "ministry_approved_for"]) ||
    pick(e, ["MinistryApprovedFor", "Ministry Approved For"]);

  const is_new_raw =
    pick(e, ["is_individual_new_to_helps_ministry"]) ||
    pick(e, [
      "IsIndividualNewToHelpsMinistry",
      "Is Individual New To Helps Ministry",
    ]);

  const is_new = parseYesNo(is_new_raw);

  // Form metadata
  const form = e.Form && typeof e.Form === "object" ? e.Form : null;
  const form_id = form ? pick(form, ["Id"]) : null;
  const form_internal = form ? pick(form, ["InternalName"]) : null;

  return {
    first_name: first_name || firstFromName || null,
    last_name: last_name || lastFromName || null,
    email: email ? String(email).trim() : null,
    phone: phone ? String(phone).trim() : null,
    ministry: ministry ? String(ministry).trim() : null,
    is_new,
    form_id,
    form_internal,
    raw_is_new: is_new_raw ? String(is_new_raw) : null,
  };
}

/* ------------------------- Core handler (shared) ------------------------- */
async function handleAddOrAttach({
  first_name,
  last_name,
  email,
  phone,
  ministryName,
  allowCreate,
}) {
  if (!ministryName) {
    return { ok: false, status: 400, message: "Missing ministry" };
  }
  if (!email && !phone) {
    return {
      ok: false,
      status: 400,
      message: "Missing identifier (email or phone)",
    };
  }

  // 1) find user
  let user = await findUser({ email, phone });

  // 2) create if allowed
  if (!user) {
    if (!allowCreate) {
      return {
        ok: false,
        status: 404,
        message: "User not found (and creation disabled for this request).",
      };
    }
    if (!first_name || !last_name) {
      return {
        ok: false,
        status: 400,
        message:
          "User not found; first_name and last_name are required to create a new user.",
      };
    }
    user = await createUser({ first_name, last_name, email, phone });
  }

  // 3) ensure ministry + attach
  const ministry = await ensureMinistryByName(ministryName);
  await addUserToMinistry(user.id, ministry.id);

  return {
    ok: true,
    action: "attached",
    user_id: user.id,
    ministry_id: ministry.id,
    ministry_name: ministry.name,
    created_user: !user ? false : undefined, // (kept minimal)
  };
}

/* ------------------------- Routes: Legacy Volunteer Ministry ------------------------- */

// POST /api/integrations/cognito/volunteer-ministry/add
router.post(
  "/cognito/volunteer-ministry/add",
  verifyWebhookSecret,
  async (req, res) => {
    const endpoint = `${req.method} ${req.originalUrl}`;
    try {
      console.log("[Cognito ADD legacy] HIT", {
        at: nowIso(),
        endpoint,
        ip: ipChain(req),
        secretSource: req._cognitoSecretSource,
        body_top_keys: topKeys(req.body),
        unwrapped_keys: topKeys(unwrapBody(req.body)),
      });

      const payload = mapVolunteerAddition(req.body);

      console.log("[Cognito ADD legacy] payload", payload);

      const result = await handleAddOrAttach({
        first_name: payload.first_name,
        last_name: payload.last_name,
        email: payload.email,
        phone: payload.phone,
        ministryName: payload.ministry,
        allowCreate: true,
      });

      return res.status(result.status || 200).json(result);
    } catch (err) {
      console.error("Cognito add webhook error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  },
);

// POST /api/integrations/cognito/volunteer-ministry/remove
router.post(
  "/cognito/volunteer-ministry/remove",
  verifyWebhookSecret,
  async (req, res) => {
    const endpoint = `${req.method} ${req.originalUrl}`;
    try {
      console.log("[Cognito REMOVE legacy] HIT", {
        at: nowIso(),
        endpoint,
        ip: ipChain(req),
        secretSource: req._cognitoSecretSource,
        body_top_keys: topKeys(req.body),
        unwrapped_keys: topKeys(unwrapBody(req.body)),
      });

      const payload = mapVolunteerRemoval(req.body);
      console.log("[Cognito REMOVE legacy] payload", payload);

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
  },
);

/* ------------------------- Routes: Helps Member (NEW Form) ------------------------- */
/**
 * MAIN:
 * POST /api/integrations/cognito/helps-member/submit
 *
 * Behavior:
 *  - If IsIndividualNewToHelpsMinistry == Yes  -> create if missing + attach ministry
 *  - If == No -> MUST find existing user, then attach ministry (no create)
 */
router.post(
  "/cognito/helps-member/submit",
  verifyWebhookSecret,
  async (req, res) => {
    const endpoint = `${req.method} ${req.originalUrl}`;
    try {
      console.log("[Cognito HELPS SUBMIT] HIT", {
        at: nowIso(),
        endpoint,
        ip: ipChain(req),
        secretSource: req._cognitoSecretSource,
        body_top_keys: topKeys(req.body),
        unwrapped_keys: topKeys(unwrapBody(req.body)),
      });

      const payload = mapHelpsMember(req.body);

      console.log("[Cognito HELPS SUBMIT] mapped payload", payload);

      // Decide create-vs-lookup based on the form field
      // If blank/unrecognized, default to "No create" for safety
      const allowCreate = payload.is_new === true;

      const result = await handleAddOrAttach({
        first_name: payload.first_name,
        last_name: payload.last_name,
        email: payload.email,
        phone: payload.phone,
        ministryName: payload.ministry,
        allowCreate,
      });

      // Add extra debug context to the response so you can see behavior quickly
      return res.status(result.status || 200).json({
        ...result,
        debug: {
          form_id: payload.form_id,
          form_internal: payload.form_internal,
          is_new_raw: payload.raw_is_new,
          allowCreate,
          secretSource: req._cognitoSecretSource,
        },
      });
    } catch (err) {
      console.error("Cognito HELPS submit error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  },
);

/**
 * OPTIONAL: Update Entry Endpoint
 * Cognito will post JSON when an entry is updated.
 * We typically re-run the same attach logic:
 *  - If they changed ministry, it will attach the new ministry
 *  - If they changed name/email/phone, it will NOT update user record here
 *    (keep this integration safe; we can add user-update logic later if you want)
 */
router.post(
  "/cognito/helps-member/update",
  verifyWebhookSecret,
  async (req, res) => {
    const endpoint = `${req.method} ${req.originalUrl}`;
    try {
      console.log("[Cognito HELPS UPDATE] HIT", {
        at: nowIso(),
        endpoint,
        ip: ipChain(req),
        secretSource: req._cognitoSecretSource,
        body_top_keys: topKeys(req.body),
        unwrapped_keys: topKeys(unwrapBody(req.body)),
      });

      const payload = mapHelpsMember(req.body);
      console.log("[Cognito HELPS UPDATE] mapped payload", payload);

      // Update should never create silently unless explicitly flagged "Yes"
      const allowCreate = payload.is_new === true;

      const result = await handleAddOrAttach({
        first_name: payload.first_name,
        last_name: payload.last_name,
        email: payload.email,
        phone: payload.phone,
        ministryName: payload.ministry,
        allowCreate,
      });

      return res.status(result.status || 200).json({
        ...result,
        debug: {
          form_id: payload.form_id,
          form_internal: payload.form_internal,
          is_new_raw: payload.raw_is_new,
          allowCreate,
          secretSource: req._cognitoSecretSource,
        },
      });
    } catch (err) {
      console.error("Cognito HELPS update error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  },
);

/**
 * OPTIONAL: Delete Entry Endpoint
 * If the form entry is deleted, we typically do NOT delete users/ministry links
 * (that can remove real ministry assignments unintentionally).
 *
 * This endpoint is mainly for audit/logging. If you want “delete entry -> remove ministry”
 * we can implement it, but I recommend a dedicated Removal form instead.
 */
router.post(
  "/cognito/helps-member/delete",
  verifyWebhookSecret,
  async (req, res) => {
    const endpoint = `${req.method} ${req.originalUrl}`;
    try {
      console.log("[Cognito HELPS DELETE] HIT", {
        at: nowIso(),
        endpoint,
        ip: ipChain(req),
        secretSource: req._cognitoSecretSource,
        body_top_keys: topKeys(req.body),
        unwrapped_keys: topKeys(unwrapBody(req.body)),
      });

      const payload = mapHelpsMember(req.body);
      console.log("[Cognito HELPS DELETE] mapped payload", payload);

      return res.json({
        ok: true,
        action: "noop",
        message:
          "Delete endpoint received. No DB changes performed (safe default).",
        debug: {
          form_id: payload.form_id,
          form_internal: payload.form_internal,
          secretSource: req._cognitoSecretSource,
        },
      });
    } catch (err) {
      console.error("Cognito HELPS delete error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  },
);

/* ------------------------- Removal Form Mapping Template ------------------------- */
/**
 * ✅ Use this template when you build a “Helps Ministry Removal” Cognito form.
 *
 * Recommended fields (with JSON Names):
 *  - email  (JSON: email)
 *  - phone  (JSON: phone)   // optional but useful
 *  - ministry_to_remove (JSON: ministry) or MinistryToRemove (pick one)
 *
 * Then point the form Submit Endpoint to:
 *   /api/integrations/cognito/helps-member/remove?secret=YOUR_SECRET
 *
 * After you submit ONE test entry, paste the payload here and we’ll lock mapping keys.
 */
// router.post("/cognito/helps-member/remove", verifyWebhookSecret, async (req, res) => {
//   // TODO: implement like legacy remove but with your final field keys
// });

module.exports = router;

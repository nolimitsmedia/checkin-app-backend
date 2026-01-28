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
 *  - or { entries: [ { ... } ] } (batch/entries format)
 */
function unwrapBody(body) {
  if (!body) return {};
  const root = body.entry || body.data || body.fields || body;
  if (root && Array.isArray(root.entries) && root.entries[0])
    return root.entries[0];
  return root;
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

function normalizeArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/**
 * ✅ Converts:
 *  - ["Audio", "Security"] -> ["Audio","Security"]
 *  - "Audio, Security" -> ["Audio","Security"]
 *  - "Audio\nSecurity" -> ["Audio","Security"]
 */
function parseMinistryList(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((s) => String(s || "").trim()).filter(Boolean);
  }
  const s = String(v || "").trim();
  if (!s) return [];
  return s
    .split(/\r?\n|,|;/g)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
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

/**
 * ✅ Recommended for removal flows:
 * DO NOT create ministries. Only remove if the ministry already exists.
 */
async function findMinistryByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;

  const r = await db.query(
    `SELECT id, name, COALESCE(is_active, true) AS is_active
     FROM ministries
     WHERE LOWER(name) = LOWER($1)
     LIMIT 1`,
    [n],
  );
  return r.rows[0] || null;
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

/* ------------------------- Mapping: Helps Member (Submit/Update form) ------------------------- */
function mapHelpsMember(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  const first_name =
    pick(e, ["first_name"]) ||
    pick(e, ["FirstName"]) ||
    pick(e, ["Name.First", "NameFirst"]);

  const last_name =
    pick(e, ["last_name"]) ||
    pick(e, ["LastName"]) ||
    pick(e, ["Name.Last", "NameLast"]);

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

  const form = e.Form && typeof e.Form === "object" ? e.Form : null;
  const form_id = form ? pick(form, ["Id"]) : null;
  const form_internal = form ? pick(form, ["InternalName"]) : null;

  return {
    first_name: first_name || firstFromName || null,
    last_name: last_name || lastFromName || null,
    email: email ? String(email).trim().toLowerCase() : null,
    phone: phone ? String(phone).trim() : null,
    ministry: ministry ? String(ministry).trim() : null,
    is_new,
    form_id,
    form_internal,
    raw_is_new: is_new_raw ? String(is_new_raw) : null,
  };
}

/* ------------------------- Mapping: Helps Change Form (Membership Removal) ------------------------- */
function mapHelpsChange(bodyRaw) {
  const e = unwrapBody(bodyRaw);

  // Member name (the person being removed)
  const memberObj =
    (e.member_name && typeof e.member_name === "object" && e.member_name) ||
    (e.MemberName && typeof e.MemberName === "object" && e.MemberName) ||
    null;

  const member_first_name = memberObj ? pick(memberObj, ["First"]) : null;
  const member_last_name = memberObj ? pick(memberObj, ["Last"]) : null;

  // Requester name (who submitted the change) – optional
  const requesterObj =
    (e.Name && typeof e.Name === "object" && e.Name) ||
    (e.requester_name &&
      typeof e.requester_name === "object" &&
      e.requester_name) ||
    null;

  const requester_first_name = requesterObj
    ? pick(requesterObj, ["First"])
    : null;
  const requester_last_name = requesterObj
    ? pick(requesterObj, ["Last"])
    : null;

  const email = pick(e, ["email", "Email"]);
  const phone = pick(e, ["phone", "Phone"]);

  // Ministries to remove: supports multi-line or comma-separated
  const ministries_inactive_raw = pick(e, ["ministries_inactive"]);
  const ministries_to_remove = parseMinistryList(ministries_inactive_raw);

  // Additional context fields
  const membership_action = pick(e, ["membership_action"]);
  const reason = pick(e, ["reason_for_inactivity"]);
  const effective_date =
    pick(e, ["effective_date_removal2"]) || pick(e, ["effective_date_removal"]);

  const change_types = normalizeArray(pick(e, ["change_types"]));

  const ministry_context = pick(e, ["MinistryName", "ministry_name"]);
  const requester_role = pick(e, [
    "AreYouTheElderOrOverseerOfThisMinistry",
    "requester_role",
  ]);
  const approved_by = pick(e, ["ChangeRequestApprovedBy", "approved_by"]);

  const form = e.Form && typeof e.Form === "object" ? e.Form : null;
  const form_id = form ? pick(form, ["Id"]) : null;
  const form_internal = form ? pick(form, ["InternalName"]) : null;

  const entry = e.Entry && typeof e.Entry === "object" ? e.Entry : null;
  const entry_number = entry ? pick(entry, ["Number"]) : null;
  const entry_status = entry ? pick(entry, ["Status"]) : null;

  const entry_id = pick(e, ["Id"]);

  return {
    requester_first_name,
    requester_last_name,
    member_first_name,
    member_last_name,
    email: email ? String(email).trim().toLowerCase() : null,
    phone: phone ? String(phone).trim() : null,
    ministries_to_remove,
    membership_action: membership_action
      ? String(membership_action).trim()
      : null,
    effective_date_raw: effective_date ? String(effective_date).trim() : null,
    reason: reason ? String(reason).trim() : null,
    change_types,
    ministry_context: ministry_context ? String(ministry_context).trim() : null,
    requester_role: requester_role ? String(requester_role).trim() : null,
    approved_by: approved_by ? String(approved_by).trim() : null,
    form_id,
    form_internal,
    entry_id,
    entry_number,
    entry_status,
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

  let user = await findUser({ email, phone });

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

  const ministry = await ensureMinistryByName(ministryName);
  await addUserToMinistry(user.id, ministry.id);

  return {
    ok: true,
    action: "attached",
    user_id: user.id,
    ministry_id: ministry.id,
    ministry_name: ministry.name,
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
        return res
          .status(400)
          .json({ ok: false, message: "Missing identifier (email or phone)" });
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

      // Removal: do NOT create ministries
      const ministry = await findMinistryByName(payload.ministry);
      if (!ministry) {
        return res.json({
          ok: true,
          action: "noop",
          message: "Ministry not found (no changes made).",
          ministry_name: payload.ministry,
        });
      }

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

/* ------------------------- Routes: Helps Member (Submit/Update/Delete) ------------------------- */

// POST /api/integrations/cognito/helps-member/submit
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
      console.error("Cognito HELPS submit error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  },
);

// POST /api/integrations/cognito/helps-member/update
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

// POST /api/integrations/cognito/helps-member/delete
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

/* ------------------------- Route: Helps Change Form (Membership Removal) ------------------------- */
/**
 * POST /api/integrations/cognito/helps-member/change
 *
 * Removal safety:
 *  - DOES NOT create ministries
 *  - If a ministry name doesn't exist, it is returned in not_found[]
 *
 * Dry run:
 *  - add ?dryRun=1 to avoid deleting rows
 */
router.post(
  "/cognito/helps-member/change",
  verifyWebhookSecret,
  async (req, res) => {
    const endpoint = `${req.method} ${req.originalUrl}`;
    try {
      console.log("[Cognito HELPS CHANGE] HIT", {
        at: nowIso(),
        endpoint,
        ip: ipChain(req),
        secretSource: req._cognitoSecretSource,
        body_top_keys: topKeys(req.body),
        unwrapped_keys: topKeys(unwrapBody(req.body)),
      });

      const payload = mapHelpsChange(req.body);
      console.log("[Cognito HELPS CHANGE] mapped payload", payload);

      if (!payload.email && !payload.phone) {
        return res.status(400).json({
          ok: false,
          message: "Missing identifier (email or phone)",
          debug: { form_id: payload.form_id, entry_id: payload.entry_id },
        });
      }

      if (
        !payload.ministries_to_remove ||
        payload.ministries_to_remove.length === 0
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Missing ministries_inactive (no ministries provided to remove)",
          debug: { form_id: payload.form_id, entry_id: payload.entry_id },
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
          debug: {
            form_id: payload.form_id,
            form_internal: payload.form_internal,
            entry_id: payload.entry_id,
            secretSource: req._cognitoSecretSource,
          },
        });
      }

      const dryRun = String(req.query.dryRun || "").trim() === "1";
      const removed = [];
      const not_found = [];

      for (const name of payload.ministries_to_remove) {
        const ministry = await findMinistryByName(name);
        if (!ministry) {
          not_found.push({ ministry_name: name });
          continue;
        }

        if (!dryRun) {
          await removeUserFromMinistry(user.id, ministry.id);
        }

        removed.push({
          ministry_id: ministry.id,
          ministry_name: ministry.name,
          dryRun,
        });
      }

      return res.json({
        ok: true,
        action: dryRun ? "dry_run_remove" : "removed",
        user_id: user.id,
        removed,
        not_found,
        debug: {
          requester_first_name: payload.requester_first_name,
          requester_last_name: payload.requester_last_name,
          member_first_name: payload.member_first_name,
          member_last_name: payload.member_last_name,
          membership_action: payload.membership_action,
          effective_date_raw: payload.effective_date_raw,
          reason: payload.reason,
          change_types: payload.change_types,
          ministry_context: payload.ministry_context,
          requester_role: payload.requester_role,
          approved_by: payload.approved_by,
          form_id: payload.form_id,
          form_internal: payload.form_internal,
          entry_id: payload.entry_id,
          entry_number: payload.entry_number,
          entry_status: payload.entry_status,
          secretSource: req._cognitoSecretSource,
        },
      });
    } catch (err) {
      console.error("Cognito HELPS change error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  },
);

module.exports = router;

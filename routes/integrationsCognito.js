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

/* ------------------------- DB helpers ------------------------- */
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

/* ------------------------- Mapping: Helps Member (Newly Approved) ------------------------- */
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
    email: email ? String(email).trim() : null,
    phone: phone ? String(phone).trim() : null,
    ministry: ministry ? String(ministry).trim() : null,
    is_new,
    form_id,
    form_internal,
    raw_is_new: is_new_raw ? String(is_new_raw) : null,
  };
}

/* ------------------------- Mapping: Helps Change Form (removals) ------------------------- */
/**
 * Change Form payload shape (you pasted):
 * { entries: [ { x33:{First,Last}, x34, x35, x5[], x26, x11, x36, x37, x31, x38, Form, Id } ] }
 */
function unwrapCognitoEntry(body) {
  if (!body) return {};
  if (Array.isArray(body.entries) && body.entries[0]) return body.entries[0];
  return body.entry || body.data || body.fields || body;
}

function mapHelpsChangeForm(bodyRaw) {
  const e = unwrapCognitoEntry(bodyRaw);

  const memberNameObj = e?.x33 && typeof e.x33 === "object" ? e.x33 : null;

  const first_name = memberNameObj?.First
    ? String(memberNameObj.First).trim()
    : null;
  const last_name = memberNameObj?.Last
    ? String(memberNameObj.Last).trim()
    : null;

  const email = e?.x34 ? String(e.x34).trim() : null;
  const phone = e?.x35 ? String(e.x35).trim() : null;

  const change_types = Array.isArray(e?.x5) ? e.x5.map(String) : [];
  const membership_action = e?.x26 ? String(e.x26).trim() : null;

  const ministry_serving = e?.x36 ? String(e.x36).trim() : null;
  const ministry_name = e?.x11 ? String(e.x11).trim() : null;
  const ministry_inactive = e?.x37 ? String(e.x37).trim() : null;

  const ministry_target =
    ministry_serving || ministry_name || ministry_inactive || null;

  const effective_date_raw = e?.x31 ? String(e.x31).trim() : null;
  const reason = e?.x38 ? String(e.x38).trim() : null;

  const form = e?.Form && typeof e.Form === "object" ? e.Form : null;
  const form_id = form?.Id ? String(form.Id) : null;
  const form_internal = form?.InternalName ? String(form.InternalName) : null;

  return {
    first_name,
    last_name,
    email,
    phone,
    change_types,
    membership_action,
    ministry_target,
    ministry_serving,
    ministry_name,
    ministry_inactive,
    effective_date_raw,
    reason,
    form_id,
    form_internal,
    entry_id: e?.Id ? String(e.Id) : null,
  };
}

function includesMembershipRemove(change_types, membership_action) {
  const types = (change_types || []).map((s) => String(s).toLowerCase());
  const action = String(membership_action || "").toLowerCase();

  const pickedMembership = types.some((t) => t.includes("membership"));
  const removeAction =
    action.includes("removed") ||
    action.includes("remove") ||
    action.includes("member to be removed");

  return pickedMembership && removeAction;
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

/* ------------------------- Routes: Helps Member (Newly Approved) ------------------------- */

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

// POST /api/integrations/cognito/helps-member/delete  (safe noop)
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

/* ------------------------- Routes: Helps Member Change (your current Delete Entry Endpoint URL) ------------------------- */
/**
 * You said you are using:
 *   /api/integrations/cognito/helps-member/change?secret=...
 *
 * This endpoint is designed for the “Helps Ministry - Change Form” payload.
 * It will ONLY remove a ministry when it is clearly a membership removal request.
 *
 * Safe behavior:
 * - does NOT delete users
 * - does NOT remove ministries unless:
 *     x5 contains "Membership ..."
 *     AND x26 indicates member removal
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
        unwrapped_keys: topKeys(unwrapCognitoEntry(req.body)),
      });

      const payload = mapHelpsChangeForm(req.body);

      console.log("[Cognito HELPS CHANGE] mapped payload", {
        first_name: payload.first_name,
        last_name: payload.last_name,
        email: payload.email,
        phone: payload.phone,
        ministry_target: payload.ministry_target,
        change_types: payload.change_types,
        membership_action: payload.membership_action,
        effective_date_raw: payload.effective_date_raw,
        reason: payload.reason,
        form_id: payload.form_id,
        form_internal: payload.form_internal,
        entry_id: payload.entry_id,
      });

      const shouldRemove = includesMembershipRemove(
        payload.change_types,
        payload.membership_action,
      );

      if (!shouldRemove) {
        return res.json({
          ok: true,
          action: "noop",
          message:
            "Change endpoint received, but no supported membership removal action detected (safe default).",
          debug: {
            secretSource: req._cognitoSecretSource,
            form_id: payload.form_id,
            entry_id: payload.entry_id,
          },
        });
      }

      if (!payload.ministry_target) {
        return res.status(400).json({
          ok: false,
          message: "Missing target ministry for removal",
        });
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
        return res.status(404).json({
          ok: false,
          message:
            "User not found — cannot remove ministry (check email/phone matches existing record).",
          debug: {
            email: payload.email,
            phone_last4: digitsOnly(payload.phone).slice(-4),
            ministry_target: payload.ministry_target,
          },
        });
      }

      const ministry = await ensureMinistryByName(payload.ministry_target);
      await removeUserFromMinistry(user.id, ministry.id);

      console.log("[Cognito HELPS CHANGE] RESULT", {
        at: nowIso(),
        endpoint,
        action: "removed",
        user_id: user.id,
        ministry_id: ministry.id,
        ministry_name: ministry.name,
        effective_date_raw: payload.effective_date_raw,
      });

      return res.json({
        ok: true,
        action: "removed",
        user_id: user.id,
        ministry_id: ministry.id,
        ministry_name: ministry.name,
        debug: {
          effective_date_raw: payload.effective_date_raw,
          reason: payload.reason,
          change_types: payload.change_types,
          membership_action: payload.membership_action,
          form_id: payload.form_id,
          entry_id: payload.entry_id,
          secretSource: req._cognitoSecretSource,
        },
      });
    } catch (err) {
      console.error("Cognito HELPS change error:", err);
      return res.status(500).json({ ok: false, message: "Webhook failed" });
    }
  },
);

/* ------------------------- Removal Form Mapping Template (optional future) ------------------------- */
/**
 * If you later build a dedicated “Helps Ministry Removal” form, we can add:
 *   POST /api/integrations/cognito/helps-member/remove
 * with a clean snake_case mapping (email/phone/ministry).
 */

module.exports = router;

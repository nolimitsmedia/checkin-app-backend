// server-api/routes/users.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

/* ============================================================================
 * GET /users/all - Fetch all users with ministry data
 * ========================================================================== */
router.get("/all", authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.first_name, u.last_name, m.name AS ministry
      FROM users u
      LEFT JOIN user_ministries um ON um.user_id = u.id
      LEFT JOIN ministries m ON m.id = um.ministry_id
      ORDER BY u.last_name, u.first_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching all users:", err);
    res.status(500).json({ message: "Failed to fetch users." });
  }
});

/* ============================================================================
 * GET /api/users/elders
 * ========================================================================== */
router.get("/elders", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, first_name, last_name, phone, alt_phone FROM elders"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch elders:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ============================================================================
 * NEW: GET /api/users/lookup?phone=...  (Kiosk/self-service friendly)
 * - Finds users by phone or alt_phone (digits-only matching)
 * ========================================================================== */
router.get("/lookup", authenticate, async (req, res) => {
  const phoneRaw = String(req.query.phone || "");
  const digits = phoneRaw.replace(/\D/g, "");
  if (!digits) return res.json([]);

  try {
    const { rows } = await db.query(
      `
      SELECT id, first_name, last_name, phone, alt_phone, role, avatar
      FROM users
      WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE $1
         OR regexp_replace(COALESCE(alt_phone,''), '[^0-9]', '', 'g') LIKE $1
      ORDER BY last_name, first_name
      LIMIT 25
    `,
      [`%${digits}%`]
    );
    res.json(rows);
  } catch (e) {
    console.error("lookup error:", e);
    res.status(500).json({ message: "Lookup failed" });
  }
});

/* ============================================================================
 * GET /api/users?search=Jane  (includes elders; improved phone search)
 * ========================================================================== */
router.get("/", authenticate, async (req, res) => {
  const searchRaw = req.query.search;
  const search = searchRaw ? searchRaw.toLowerCase() : null;

  try {
    if (search) {
      const query = `
        SELECT CONCAT('user-', u.id) AS id, u.first_name, u.last_name, u.phone, u.alt_phone, u.role, u.avatar, u.family_id, f.family_name
        FROM users u
        LEFT JOIN families f ON u.family_id = f.id
        WHERE LOWER(u.first_name) LIKE $1 OR LOWER(u.last_name) LIKE $1
          OR regexp_replace(COALESCE(u.phone,''), '[^0-9]', '', 'g') LIKE regexp_replace($2, '[^0-9]', '', 'g')
          OR regexp_replace(COALESCE(u.alt_phone,''), '[^0-9]', '', 'g') LIKE regexp_replace($2, '[^0-9]', '', 'g')
        UNION ALL
        SELECT CONCAT('elder-', e.id) AS id, e.first_name, e.last_name, e.phone, e.alt_phone, e.role, e.avatar, e.family_id, f.family_name
        FROM elders e
        LEFT JOIN families f ON e.family_id = f.id
        WHERE LOWER(e.first_name) LIKE $1 OR LOWER(e.last_name) LIKE $1
          OR regexp_replace(COALESCE(e.phone,''), '[^0-9]', '', 'g') LIKE regexp_replace($2, '[^0-9]', '', 'g')
          OR regexp_replace(COALESCE(e.alt_phone,''), '[^0-9]', '', 'g') LIKE regexp_replace($2, '[^0-9]', '', 'g')
      `;
      const params = [`%${search}%`, `%${search}%`];

      const result = await db.query(query, params);
      res.json(result.rows);
    } else {
      const query = `
        SELECT CONCAT('user-', u.id) AS id, u.first_name, u.last_name, u.phone, u.alt_phone, u.role, u.avatar, u.family_id, f.family_name
        FROM users u
        LEFT JOIN families f ON u.family_id = f.id
        UNION ALL
        SELECT CONCAT('elder-', e.id) AS id, e.first_name, e.last_name, e.phone, e.alt_phone, e.role, e.avatar, e.family_id, f.family_name
        FROM elders e
        LEFT JOIN families f ON e.family_id = f.id
      `;
      const result = await db.query(query);
      res.json(result.rows);
    }
  } catch (err) {
    console.error("Error searching users/elders:", err);
    res.status(500).send("Server error");
  }
});

/* ============================================================================
 * GET /api/users/:id/details
 * ========================================================================== */
router.get("/:id/details", authenticate, async (req, res) => {
  const rawId = req.params.id;
  const isElder = rawId.startsWith("elder-");
  const id = parseInt(rawId.replace(/^[^\d]+/, ""), 10);

  const targetTable = isElder ? "elders" : "users";
  const relationTable = isElder ? "elder_ministries" : "user_ministries";

  try {
    const userResult = await db.query(
      `SELECT * FROM ${targetTable} WHERE id = $1`,
      [id]
    );
    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const ministriesResult = await db.query(
      `SELECT m.name FROM ministries m
       JOIN ${relationTable} um ON um.ministry_id = m.id
       WHERE um.${isElder ? "elder" : "user"}_id = $1`,
      [id]
    );

    const eldersResult = isElder
      ? []
      : await db.query(
          `SELECT e.first_name, e.last_name FROM elders e
           JOIN elder_ministries em ON em.elder_id = e.id
           JOIN user_ministries um ON um.ministry_id = em.ministry_id
           WHERE um.user_id = $1`,
          [id]
        );

    res.json({
      user,
      ministries: ministriesResult.rows.map((row) => row.name),
      elders: isElder
        ? []
        : eldersResult.rows.map((e) => `${e.first_name} ${e.last_name}`),
    });
  } catch (err) {
    console.error("Error fetching user details:", err);
    res.status(500).send("Server error");
  }
});

/* ============================================================================
 * GET /api/users/masterlist
 * - Returns combined users + elders, with arrays of ministries + ministry_ids
 * - Maps role 'user' → 'member' for the frontend
 * ========================================================================== */
router.get("/masterlist", authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        CASE WHEN u.role = 'elder' THEN CONCAT('elder-', u.id) ELSE CONCAT('user-', u.id) END AS id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.alt_phone,
        u.role,
        u.avatar,
        u.active,
        u.gender,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.name), NULL) AS ministries,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.id), NULL) AS ministry_ids
      FROM (
        SELECT id, first_name, last_name, email, phone, alt_phone, role, gender, avatar, COALESCE(active, true) as active FROM users
        UNION ALL
        SELECT id, first_name, last_name, email, phone, alt_phone, role, gender, avatar, COALESCE(active, true) as active FROM elders
      ) u
      LEFT JOIN user_ministries um ON um.user_id = u.id AND u.role != 'elder'
      LEFT JOIN elder_ministries em ON em.elder_id = u.id AND u.role = 'elder'
      LEFT JOIN ministries m ON (m.id = um.ministry_id OR m.id = em.ministry_id)
      GROUP BY u.id, u.first_name, u.last_name, u.email, u.phone, u.alt_phone, u.role, u.avatar, u.active, u.gender
      ORDER BY u.first_name, u.last_name
    `);

    const rows = result.rows.map((row) => ({
      ...row,
      role: row.role === "user" ? "member" : row.role,
    }));

    res.json(rows);
  } catch (err) {
    console.error("❌ Error in masterlist:", err.message);
    res.status(500).send("Server error");
  }
});

/* ============================================================================
 * PUT /api/users/:id
 * - Updates user/elder record, ministries, etc.
 * - Handles cross-table moves when role changes between 'elder' and 'user'
 * - Hardened against NaN path param: falls back to body.id (e.g., "user-2264")
 * ========================================================================== */
router.put("/:id", authenticate, async (req, res) => {
  const allowedRoles = ["admin", "super_admin"];
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  // Fallback: if path id is mangled (e.g., "NaN"), try body.id
  let rawId = req.params.id;
  if (!/\d/.test(String(rawId || "")) && typeof req.body.id === "string") {
    rawId = req.body.id;
  }
  const id = parseInt(String(rawId).replace(/^[^\d]+/, ""), 10);
  if (isNaN(id)) {
    return res.status(400).json({ message: "Invalid ID format" });
  }

  const {
    first_name,
    last_name,
    email,
    phone,
    alt_phone,
    role,
    family_id,
    avatar,
    active,
    gender,
    ministry_ids = [],
  } = req.body;

  console.log("Update user payload received:", {
    rawId: req.params.id,
    fallbackId: req.body.id,
    parsedId: id,
    first_name,
    last_name,
    email,
    phone,
    alt_phone,
    role,
    family_id,
    avatar,
    active,
    gender,
    ministry_ids,
  });

  const oldRole = String(rawId).startsWith("elder-") ? "elder" : "user";
  const newRole = (role || "").toLowerCase();

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const oldIsElder = oldRole === "elder";
    const newIsElder = newRole === "elder";

    if (oldIsElder !== newIsElder) {
      // Move rows between elders <-> users
      const oldTable = oldIsElder ? "elders" : "users";
      const oldRelationTable = oldIsElder
        ? "elder_ministries"
        : "user_ministries";
      const newTable = newIsElder ? "elders" : "users";
      const newRelationTable = newIsElder
        ? "elder_ministries"
        : "user_ministries";

      const oldRoleIdColumn = oldIsElder ? "elder_id" : "user_id";
      const newRoleIdColumn = newIsElder ? "elder_id" : "user_id";

      const { rows: oldUserRows } = await client.query(
        `SELECT * FROM ${oldTable} WHERE id = $1`,
        [id]
      );
      if (oldUserRows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }
      const oldUser = oldUserRows[0];

      const activeVal =
        typeof active === "string"
          ? active === "true"
          : active === undefined
          ? oldUser.active
          : !!active;

      const { rows: newUserRows } = await client.query(
        `INSERT INTO ${newTable} (first_name, last_name, email, phone, alt_phone, role, avatar, family_id, gender, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          first_name ?? oldUser.first_name,
          last_name ?? oldUser.last_name,
          email ?? oldUser.email,
          phone !== undefined ? phone : oldUser.phone,
          alt_phone !== undefined ? alt_phone : oldUser.alt_phone,
          role || oldUser.role,
          avatar ?? oldUser.avatar,
          family_id ?? oldUser.family_id,
          gender ?? oldUser.gender,
          activeVal,
        ]
      );
      const newUser = newUserRows[0];

      // Clear old relations and add new
      await client.query(
        `DELETE FROM ${oldRelationTable} WHERE ${oldRoleIdColumn} = $1`,
        [id]
      );
      if (Array.isArray(ministry_ids) && ministry_ids.length > 0) {
        const { rows: validMinistries } = await client.query(
          `SELECT id FROM ministries WHERE id = ANY($1)`,
          [ministry_ids]
        );
        for (const m of validMinistries) {
          await client.query(
            `INSERT INTO ${newRelationTable} (${newRoleIdColumn}, ministry_id) VALUES ($1, $2)`,
            [newUser.id, m.id]
          );
        }
      }

      // Remove old row
      await client.query(`DELETE FROM ${oldTable} WHERE id = $1`, [id]);

      await client.query("COMMIT");
      return res.json(newUser);
    } else {
      // Update inside same table
      const targetTable = newIsElder ? "elders" : "users";
      const relationTable = newIsElder ? "elder_ministries" : "user_ministries";
      const roleIdColumn = newIsElder ? "elder_id" : "user_id";

      const activeVal =
        active === undefined
          ? null
          : typeof active === "string"
          ? active === "true"
          : !!active;

      // Build SET clause dynamically so we don't overwrite with nulls inadvertently
      const sets = [
        "first_name = $1",
        "last_name = $2",
        "email = $3",
        "phone = $4",
        "alt_phone = $5",
        "role = $6",
        "family_id = $7",
        "avatar = $8",
        "gender = $9",
      ];
      const values = [
        first_name ?? null,
        last_name ?? null,
        email ?? null,
        phone !== undefined ? phone : null,
        alt_phone !== undefined ? alt_phone : null,
        role ?? (newIsElder ? "elder" : "user"),
        family_id ?? null,
        avatar ?? null,
        gender ?? null,
      ];

      // active: only set if provided, otherwise keep existing
      if (activeVal === null) {
        // do not include "active" in UPDATE, keep existing value
      } else {
        sets.push("active = $10");
        values.push(activeVal);
      }

      values.push(id);

      const result = await client.query(
        `UPDATE ${targetTable}
         SET ${sets.join(", ")}
         WHERE id = $${values.length} RETURNING *`,
        values
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }

      // Update ministries
      await client.query(
        `DELETE FROM ${relationTable} WHERE ${roleIdColumn} = $1`,
        [id]
      );
      if (Array.isArray(ministry_ids) && ministry_ids.length > 0) {
        const { rows: validMinistries } = await client.query(
          `SELECT id FROM ministries WHERE id = ANY($1)`,
          [ministry_ids]
        );
        for (const m of validMinistries) {
          await client.query(
            `INSERT INTO ${relationTable} (${roleIdColumn}, ministry_id) VALUES ($1, $2)`,
            [id, m.id]
          );
        }
      }

      await client.query("COMMIT");
      return res.json(result.rows[0]);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update user error:", err);
    res.status(500).json({ message: "Failed to update user" });
  } finally {
    client.release();
  }
});

/* ============================================================================
 * PATCH /api/users/:id/active   (protect + simple toggle)
 * ========================================================================== */
router.patch("/:id/active", authenticate, async (req, res) => {
  const allowedRoles = ["admin", "super_admin"];
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const id = parseInt(String(req.params.id).replace(/^[^\d]+/, ""), 10);
  if (!Number.isFinite(id))
    return res.status(400).json({ message: "Invalid id" });

  const active =
    typeof req.body.active === "string"
      ? req.body.active === "true"
      : !!req.body.active;

  try {
    await db.query("UPDATE users SET active=$1 WHERE id=$2", [active, id]);
    res.json({ success: true });
  } catch (e) {
    console.error("PATCH active error:", e);
    res
      .status(500)
      .json({ success: false, message: "Failed to update active" });
  }
});

/* ============================================================================
 * DELETE /api/users/:id
 * ========================================================================== */
router.delete("/:id", authenticate, async (req, res) => {
  const allowedRoles = ["admin", "super_admin"];
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const rawId = req.params.id;
  const roleParam =
    req.query.role || (rawId.startsWith("elder-") ? "elder" : "user");

  const role = roleParam.toLowerCase();
  const targetTable = role === "elder" ? "elders" : "users";
  const relationTable =
    role === "elder" ? "elder_ministries" : "user_ministries";

  try {
    const id = parseInt(rawId.replace(/^[^\d]+/, ""), 10);
    if (isNaN(id)) {
      return res.status(400).json({ message: "Invalid ID format" });
    }

    await db.query(`DELETE FROM ${relationTable} WHERE ${role}_id = $1`, [id]);
    const result = await db.query(`DELETE FROM ${targetTable} WHERE id = $1`, [
      id,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Record not found" });
    }

    res.json({ message: `${role} deleted successfully` });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ message: "Failed to delete record" });
  }
});

/* ============================================================================
 * POST /api/users — create a new user or elder
 * ========================================================================== */
router.post("/", authenticate, async (req, res) => {
  console.log("Create user request body:", req.body);
  let {
    first_name,
    last_name,
    email,
    phone,
    alt_phone,
    role,
    avatar,
    family_id,
    gender,
  } = req.body;

  // Basic validations
  if (!first_name || !last_name || !role) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  role = role.toLowerCase();

  if (
    role !== "member" &&
    role !== "elder" &&
    role !== "volunteer" &&
    role !== "staff"
  ) {
    return res.status(400).json({
      message: "Role must be one of: member, elder, volunteer, or staff.",
    });
  }

  // Normalize role: store 'member' as 'user' internally to match users table
  const dbRole = role === "member" ? "user" : role;

  const isElder = dbRole === "elder";

  try {
    const result = await db.query(
      `INSERT INTO ${
        isElder ? "elders" : "users"
      } (first_name, last_name, email, phone, alt_phone, role, avatar, family_id, gender)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        first_name,
        last_name,
        email || null,
        phone || null,
        alt_phone || null,
        dbRole,
        avatar || null,
        family_id || null,
        gender || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating user:", err);

    if (err.code === "23505") {
      return res.status(409).json({ message: "Email already exists." });
    }

    res.status(500).json({ message: "Failed to create user." });
  }
});

module.exports = router;

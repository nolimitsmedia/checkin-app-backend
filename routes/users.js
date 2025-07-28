const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// GET /users/all - Fetch all users with ministry data
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

// ✅ GET /api/users/elders
router.get("/elders", authenticate, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, first_name, last_name FROM elders"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Failed to fetch elders:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ GET /api/users?search=Jane (now with family_name!)
router.get("/", authenticate, async (req, res) => {
  const searchRaw = req.query.search;
  const search = searchRaw ? searchRaw.toLowerCase() : null;

  try {
    if (search) {
      const query = `
        SELECT CONCAT('user-', u.id) AS id, u.first_name, u.last_name, u.phone, u.role, u.avatar, u.family_id, f.family_name
        FROM users u
        LEFT JOIN families f ON u.family_id = f.id
        WHERE LOWER(u.first_name) LIKE $1 OR LOWER(u.last_name) LIKE $1 OR u.phone LIKE $2
        UNION ALL
        SELECT CONCAT('elder-', e.id) AS id, e.first_name, e.last_name, e.phone, e.role, e.avatar, e.family_id, f.family_name
        FROM elders e
        LEFT JOIN families f ON e.family_id = f.id
        WHERE LOWER(e.first_name) LIKE $1 OR LOWER(e.last_name) LIKE $1 OR e.phone LIKE $2
      `;
      const params = [`%${search}%`, `%${search}%`];

      const result = await db.query(query, params);
      res.json(result.rows);
    } else {
      const query = `
        SELECT CONCAT('user-', u.id) AS id, u.first_name, u.last_name, u.phone, u.role, u.avatar, u.family_id, f.family_name
        FROM users u
        LEFT JOIN families f ON u.family_id = f.id
        UNION ALL
        SELECT CONCAT('elder-', e.id) AS id, e.first_name, e.last_name, e.phone, e.role, e.avatar, e.family_id, f.family_name
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

// ✅ GET /api/users/:id/details
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

// ✅ GET /api/users/masterlist
router.get("/masterlist", authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        CASE WHEN u.role = 'elder' THEN CONCAT('elder-', u.id) ELSE CONCAT('user-', u.id) END AS id,
        u.first_name,
        u.last_name,
        u.email,
        u.role,
        u.avatar,
        u.active,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.name), NULL) AS ministries,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.id), NULL) AS ministry_ids
      FROM (
        SELECT id, first_name, last_name, email, role, avatar, COALESCE(active, true) as active FROM users
        UNION ALL
        SELECT id, first_name, last_name, email, role, avatar, COALESCE(active, true) as active FROM elders

      ) u
      LEFT JOIN user_ministries um ON um.user_id = u.id AND u.role != 'elder'
      LEFT JOIN elder_ministries em ON em.elder_id = u.id AND u.role = 'elder'
      LEFT JOIN ministries m ON (m.id = um.ministry_id OR m.id = em.ministry_id)
      GROUP BY u.id, u.first_name, u.last_name, u.email, u.role, u.avatar, u.active
      ORDER BY u.first_name, u.last_name
    `);

    console.log("DEBUG /masterlist rows:", result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error in masterlist:", err.message);
    res.status(500).send("Server error");
  }
});

// // ✅ PUT /api/users/:id — FIXED to update family_id as well!
// router.put("/:id", authenticate, async (req, res) => {
//   const allowedRoles = ["admin", "super_admin"];
//   if (!allowedRoles.includes(req.user.role)) {
//     return res.status(403).json({ message: "Unauthorized" });
//   }

//   const rawId = req.params.id;
//   const roleParam =
//     req.query.role || (rawId.startsWith("elder-") ? "elder" : "user");
//   const id = parseInt(rawId.replace(/^[^\d]+/, ""), 10);
//   if (isNaN(id)) {
//     return res.status(400).json({ message: "Invalid ID format" });
//   }

//   const { first_name, last_name, email, role, ministry_ids, family_id } =
//     req.body;
//   const targetTable = roleParam === "elder" ? "elders" : "users";
//   const relationTable =
//     roleParam === "elder" ? "elder_ministries" : "user_ministries";

//   const client = await db.connect();
//   try {
//     await client.query("BEGIN");

//     // 👇 FIXED: Now updates family_id
//     const result = await client.query(
//       `UPDATE ${targetTable}
//        SET first_name = $1, last_name = $2, email = $3, role = $4, family_id = $5
//        WHERE id = $6 RETURNING *`,
//       [first_name, last_name, email, role, family_id || null, id]
//     );

//     if (result.rowCount === 0) {
//       await client.query("ROLLBACK");
//       return res.status(404).json({ message: "User not found" });
//     }

//     // Update ministries as before
//     await client.query(
//       `DELETE FROM ${relationTable} WHERE ${roleParam}_id = $1`,
//       [id]
//     );
//     if (Array.isArray(ministry_ids) && ministry_ids.length > 0) {
//       for (const ministryId of ministry_ids) {
//         await client.query(
//           `INSERT INTO ${relationTable} (${roleParam}_id, ministry_id) VALUES ($1, $2)`,
//           [id, ministryId]
//         );
//       }
//     }

//     await client.query("COMMIT");
//     res.json(result.rows[0]);
//   } catch (err) {
//     await client.query("ROLLBACK");
//     console.error("Update user error:", err);
//     res.status(500).json({ message: "Failed to update user" });
//   } finally {
//     client.release();
//   }
// });
// ✅ PUT /api/users/:id — FIXED to update family_id AND avatar!
router.put("/:id", authenticate, async (req, res) => {
  const allowedRoles = ["admin", "super_admin"];
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const rawId = req.params.id;
  const roleParam =
    req.query.role || (rawId.startsWith("elder-") ? "elder" : "user");
  const id = parseInt(rawId.replace(/^[^\d]+/, ""), 10);
  if (isNaN(id)) {
    return res.status(400).json({ message: "Invalid ID format" });
  }

  // 👇 INCLUDE AVATAR HERE
  const {
    first_name,
    last_name,
    email,
    role,
    ministry_ids,
    family_id,
    avatar,
  } = req.body;
  const targetTable = roleParam === "elder" ? "elders" : "users";
  const relationTable =
    roleParam === "elder" ? "elder_ministries" : "user_ministries";

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 👇 AVATAR now included!
    const result = await client.query(
      `UPDATE ${targetTable}
       SET first_name = $1, last_name = $2, email = $3, role = $4, family_id = $5, avatar = $6
       WHERE id = $7 RETURNING *`,
      [
        first_name,
        last_name,
        email,
        role,
        family_id || null,
        avatar || null,
        id,
      ]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    // Update ministries as before
    await client.query(
      `DELETE FROM ${relationTable} WHERE ${roleParam}_id = $1`,
      [id]
    );
    if (Array.isArray(ministry_ids) && ministry_ids.length > 0) {
      for (const ministryId of ministry_ids) {
        await client.query(
          `INSERT INTO ${relationTable} (${roleParam}_id, ministry_id) VALUES ($1, $2)`,
          [id, ministryId]
        );
      }
    }

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update user error:", err);
    res.status(500).json({ message: "Failed to update user" });
  } finally {
    client.release();
  }
});

// PATCH /api/users/:id/active
router.patch("/:id/active", async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  await db.query("UPDATE users SET active=$1 WHERE id=$2", [active, id]);
  res.json({ success: true });
});

// ✅ DELETE /api/users/:id
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

// ✅ POST /api/users — create a new user or elder
router.post("/", authenticate, async (req, res) => {
  const { first_name, last_name, email, phone, role, avatar, family_id } =
    req.body;
  const isElder = role?.toLowerCase() === "elder";

  try {
    const result = await db.query(
      `INSERT INTO ${
        isElder ? "elders" : "users"
      } (first_name, last_name, email, phone, role, avatar, family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        first_name,
        last_name,
        email,
        phone,
        role.toLowerCase(),
        avatar || null,
        family_id || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating user:", err.message);
    res.status(500).json({ message: "Failed to create user" });
  }
});

module.exports = router;

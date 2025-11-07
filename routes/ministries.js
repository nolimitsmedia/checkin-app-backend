// server-api/routes/ministries.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// helpers
function canManage(user) {
  return ["admin", "super_admin"].includes((user?.role || "").toLowerCase());
}
const rowShape = (r) => ({
  id: r.id,
  name: r.name,
  active:
    r.active === true ||
    r.active === "true" ||
    r.is_active === true ||
    r.is_active === "true" ||
    r.active === 1 ||
    r.is_active === 1,
});

/* =========================
   GET /api/ministries
   Lists all ministries
   ========================= */
router.get("/", authenticate, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, COALESCE(is_active, true) AS active
       FROM ministries
       ORDER BY name ASC`
    );
    res.json(rows.map(rowShape));
  } catch (err) {
    console.error("Error fetching ministries:", err);
    res.status(500).json({ message: "Failed to fetch ministries" });
  }
});

/* =========================
   POST /api/ministries
   Create a new ministry
   body: { name, active }
   ========================= */
router.post("/", authenticate, async (req, res) => {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const name = (req.body?.name || "").trim();
  const active =
    req.body?.active === true ||
    req.body?.active === "true" ||
    req.body?.active === 1;

  if (!name) {
    return res.status(400).json({ message: "Name is required." });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO ministries (name, is_active)
       VALUES ($1, $2)
       RETURNING id, name, COALESCE(is_active, true) AS active`,
      [name, active]
    );
    res.status(201).json(rowShape(rows[0]));
  } catch (err) {
    console.error("Create ministry error:", err);
    // unique_violation
    if (err.code === "23505") {
      return res.status(409).json({ message: "Ministry name already exists." });
    }
    res.status(500).json({ message: "Failed to create ministry" });
  }
});

/* =========================
   PUT /api/ministries/:id
   Update a ministry
   body: { name, active }
   ========================= */
router.put("/:id", authenticate, async (req, res) => {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const id = parseInt(req.params.id, 10);
  const name = (req.body?.name || "").trim();
  const active =
    req.body?.active === true ||
    req.body?.active === "true" ||
    req.body?.active === 1;

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }
  if (!name) {
    return res.status(400).json({ message: "Name is required." });
  }

  try {
    const { rows, rowCount } = await db.query(
      `UPDATE ministries
       SET name = $1, is_active = $2
       WHERE id = $3
       RETURNING id, name, COALESCE(is_active, true) AS active`,
      [name, active, id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ message: "Ministry not found" });
    }
    res.json(rowShape(rows[0]));
  } catch (err) {
    console.error("Update ministry error:", err);
    if (err.code === "23505") {
      return res.status(409).json({ message: "Ministry name already exists." });
    }
    res.status(500).json({ message: "Failed to update ministry" });
  }
});

/* =========================
   DELETE /api/ministries/:id
   ========================= */
router.delete("/:id", authenticate, async (req, res) => {
  if (!canManage(req.user)) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }

  try {
    const result = await db.query("DELETE FROM ministries WHERE id = $1", [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Ministry not found" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete ministry error:", err);
    // foreign_key_violation
    if (err.code === "23503") {
      return res.status(409).json({
        message:
          "Cannot delete: this ministry is referenced by users/elders. Remove links first.",
      });
    }
    res.status(500).json({ message: "Failed to delete ministry" });
  }
});

module.exports = router;

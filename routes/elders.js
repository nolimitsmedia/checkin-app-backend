const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// ✅ GET /api/elders
router.get("/", authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, first_name, last_name, email, phone, alt_phone, role
      FROM elders
      ORDER BY first_name, last_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching elders:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ POST /api/elders — create new elder
router.post("/", authenticate, async (req, res) => {
  const { first_name, last_name, email, phone, alt_phone, role } = req.body;

  if (role !== "elder") {
    return res.status(400).json({ message: "Role must be 'elder'" });
  }

  try {
    const result = await db.query(
      `INSERT INTO elders (first_name, last_name, email, phone, alt_phone, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        first_name,
        last_name,
        email || null,
        phone || null,
        alt_phone || null,
        role,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating elder:", err.message);
    res.status(500).json({ message: "Failed to create elder" });
  }
});

// ✅ GET /api/elders/:id/details
router.get("/:id/details", authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

  try {
    const userResult = await db.query(`SELECT * FROM elders WHERE id = $1`, [
      id,
    ]);
    const user = userResult.rows[0];

    if (!user) return res.status(404).json({ error: "Elder not found" });

    const ministriesResult = await db.query(
      `SELECT m.name FROM ministries m
       JOIN elder_ministries em ON em.ministry_id = m.id
       WHERE em.elder_id = $1`,
      [id]
    );

    res.json({
      user,
      ministries: ministriesResult.rows.map((row) => row.name),
    });
  } catch (err) {
    console.error("Error fetching elder details:", err);
    res.status(500).send("Server error");
  }
});

// PATCH /api/elders/:id/active
router.patch("/:id/active", async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  await db.query("UPDATE elders SET active=$1 WHERE id=$2", [active, id]);
  res.json({ success: true });
});

// ✅ DELETE /api/elders/:id
router.delete("/:id", authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

  try {
    await db.query("DELETE FROM elder_ministries WHERE elder_id = $1", [id]);
    const result = await db.query("DELETE FROM elders WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Elder not found" });
    }

    res.json({ message: "Elder deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ message: "Failed to delete elder" });
  }
});

module.exports = router;

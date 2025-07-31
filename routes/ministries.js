const express = require("express");
const router = express.Router();
const db = require("../db");

// GET /api/ministries - List all ministries
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, name FROM ministries ORDER BY name"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching ministries:", err);
    res.status(500).json({ error: "Failed to fetch ministries" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const db = require("../db");

// Search by family or full name for check-in autocomplete
router.get("/", async (req, res) => {
  const { name, family_id } = req.query;

  try {
    if (family_id) {
      // Find ALL users and elders in the family, INCLUDING AVATAR
      const familyMembers = await db.query(
        `
        SELECT id, first_name, last_name, phone, role, avatar FROM users WHERE family_id = $1
        UNION
        SELECT id, first_name, last_name, phone, 'elder' AS role, avatar FROM elders WHERE family_id = $1
        `,
        [family_id]
      );
      return res.json(familyMembers.rows);
    }

    if (name) {
      // Find matching user/elder by full name, INCLUDING AVATAR
      const nameTerm = `%${name.trim().toLowerCase()}%`;
      const individualMatch = await db.query(
        `
        SELECT id, first_name, last_name, phone, 'user' AS role, avatar
        FROM users
        WHERE LOWER(TRIM(first_name)) || ' ' || LOWER(TRIM(last_name)) ILIKE $1
        UNION
        SELECT id, first_name, last_name, phone, 'elder' AS role, avatar
        FROM elders
        WHERE LOWER(TRIM(first_name)) || ' ' || LOWER(TRIM(last_name)) ILIKE $1
        `,
        [nameTerm]
      );
      return res.json(individualMatch.rows);
    }

    // If neither param provided
    res.status(400).json({ message: "Missing search parameters." });
  } catch (err) {
    console.error("❌ Family search error:", err.message);
    res.status(500).json({ message: "Search failed" });
  }
});

module.exports = router;

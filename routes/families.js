// server-api/routes/families.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// Get all families
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, family_name FROM families ORDER BY family_name"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching families:", err);
    res.status(500).json({ message: "Error fetching families" });
  }
});

// Add new family
router.post("/", async (req, res) => {
  const { family_name } = req.body;
  if (!family_name)
    return res.status(400).json({ message: "Family name required" });

  try {
    const result = await db.query(
      "INSERT INTO families (family_name) VALUES ($1) RETURNING id, family_name",
      [family_name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error adding family:", err);
    res.status(500).json({ message: "Error adding family" });
  }
});

// Get all members for a family
router.get("/:id/members", async (req, res) => {
  const familyId = req.params.id;
  try {
    const users = await db.query(
      "SELECT id, first_name, last_name, role FROM users WHERE family_id = $1",
      [familyId]
    );
    // Optionally, include elders if you wish:
    // const elders = await db.query(
    //   "SELECT id, first_name, last_name, role FROM elders WHERE family_id = $1",
    //   [familyId]
    // );
    // res.json([...users.rows, ...elders.rows]);

    res.json(users.rows);
  } catch (err) {
    console.error("Error fetching family members:", err);
    res.status(500).json({ message: "Error fetching members" });
  }
});

module.exports = router;

const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// ✅ POST /api/admins — create a new admin
router.post("/", authenticate, async (req, res) => {
  const { first_name, last_name, email, phone, username, password } = req.body;

  // 🧾 Validate required fields
  if (!first_name || !last_name || !username || !password) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    // 🔍 Check if username already exists
    const existing = await db.query(
      `SELECT id FROM admins WHERE username = $1`,
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "Username already exists" });
    }

    // 🔐 Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 🧠 Insert into admins table with role = 'admin'
    const result = await db.query(
      `INSERT INTO admins (first_name, last_name, email, phone, username, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, first_name, last_name, email, phone, username, role`,
      [first_name, last_name, email, phone, username, hashedPassword, "admin"]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Error creating admin:", err);
    res.status(500).json({ message: "Failed to create admin" });
  }
});

module.exports = router;

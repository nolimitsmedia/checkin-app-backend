const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { username = "", password = "" } = req.body;

  try {
    const normalizedUsername = username.trim().toLowerCase();

    const result = await db.query(
      "SELECT * FROM admins WHERE LOWER(username) = $1",
      [normalizedUsername]
    );
    const admin = result.rows[0];

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // 🛠 Fix: Compare with 'password_hash' not 'password'
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        id: admin.id,
        email: admin.username,
        role: admin.role || "staff",
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        name: `${admin.first_name} ${admin.last_name}`,
        role: admin.role,
        email: admin.username,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Server error during login" });
  }
});

module.exports = router;

const jwt = require("jsonwebtoken");
const db = require("../db");

module.exports = async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing or invalid token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Try to find in admins table first
    let result = await db.query("SELECT * FROM admins WHERE id = $1", [
      decoded.id,
    ]);

    if (result.rows.length > 0) {
      req.user = {
        id: result.rows[0].id,
        role: result.rows[0].role,
        email: result.rows[0].email,
      };
      return next();
    }

    // Try users table if not found in admins
    result = await db.query("SELECT * FROM users WHERE id = $1", [decoded.id]);
    if (result.rows.length > 0) {
      req.user = {
        id: result.rows[0].id,
        role: result.rows[0].role || "member", // fallback
        email: result.rows[0].email,
      };
      return next();
    }

    return res.status(401).json({ message: "User not found" });
  } catch (err) {
    console.error("Authentication error:", err);
    res.status(401).json({ message: "Invalid token" });
  }
};

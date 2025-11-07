// server-api/middleware/kioskAuth.js
const jwt = require("jsonwebtoken");

module.exports = function kioskAuth(req, res, next) {
  // Allow OPTIONS preflight
  if (req.method === "OPTIONS") return next();

  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing kiosk token" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload?.role !== "kiosk") {
      return res.status(403).json({ message: "Not a kiosk token" });
    }
    req.kiosk = payload; // { sub: 'kiosk:<id>' | 'kiosk:anon', role:'kiosk' }
    next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid kiosk token" });
  }
};

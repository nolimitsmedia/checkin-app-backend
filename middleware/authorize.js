// server-api/middleware/authorize.js
module.exports = function authorize(...allowed) {
  const allow = new Set(allowed.map((r) => String(r).toLowerCase()));
  return (req, res, next) => {
    const role = String(req?.user?.role || "").toLowerCase();
    if (!role) return res.status(401).json({ message: "Unauthenticated" });
    if (!allow.size || allow.has(role)) return next();
    return res.status(403).json({ message: "Forbidden for role: " + role });
  };
};

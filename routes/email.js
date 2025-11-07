// server-api/routes/email.js
const express = require("express");
const router = express.Router();
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");

// This is a stub. Wire to Microsoft Graph or Nodemailer later.
router.post(
  "/send-reports",
  authenticate,
  authorize("super_admin", "admin"),
  async (req, res) => {
    const { event_id, ministries, template_id, attach } = req.body || {};
    if (!event_id)
      return res.status(400).json({ message: "event_id required" });

    // TODO:
    // 1) Generate files (reuse logic from /reports/generate-all)
    // 2) Send via Graph API or SMTP
    // For now, just acknowledge.
    return res.json({
      ok: true,
      queued: true,
      event_id,
      ministries,
      template_id,
      attach,
    });
  }
);

module.exports = router;

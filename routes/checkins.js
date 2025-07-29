const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// POST /checkins
router.post("/", authenticate, async (req, res) => {
  let { user_id, elder_id, event_id } = req.body;

  console.log("[Check-In POST]", { user_id, elder_id, event_id });

  try {
    // Ensure numeric values
    event_id = parseInt(event_id);
    if (user_id) user_id = parseInt(user_id);
    if (elder_id) elder_id = parseInt(elder_id);

    if (!event_id || (!user_id && !elder_id)) {
      console.log("⚠️ Invalid input:", req.body);
      return res
        .status(400)
        .json({ message: "Missing or invalid required fields" });
    }

    const isElder = Boolean(elder_id);
    const resolvedUserId = isElder ? null : user_id;
    const resolvedElderId = isElder ? elder_id : null;
    // Validate ID existence
    const validationQuery = isElder
      ? `SELECT id FROM elders WHERE id = $1`
      : `SELECT id FROM users WHERE id = $1`;
    const validationId = isElder ? elder_id : user_id;

    const validationResult = await db.query(validationQuery, [validationId]);
    if (validationResult.rows.length === 0) {
      return res.status(400).json({ message: "Invalid user or elder ID." });
    }

    // Check for duplicate check-in
    const duplicateCheckQuery = isElder
      ? `SELECT id FROM check_ins WHERE elder_id = $1 AND event_id = $2`
      : `SELECT id FROM check_ins WHERE user_id = $1 AND event_id = $2`;
    const duplicateCheckValues = isElder
      ? [elder_id, event_id]
      : [user_id, event_id];

    const duplicateCheckResult = await db.query(
      duplicateCheckQuery,
      duplicateCheckValues
    );

    if (duplicateCheckResult.rows.length > 0) {
      return res.status(409).json({
        message: "Already checked in for this event.",
        duplicate: true,
        user_id,
        elder_id,
      });
    }

    // Insert check-in record
    const insertResult = await db.query(
      `
      INSERT INTO check_ins (user_id, elder_id, event_id, checkin_time, is_elder)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
      RETURNING *
      `,
      [resolvedUserId, resolvedElderId, event_id, isElder]
    );

    return res.status(201).json({
      message: "Checked in successfully",
      checkin: insertResult.rows[0],
    });
  } catch (err) {
    console.error("❌ Check-in error:", err.message, err.stack);
    return res
      .status(500)
      .json({ message: "Failed to check-in", error: err.message });
  }
});

// DELETE /checkins/:id
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM check_ins WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Check-in not found" });
    }
    res.json({ message: "Check-in deleted successfully" });
  } catch (err) {
    console.error("Delete check-in error:", err.message);
    res.status(500).json({ message: "Failed to delete check-in" });
  }
});

// GET /checkins/event/:event_id — Return all checked-in users/elders for an event
// router.get("/event/:event_id", authenticate, async (req, res) => {
//   const { event_id } = req.params;
//   try {
//     const result = await db.query(
//       `SELECT id, user_id, elder_id, event_id FROM check_ins WHERE event_id = $1`,
//       [event_id]
//     );
//     res.json(result.rows);
//   } catch (err) {
//     console.error("❌ Error fetching check-ins for event:", err);
//     res.status(500).json({ message: "Failed to fetch check-ins for event." });
//   }
// });

// GET /checkins/event/:event_id/detailed
router.get("/event/:event_id/detailed", authenticate, async (req, res) => {
  const { event_id } = req.params;
  try {
    const result = await db.query(
      `
      SELECT 
        c.id as checkin_id,
        c.checkin_time,
        c.user_id, u.first_name as user_first_name, u.last_name as user_last_name, u.avatar as user_avatar, u.role as user_role,
        c.elder_id, e.first_name as elder_first_name, e.last_name as elder_last_name, e.avatar as elder_avatar, e.role as elder_role,
        ev.title as event_title,
        ev.location as event_location,
        ev.event_time as event_time
      FROM check_ins c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN elders e ON c.elder_id = e.id
      LEFT JOIN events ev ON c.event_id = ev.id
      WHERE c.event_id = $1
      `,
      [event_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching event check-ins:", err);
    res.status(500).json({ message: "Failed to fetch event check-ins." });
  }
});

// GET /checkins/all — All check-ins, with user/elder and event info
router.get("/all", authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        c.id, c.checkin_time, 
        COALESCE(u.first_name, e.first_name) as first_name,
        COALESCE(u.last_name, e.last_name) as last_name,
        COALESCE(u.avatar, e.avatar) as avatar,
        COALESCE(u.role, e.role) as role,
        ev.title as event_title,
        -- Add more fields if needed
        c.user_id, c.elder_id, c.event_id
      FROM check_ins c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN elders e ON c.elder_id = e.id
      LEFT JOIN events ev ON c.event_id = ev.id
      ORDER BY c.checkin_time DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching check-ins:", err);
    res.status(500).json({ message: "Failed to fetch check-ins." });
  }
});

// server-api/routes/checkins.js

router.post("/bulk-checkout", async (req, res) => {
  const { ids } = req.body; // expects: { ids: [1,2,3] }
  if (!Array.isArray(ids)) {
    return res.status(400).json({ message: "Invalid ids array." });
  }
  try {
    await db.query(`DELETE FROM check_ins WHERE id = ANY($1::int[])`, [ids]);
    res.json({ success: true, message: "Bulk check-out complete." });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Bulk check-out failed.", error: err.message });
  }
});

module.exports = router;

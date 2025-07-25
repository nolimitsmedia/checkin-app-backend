const express = require("express");
const router = express.Router();
const db = require("../db");

// ✅ A. Full Attendee Report (users + elders)
router.get("/attendees", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.id AS id,
        u.first_name, 
        u.last_name, 
         u.email,
        u.phone, 
        e.title AS event_title, 
        e.event_date,
        'user' AS type
      FROM check_ins ci
      JOIN users u ON ci.user_id = u.id
      JOIN events e ON ci.event_id = e.id

      UNION ALL

      SELECT 
        e2.id AS id,
        e2.first_name, 
        e2.last_name, 
        e2.email,
        e2.phone, 
        ev.title AS event_title, 
        ev.event_date,
        'elder' AS type
      FROM check_ins ci
      JOIN elders e2 ON ci.elder_id = e2.id
      JOIN events ev ON ci.event_id = ev.id

      ORDER BY event_date DESC, last_name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching attendees:", err);
    res.status(500).json({ error: "Failed to fetch attendees" });
  }
});

// ✅ B. Ministry Absent Report (for an event: users in each ministry who did NOT check in)
router.get("/ministry-absent/:event_id", async (req, res) => {
  const { event_id } = req.params;
  try {
    const result = await db.query(
      `
      SELECT
        u.id AS user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone
        
      FROM ministries m
      JOIN user_ministries um ON m.id = um.ministry_id
      JOIN users u ON um.user_id = u.id
      WHERE u.id NOT IN (
        SELECT user_id FROM check_ins 
        WHERE event_id = $1 AND user_id IS NOT NULL
      )
      ORDER BY m.name, u.last_name
    `,
      [event_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching ministry absent report:", err);
    res.status(500).json({ error: "Failed to fetch ministry absent report" });
  }
});

// ✅ C. Elder Report (all users checked in for ministries managed by selected elder)
router.get("/elder/:elder_id", async (req, res) => {
  const { elder_id } = req.params;
  try {
    const result = await db.query(
      `
      SELECT 
        u.first_name,
        u.last_name,
        u.email,
        e.title AS event_title,
        e.event_date,
        m.name AS ministry_name
      FROM check_ins ci
      JOIN users u ON ci.user_id = u.id
      JOIN user_ministries um ON um.user_id = u.id
      JOIN ministries m ON m.id = um.ministry_id
      JOIN elder_ministries em ON em.ministry_id = m.id
      JOIN events e ON e.id = ci.event_id
      WHERE em.elder_id = $1
      ORDER BY e.event_date DESC, u.last_name
    `,
      [elder_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching elder report:", err);
    res.status(500).json({ error: "Failed to fetch elder report" });
  }
});

// ✅ D. Elder Absent Report (users under the elder's ministries NOT checked in for the event)
router.get("/elder-absent/:elder_id/:event_id", async (req, res) => {
  const { elder_id, event_id } = req.params;
  try {
    const result = await db.query(
      `
      SELECT 
        u.first_name,
        u.last_name,
        u.email,
        m.name AS ministry_name
      FROM users u
      JOIN user_ministries um ON um.user_id = u.id
      JOIN ministries m ON m.id = um.ministry_id
      JOIN elder_ministries em ON em.ministry_id = m.id
      WHERE em.elder_id = $1
        AND u.id NOT IN (
          SELECT user_id FROM check_ins WHERE event_id = $2
        )
      ORDER BY m.name, u.last_name
    `,
      [elder_id, event_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching elder absent report:", err);
    res.status(500).json({ error: "Failed to fetch elder absent report" });
  }
});

module.exports = router;

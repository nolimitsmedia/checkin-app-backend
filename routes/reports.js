const express = require("express");
const router = express.Router();
const db = require("../db");

// A. Full Attendee Report (users + elders)
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

// Ministries List for Dropdown
router.get("/ministries", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name
      FROM ministries
      WHERE is_active = true
      ORDER BY name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching ministries:", err);
    res.status(500).json({ message: "Failed to fetch ministries" });
  }
});

// Ministry Attendance Report (for any ministry, like Overseers/Staff)
router.get("/ministry-attendance/:ministry_id", async (req, res) => {
  const ministry_id = parseInt(req.params.ministry_id, 10);
  const event_id = req.query.event_id ? parseInt(req.query.event_id, 10) : null;

  let query = `
    SELECT 
      ci.id AS checkin_id,
      u.id AS user_id,
      u.first_name,
      u.last_name,
      u.email,
      u.role,
      e.title AS event_title,
      e.event_date,
      ci.checkin_time
    FROM check_ins ci
    JOIN users u ON ci.user_id = u.id
    JOIN user_ministries um ON um.user_id = u.id
    JOIN events e ON ci.event_id = e.id
    WHERE um.ministry_id = $1
  `;
  let params = [ministry_id];
  if (event_id) {
    query += " AND ci.event_id = $2";
    params.push(event_id);
  }

  try {
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching ministry attendance:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Ministry Absent Report (users in each ministry who did NOT check in for the event)
router.get("/ministry-absent/:event_id/:ministry_id?", async (req, res) => {
  const { event_id, ministry_id } = req.params;

  try {
    let query = `
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
    `;
    const params = [event_id];

    if (ministry_id) {
      query += " AND m.id = $2";
      params.push(parseInt(ministry_id, 10));
    }

    query += " ORDER BY m.name, u.last_name";

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching ministry absent report:", err);
    res.status(500).json({ error: "Failed to fetch ministry absent report" });
  }
});

// Elder Report (all users checked in for ministries managed by selected elder)
// Added optional event filter (via query param ?event_id=)
router.get("/elder/:elder_id", async (req, res) => {
  const { elder_id } = req.params;
  const event_id = req.query.event_id ? parseInt(req.query.event_id, 10) : null;

  let query = `
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
  `;

  const params = [elder_id];

  if (event_id) {
    query += " AND ci.event_id = $2";
    params.push(event_id);
  }

  query += " ORDER BY e.event_date DESC, u.last_name";

  try {
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching elder report:", err);
    res.status(500).json({ error: "Failed to fetch elder report" });
  }
});

// Elder Absent Report (users under the elder's ministries NOT checked in for the event)
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

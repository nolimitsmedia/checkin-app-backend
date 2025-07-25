const express = require("express");
const router = express.Router();
const db = require("../db");

// GET /api/dashboard
router.get("/", async (req, res) => {
  try {
    const [
      checkInsToday,
      totalUsers,
      totalElders, // <-- NEW
      totalMinistries,
      upcomingEvents,
      upcomingEventDetails,
      allCheckins,
    ] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM "check_ins" WHERE DATE(checkin_time) = CURRENT_DATE`
      ),
      db.query(`SELECT COUNT(*) FROM users`),
      db.query(`SELECT COUNT(*) FROM elders`), // <-- NEW
      db.query(`SELECT COUNT(*) FROM ministries`),
      db.query(`SELECT COUNT(*) FROM events WHERE event_date >= CURRENT_DATE`),
      db.query(`
        SELECT id, title, event_date, event_time, location
FROM events
WHERE 
  (event_date + event_time::interval) >= NOW() - INTERVAL '1 hours'
ORDER BY event_date, event_time
LIMIT 7
      `),
      db.query(`
         SELECT
    c.id,
    c.checkin_time,
    COALESCE(u.first_name, e.first_name) AS first_name,
    COALESCE(u.last_name, e.last_name) AS last_name,
    COALESCE(m1.name, m2.name) AS ministry,
    CASE
      WHEN c.user_id IS NOT NULL THEN 'User'
      WHEN c.elder_id IS NOT NULL THEN 'Elder'
      ELSE 'Unknown'
    END AS type,
    c.event_id,
    ev.title AS event_title
  FROM check_ins c
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN elders e ON e.id = c.elder_id
  LEFT JOIN user_ministries um ON um.user_id = u.id
  LEFT JOIN elder_ministries em ON em.elder_id = e.id
  LEFT JOIN ministries m1 ON m1.id = um.ministry_id
  LEFT JOIN ministries m2 ON m2.id = em.ministry_id
  LEFT JOIN events ev ON ev.id = c.event_id
  ORDER BY c.checkin_time DESC
      `),
    ]);

    res.json({
      stats: {
        checkInsToday: parseInt(checkInsToday.rows[0].count),
        totalUsers: parseInt(totalUsers.rows[0].count),
        totalElders: parseInt(totalElders.rows[0].count), // NEW
        activeMinistries: parseInt(totalMinistries.rows[0].count),
        upcomingEvents: parseInt(upcomingEvents.rows[0].count),
      },
      upcomingEvents: upcomingEventDetails.rows,
      allCheckins: allCheckins.rows,
    });
  } catch (err) {
    console.error("Dashboard fetch error:", err);
    res.status(500).json({ message: "Failed to fetch dashboard data" });
  }
});

module.exports = router;

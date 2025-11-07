// server-api/routes/reports.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// Mass export deps (ZIP + CSV)
const archiver = require("archiver");
const { Parser } = require("json2csv");

/* -------------------------------------------------------------------------- */
/* A. Full Attendee Report (users + elders)                                    */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* Ministries List for Dropdown                                                */
/* -------------------------------------------------------------------------- */
router.get("/ministries", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name
      FROM ministries
      WHERE COALESCE(is_active, true) = true
      ORDER BY name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching ministries:", err);
    res.status(500).json({ message: "Failed to fetch ministries" });
  }
});

/* -------------------------------------------------------------------------- */
/* Ministry Attendance (optionally by event)                                   */
/* -------------------------------------------------------------------------- */
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
  const params = [ministry_id];
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

/* -------------------------------------------------------------------------- */
/* Ministry Absent Report (optionally filtered by ministry)                    */
/* -------------------------------------------------------------------------- */
router.get("/ministry-absent/:event_id", async (req, res) => {
  const event_id = parseInt(req.params.event_id, 10);
  const ministry_id = req.query.ministry_id
    ? parseInt(req.query.ministry_id, 10)
    : null;

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
      params.push(ministry_id);
    }

    query += " ORDER BY m.name, u.last_name";

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching ministry absent report:", err);
    res.status(500).json({ error: "Failed to fetch ministry absent report" });
  }
});

/* -------------------------------------------------------------------------- */
/* Elder Report (optionally by event)                                          */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* Elder Absent Report                                                         */
/* -------------------------------------------------------------------------- */
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
      [elder_id, parseInt(event_id, 10)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching elder absent report:", err);
    res.status(500).json({ error: "Failed to fetch elder absent report" });
  }
});

/* -------------------------------------------------------------------------- */
/* Roster Report                                                               */
/* -------------------------------------------------------------------------- */
router.get("/roster/:ministry_id", async (req, res) => {
  const { ministry_id } = req.params;

  try {
    const usersQuery = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone, m.name AS ministry
      FROM users u
      JOIN user_ministries um ON um.user_id = u.id
      JOIN ministries m ON m.id = um.ministry_id
      WHERE m.id = $1
      ORDER BY u.last_name ASC
    `;
    const users = await db.query(usersQuery, [parseInt(ministry_id, 10)]);
    res.json(users.rows);
  } catch (err) {
    console.error("Roster report error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/* NEW: Users without any active ministry (optional ?active=true)              */
/* -------------------------------------------------------------------------- */
router.get("/users-without-ministry", async (req, res) => {
  const onlyActive = String(req.query.active || "true") === "true";
  try {
    const q = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone, COALESCE(u.active, true) AS active
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM user_ministries um
        JOIN ministries m ON m.id = um.ministry_id AND COALESCE(m.is_active, true) = true
        WHERE um.user_id = u.id
      )
      ${onlyActive ? "AND COALESCE(u.active, true) = true" : ""}
      ORDER BY LOWER(u.last_name), LOWER(u.first_name)
    `;
    const { rows } = await db.query(q);
    res.json(rows);
  } catch (e) {
    console.error("users-without-ministry error:", e);
    res.status(500).json({ message: "Failed to fetch users without ministry" });
  }
});

/* -------------------------------------------------------------------------- */
/* NEW: Mass report generation for ALL ministries (ZIP of CSVs)                */
/* Body: { event_id?: number, formats?: ["csv"] }                              */
/* -------------------------------------------------------------------------- */
router.post("/generate-all", async (req, res) => {
  const event_id = req.body?.event_id ? parseInt(req.body.event_id, 10) : null;

  // stream a zip response
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="all-ministries-reports.zip"`
  );

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("archiver error:", err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  try {
    // Active ministries
    const { rows: mins } = await db.query(
      `SELECT id, name FROM ministries WHERE COALESCE(is_active, true) = true ORDER BY name`
    );

    // helper: run a query and add as CSV entry
    const addCsv = async (filename, sql, params) => {
      const { rows } = await db.query(sql, params);
      const parser = new Parser();
      const csv = parser.parse(rows);
      archive.append(csv, { name: filename });
    };

    for (const m of mins) {
      const safeName = m.name.replace(/[^\w]+/g, "_") || `ministry_${m.id}`;

      // Attendance CSV
      await addCsv(
        `attendance_${safeName}.csv`,
        `
          SELECT 
            u.first_name, u.last_name, u.email, u.phone,
            e.title AS event_title, e.event_date, ci.checkin_time
          FROM check_ins ci
          JOIN users u ON u.id = ci.user_id
          JOIN user_ministries um ON um.user_id = u.id
          JOIN events e ON e.id = ci.event_id
          WHERE um.ministry_id = $1
          ${event_id ? "AND ci.event_id = $2" : ""}
          ORDER BY e.event_date DESC, u.last_name, u.first_name
        `,
        event_id ? [m.id, event_id] : [m.id]
      );

      // Absent CSV
      await addCsv(
        `absent_${safeName}.csv`,
        `
          SELECT u.first_name, u.last_name, u.email, u.phone
          FROM users u
          JOIN user_ministries um ON um.user_id = u.id
          WHERE um.ministry_id = $1
            AND u.id NOT IN (
              SELECT user_id FROM check_ins WHERE ${
                event_id ? "event_id = $2" : "event_id IS NOT NULL"
              }
            )
          ORDER BY u.last_name, u.first_name
        `,
        event_id ? [m.id, event_id] : [m.id]
      );
    }

    await archive.finalize();
  } catch (e) {
    console.error("generate-all error:", e);
    if (!res.headersSent)
      res.status(500).json({ message: "Failed to build ZIP" });
    try {
      archive.abort();
    } catch {}
  }
});

/* -------------------------------------------------------------------------- */
/* New: Members without any ACTIVE ministry (UI uses /reports/no-active-ministry) */
/* ?active_only=true to restrict to currently active users                     */
/* Sorted case-insensitively A→Z by last_name, first_name                      */
/* -------------------------------------------------------------------------- */
router.get("/no-active-ministry", async (req, res) => {
  try {
    const activeOnly =
      String(req.query.active_only || "").toLowerCase() === "true";

    const whereParts = [];
    const params = [];

    if (activeOnly) {
      params.push(true);
      whereParts.push(`u.active = $${params.length}`);
    }

    const whereSQL = whereParts.length
      ? `WHERE ${whereParts.join(" AND ")}`
      : "";

    const sql = `
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.active
      FROM users u
      LEFT JOIN user_ministries um ON um.user_id = u.id
      LEFT JOIN ministries m       ON m.id = um.ministry_id
      ${whereSQL}
      GROUP BY u.id
      HAVING COALESCE(BOOL_OR(m.is_active), false) = false
      ORDER BY LOWER(u.last_name), LOWER(u.first_name)
    `;

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("no-active-ministry report error:", err);
    res.status(500).json({ message: "Failed to fetch report." });
  }
});

router.get("/inactive-members", async (req, res) => {
  try {
    const sql = `
      SELECT
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        COALESCE(u.active, false) AS active,
        COALESCE(
          STRING_AGG(DISTINCT m.name, ', ' ORDER BY m.name),
          ''
        ) AS ministries
      FROM users u
      LEFT JOIN user_ministries um
        ON um.user_id = u.id
      LEFT JOIN ministries m
        ON m.id = um.ministry_id
       AND COALESCE(m.is_active, true) = true
      WHERE COALESCE(u.active, false) = false
      GROUP BY u.id
      ORDER BY u.last_name, u.first_name
    `;
    const { rows } = await db.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("inactive-members report error:", err);
    res.status(500).json({ message: "Failed to fetch inactive members" });
  }
});

module.exports = router;

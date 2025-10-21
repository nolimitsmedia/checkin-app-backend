// server-api/routes/events.js updated
const express = require("express");
const router = express.Router();
const pool = require("../db");

/* -------------------------------------------------------------------------- */
/* Helpers: keep date-only and time-only as strings end-to-end                */
/* -------------------------------------------------------------------------- */
function normalizeDateOnly(val) {
  if (!val) return null;
  return String(val).slice(0, 10); // "YYYY-MM-DD"
}
function normalizeTime(val) {
  if (!val) return null;
  const s = String(val);
  const m = s.match(/^(\d{2}:\d{2})/); // keep HH:MM (drop seconds if present)
  return m ? m[1] : s;
}

/* -------------------------------------------------------------------------- */
/* GET /api/events/upcoming                                                   */
/* Compare wall-clock values without timezone by using TIMESTAMP (no TZ).     */
/* event_ts := event_date::timestamp + event_time                             */
/* now_local := now()::timestamp (drops timezone)                             */
/* -------------------------------------------------------------------------- */
router.get("/upcoming", async (_req, res) => {
  try {
    const q = `
      SELECT
        id,
        title,
        to_char(event_date, 'YYYY-MM-DD') AS event_date,
        to_char(event_time, 'HH24:MI')    AS event_time,
        location,
        description
      FROM events
      WHERE (event_date::timestamp + event_time) >= (now()::timestamp - INTERVAL '1 hour')
      ORDER BY event_date, event_time NULLS LAST;
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching upcoming events:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/events                                                            */
/* Return strings for date/time to avoid client TZ conversions                */
/* -------------------------------------------------------------------------- */
router.get("/", async (_req, res) => {
  try {
    const q = `
      SELECT
        id,
        title,
        to_char(event_date, 'YYYY-MM-DD') AS event_date,
        to_char(event_time, 'HH24:MI')    AS event_time,
        location,
        description
      FROM events
      ORDER BY event_date DESC, event_time DESC NULLS LAST;
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/events failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /api/events                                                           */
/* Force DATE/TIME types and return normalized strings                        */
/* -------------------------------------------------------------------------- */
router.post("/", async (req, res) => {
  try {
    const title = (req.body.title || "").trim();
    const event_date = normalizeDateOnly(req.body.event_date);
    const event_time = normalizeTime(req.body.event_time);
    const location = req.body.location ?? null;
    const description = req.body.description ?? null;

    if (!title || !event_date) {
      return res
        .status(400)
        .json({ message: "title and event_date are required" });
    }

    const q = `
      INSERT INTO events (title, event_date, event_time, location, description)
      VALUES ($1, $2::date, $3::time, $4, $5)
      RETURNING
        id,
        title,
        to_char(event_date, 'YYYY-MM-DD') AS event_date,
        to_char(event_time, 'HH24:MI')    AS event_time,
        location,
        description;
    `;
    const { rows } = await pool.query(q, [
      title,
      event_date,
      event_time,
      location,
      description,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error creating event:", err);
    res.status(500).json({ error: "Failed to create event" });
  }
});

/* -------------------------------------------------------------------------- */
/* PUT /api/events/:id                                                        */
/* Force DATE/TIME types and return normalized strings                        */
/* -------------------------------------------------------------------------- */
router.put("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const title = (req.body.title || "").trim();
    const event_date = normalizeDateOnly(req.body.event_date);
    const event_time = normalizeTime(req.body.event_time);
    const location = req.body.location ?? null;
    const description = req.body.description ?? null;

    if (!title || !event_date) {
      return res
        .status(400)
        .json({ message: "title and event_date are required" });
    }

    const q = `
      UPDATE events
      SET title=$1,
          event_date=$2::date,
          event_time=$3::time,
          location=$4,
          description=$5
      WHERE id=$6
      RETURNING
        id,
        title,
        to_char(event_date, 'YYYY-MM-DD') AS event_date,
        to_char(event_time, 'HH24:MI')    AS event_time,
        location,
        description;
    `;
    const { rows } = await pool.query(q, [
      title,
      event_date,
      event_time,
      location,
      description,
      id,
    ]);

    if (!rows[0]) return res.status(404).json({ message: "Event not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error updating event:", err);
    res.status(500).json({ message: "Failed to update event" });
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /api/events/:id                                                     */
/* -------------------------------------------------------------------------- */
router.delete("/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM events WHERE id = $1", [
      req.params.id,
    ]);
    if (!rowCount) return res.status(404).json({ message: "Event not found" });
    res.json({ message: "Event deleted successfully" });
  } catch (err) {
    console.error("Delete event error:", err);
    res.status(500).json({ message: "Failed to delete event" });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /api/events/:id                                                        */
/* Return strings for date/time                                               */
/* -------------------------------------------------------------------------- */
router.get("/:id", async (req, res) => {
  try {
    const q = `
      SELECT
        id,
        title,
        to_char(event_date, 'YYYY-MM-DD') AS event_date,
        to_char(event_time, 'HH24:MI')    AS event_time,
        location,
        description
      FROM events
      WHERE id = $1
      LIMIT 1;
    `;
    const { rows } = await pool.query(q, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: "Event not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching event:", err);
    res.status(500).json({ message: "Failed to fetch event" });
  }
});

module.exports = router;

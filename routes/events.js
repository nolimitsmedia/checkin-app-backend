const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/events/upcoming
router.get("/upcoming", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, title, event_date, event_time
      FROM events
      WHERE (event_date + event_time::interval) >= NOW() - INTERVAL '1 hour'
      ORDER BY event_date, event_time
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching upcoming events:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// ✅ GET all events
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM events ORDER BY event_date DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ POST new event
router.post("/", async (req, res) => {
  const { title, event_date, event_time, location, description } = req.body;

  try {
    const result = await pool.query(
      `
      INSERT INTO events (title, event_date, event_time, location, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        title,
        event_date,
        event_time || null,
        location || null,
        description || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error creating event:", err);
    res.status(500).json({ error: "Failed to create event" });
  }
});

// ✅ PUT /api/events/:id – Update event
router.put("/:id", async (req, res) => {
  const eventId = req.params.id;
  const { title, event_date, event_time, location, description } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE events
      SET title = $1,
          event_date = $2,
          event_time = $3,
          location = $4,
          description = $5
      WHERE id = $6
      RETURNING *
      `,
      [
        title,
        event_date,
        event_time || null,
        location || null,
        description || null,
        eventId,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating event:", err);
    res.status(500).json({ message: "Failed to update event" });
  }
});

// ✅ DELETE /api/events/:id
router.delete("/:id", async (req, res) => {
  const eventId = req.params.id;

  try {
    const result = await pool.query("DELETE FROM events WHERE id = $1", [
      eventId,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json({ message: "Event deleted successfully" });
  } catch (err) {
    console.error("Delete event error:", err);
    res.status(500).json({ message: "Failed to delete event" });
  }
});

// GET /api/events/:id  (fetch single event)
router.get("/:id", async (req, res) => {
  const eventId = req.params.id;
  try {
    const result = await pool.query("SELECT * FROM events WHERE id = $1", [
      eventId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Event not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching event:", err);
    res.status(500).json({ message: "Failed to fetch event" });
  }
});

module.exports = router;

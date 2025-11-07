// server-api/routes/kiosk.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const kioskAuth = require("../middleware/kioskAuth");

/* --------------------------- SESSION --------------------------- */
router.post("/session/start", async (req, res) => {
  const { kiosk_code } = req.body || {};
  try {
    let kioskId = null;

    if (kiosk_code) {
      const { rows } = await db.query(
        `SELECT id FROM kiosks WHERE code = $1 AND COALESCE(is_active, true) = true LIMIT 1`,
        [kiosk_code]
      );
      if (!rows.length)
        return res.status(401).json({ message: "Invalid kiosk code" });
      kioskId = rows[0].id;
    }

    const payload = {
      sub: kioskId ? `kiosk:${kioskId}` : "kiosk:anon",
      role: "kiosk",
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "12h",
    });

    const events = await db.query(`
      SELECT id, title, event_date, event_time, location
      FROM events
      WHERE (event_date + COALESCE(event_time::interval, '00:00')) >= NOW() - INTERVAL '12 hours'
      ORDER BY event_date ASC, event_time ASC NULLS FIRST
      LIMIT 200
    `);

    res.json({
      token,
      kiosk: kioskId ? { id: kioskId } : { id: null, anonymous: true },
      events: events.rows,
    });
  } catch (e) {
    console.error("kiosk session start error:", e);
    res.status(500).json({ message: "Failed to start kiosk session" });
  }
});

/* ------------------------------ EVENTS ------------------------------ */
router.get("/events", kioskAuth, async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, title, event_date, event_time, location
      FROM events
      WHERE (event_date + COALESCE(event_time::interval, '00:00')) >= NOW() - INTERVAL '12 hours'
      ORDER BY event_date ASC, event_time ASC NULLS FIRST
      LIMIT 200
    `);
    res.json(rows);
  } catch (e) {
    console.error("kiosk events error:", e);
    res.status(500).json({ message: "Failed to load events" });
  }
});

/* --------------------------------- SEARCH ---------------------------------- */
/**
 * GET /kiosk/search
 * q=term, mode=name|phone, event_id=?, limit=?
 *
 * Each member includes:
 *  - type: "member" | "elder"
 *  - last_checkin: {
 *      checked_in, time_iso, time_display,
 *      event_id, event_title,
 *      // nested, preferred:
 *      event: { id, title, location },
 *      // flat aliases (for UI compatibility):
 *      location, location_name, event_location, venue, place, location_text
 *    } | null
 */
router.get("/search", kioskAuth, async (req, res) => {
  const raw = String(req.query.q || "").trim();
  const mode = (req.query.mode || "name").toLowerCase();
  const eventId = req.query.event_id ? parseInt(req.query.event_id, 10) : null;
  const limit = Math.min(
    100,
    Math.max(1, parseInt(req.query.limit || "50", 10))
  );

  if (!raw) return res.json([]);

  const nameLike = `%${raw}%`;
  const phoneLike = `%${raw.replace(/\D+/g, "")}%`;

  try {
    const sql = `
      WITH rows_union AS (
        /* -------- members -------- */
        SELECT
          'member'::text            AS type,
          u.id::int                 AS raw_id,
          ('member-' || u.id)       AS id,
          u.first_name,
          u.last_name,
          u.phone,
          u.family_id,
          f.family_name             AS family_name,
          lc.checkin_time           AS last_time,
          lc.event_id               AS last_event_id,
          lc.event_title            AS last_event,
          lc.event_location         AS last_location
        FROM users u
        LEFT JOIN families f ON f.id = u.family_id
        LEFT JOIN LATERAL (
          SELECT
            c.checkin_time,
            c.event_id,
            ev.title            AS event_title,
            ev.location         AS event_location
          FROM check_ins c
          LEFT JOIN events ev ON ev.id = c.event_id
          WHERE c.user_id = u.id
            AND ($3::int IS NULL OR c.event_id = $3::int)
          ORDER BY c.checkin_time DESC
          LIMIT 1
        ) lc ON TRUE
        WHERE CASE
          WHEN $2 = 'phone'
            THEN regexp_replace(COALESCE(u.phone,''), '[^0-9]', '', 'g') LIKE $1
          ELSE (u.first_name || ' ' || u.last_name) ILIKE $4
            OR u.first_name ILIKE $4
            OR u.last_name  ILIKE $4
        END

        UNION ALL

        /* -------- elders -------- */
        SELECT
          'elder'::text             AS type,
          e.id::int                 AS raw_id,
          ('elder-' || e.id)        AS id,
          e.first_name,
          e.last_name,
          e.phone,
          e.family_id,
          f2.family_name            AS family_name,
          lc.checkin_time           AS last_time,
          lc.event_id               AS last_event_id,
          lc.event_title            AS last_event,
          lc.event_location         AS last_location
        FROM elders e
        LEFT JOIN families f2 ON f2.id = e.family_id
        LEFT JOIN LATERAL (
          SELECT
            c.checkin_time,
            c.event_id,
            ev.title            AS event_title,
            ev.location         AS event_location
          FROM check_ins c
          LEFT JOIN events ev ON ev.id = c.event_id
          WHERE c.elder_id = e.id
            AND ($3::int IS NULL OR c.event_id = $3::int)
          ORDER BY c.checkin_time DESC
          LIMIT 1
        ) lc ON TRUE
        WHERE CASE
          WHEN $2 = 'phone'
            THEN regexp_replace(COALESCE(e.phone,''), '[^0-9]', '', 'g') LIKE $1
          ELSE (e.first_name || ' ' || e.last_name) ILIKE $4
            OR e.first_name ILIKE $4
            OR e.last_name  ILIKE $4
        END
      )
      SELECT *
      FROM rows_union
      ORDER BY last_name, first_name
      LIMIT $5
    `;

    const params = [phoneLike, mode, eventId, nameLike, limit];
    const { rows } = await db.query(sql, params);

    const byFamily = new Map();
    for (const r of rows) {
      const famId = r.family_id || 0;
      const famName = r.family_name || null;
      if (!byFamily.has(famId)) {
        byFamily.set(famId, {
          family_id: famId,
          label: famId
            ? famName
              ? famName
              : `Family #${famId}`
            : "No Family Record",
          members: [],
        });
      }

      const loc = r.last_location || null;
      const lastCheck = r.last_time
        ? {
            checked_in: true,
            time_iso: r.last_time,
            time_display: new Date(r.last_time).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            event_id: r.last_event_id || null,
            event_title: r.last_event || null,
            event: {
              id: r.last_event_id || null,
              title: r.last_event || null,
              location: loc,
            },
            // flat aliases for UI compatibility
            location: loc,
            location_name: loc,
            event_location: loc,
            venue: loc,
            place: loc,
            location_text: loc,
          }
        : null;

      byFamily.get(famId).members.push({
        id: r.id,
        type: r.type, // 'member' | 'elder'
        first_name: r.first_name,
        last_name: r.last_name,
        phone: r.phone,
        family_id: famId,
        last_checkin: lastCheck,
      });
    }

    const families = [...byFamily.values()].map((f) => ({
      ...f,
      members: f.members.sort(
        (a, b) =>
          (a.last_name || "").localeCompare(b.last_name || "") ||
          (a.first_name || "").localeCompare(b.first_name || "")
      ),
    }));
    families.sort((a, b) => {
      if (a.family_id && !b.family_id) return -1;
      if (!a.family_id && b.family_id) return 1;
      return 0;
    });

    res.json(families);
  } catch (e) {
    console.error("kiosk search error:", e);
    res.status(500).json({ message: "Search failed" });
  }
});

/* ----------------------------- SINGLE CHECK-IN ----------------------------- */
router.post("/checkins", kioskAuth, async (req, res) => {
  let { event_id, entity_id } = req.body || {};
  event_id = parseInt(event_id, 10);

  try {
    if (!event_id || !entity_id) {
      return res.status(400).json({ message: "Missing event_id or entity_id" });
    }

    const isElder = String(entity_id).startsWith("elder-");
    const id = parseInt(String(entity_id).replace(/^[^\d]+/, ""), 10);
    const col = isElder ? "elder_id" : "user_id";

    const insertSql = `
      INSERT INTO check_ins (event_id, ${col}, checkin_time)
      SELECT $1, $2, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM check_ins WHERE event_id = $1 AND ${col} = $2
      )
      RETURNING id, event_id, ${col} AS entity_id, checkin_time
    `;
    const { rows } = await db.query(insertSql, [event_id, id]);
    const inserted = rows[0] || null;

    // Include event details (with location) so UI can show immediately
    let event = null;
    if (inserted) {
      const ev = await db.query(
        `SELECT id, title, event_date, event_time, location FROM events WHERE id = $1 LIMIT 1`,
        [inserted.event_id]
      );
      event = ev.rows[0] || null;
    }

    const loc = event?.location ?? null;

    res.status(201).json({
      ok: true,
      checkin: inserted
        ? {
            ...inserted,
            event,
            // aliases for UI
            location: loc,
            event_title: event?.title ?? null,
          }
        : null,
    });
  } catch (e) {
    console.error("kiosk checkin error:", e);
    res.status(500).json({ message: "Failed to check in" });
  }
});

/* ------------------------------ BULK CHECK-IN ------------------------------ */
router.post("/checkins/bulk", kioskAuth, async (req, res) => {
  let { event_id, entity_ids } = req.body || {};
  event_id = parseInt(event_id, 10);
  const ids = Array.isArray(entity_ids) ? entity_ids : [];

  if (!event_id || !ids.length) {
    return res.status(400).json({ message: "Missing event_id or entity_ids" });
  }

  const userIds = [];
  const elderIds = [];
  for (const eid of ids) {
    if (String(eid).startsWith("elder-")) {
      elderIds.push(parseInt(String(eid).replace(/^[^\d]+/, ""), 10));
    } else {
      userIds.push(parseInt(String(eid).replace(/^[^\d]+/, ""), 10));
    }
  }

  try {
    await db.query("BEGIN");

    let inserted = 0;

    if (userIds.length) {
      const q = `
        INSERT INTO check_ins (event_id, user_id, checkin_time)
        SELECT $1, x, NOW()
        FROM unnest($2::int[]) AS x
        WHERE NOT EXISTS (
          SELECT 1 FROM check_ins c WHERE c.event_id = $1 AND c.user_id = x
        )
      `;
      const r = await db.query(q, [event_id, userIds]);
      inserted += r.rowCount || 0;
    }

    if (elderIds.length) {
      const q = `
        INSERT INTO check_ins (event_id, elder_id, checkin_time)
        SELECT $1, x, NOW()
        FROM unnest($2::int[]) AS x
        WHERE NOT EXISTS (
          SELECT 1 FROM check_ins c WHERE c.event_id = $1 AND c.elder_id = x
        )
      `;
      const r = await db.query(q, [event_id, elderIds]);
      inserted += r.rowCount || 0;
    }

    await db.query("COMMIT");
    res
      .status(201)
      .json({ ok: true, inserted, skipped: ids.length - inserted });
  } catch (e) {
    await db.query("ROLLBACK");
    console.error("kiosk bulk checkin error:", e);
    res.status(500).json({ message: "Bulk check-in failed" });
  }
});

/* ------------------------------ BULK CHECK-OUT ----------------------------- */
router.post("/checkouts/bulk", kioskAuth, async (req, res) => {
  let { event_id, entity_ids } = req.body || {};
  event_id = parseInt(event_id, 10);
  const ids = Array.isArray(entity_ids) ? entity_ids : [];

  if (!event_id || !ids.length) {
    return res.status(400).json({ message: "Missing event_id or entity_ids" });
  }

  const userIds = [];
  const elderIds = [];
  for (const eid of ids) {
    if (String(eid).startsWith("elder-")) {
      elderIds.push(parseInt(String(eid).replace(/^[^\d]+/, ""), 10));
    } else {
      userIds.push(parseInt(String(eid).replace(/^[^\d]+/, ""), 10));
    }
  }

  try {
    await db.query("BEGIN");

    let affected = 0;

    if (userIds.length) {
      for (const uid of userIds) {
        const del = await db.query(
          `
            DELETE FROM check_ins
            WHERE id IN (
              SELECT id FROM check_ins
              WHERE event_id = $1 AND user_id = $2
              ORDER BY checkin_time DESC
              LIMIT 1
            )
          `,
          [event_id, uid]
        );
        affected += del.rowCount || 0;
      }
    }

    if (elderIds.length) {
      for (const eid of elderIds) {
        const del = await db.query(
          `
            DELETE FROM check_ins
            WHERE id IN (
              SELECT id FROM check_ins
              WHERE event_id = $1 AND elder_id = $2
              ORDER BY checkin_time DESC
              LIMIT 1
            )
          `,
          [event_id, eid]
        );
        affected += del.rowCount || 0;
      }
    }

    await db.query("COMMIT");
    res.json({ ok: true, affected });
  } catch (e) {
    await db.query("ROLLBACK");
    console.error("kiosk bulk checkout error:", e);
    res.status(500).json({ message: "Bulk check-out failed" });
  }
});

module.exports = router;

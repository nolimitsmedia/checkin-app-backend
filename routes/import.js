// routes/import.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const db = require("../db");

const upload = multer({ dest: "uploads/" });

// Utility to normalize status string to boolean
function normalizeStatus(val) {
  if (!val) return true; // Default to active
  if (typeof val === "boolean") return val;
  const lower = String(val).toLowerCase();
  return !["inactive", "false", "0", "no"].includes(lower);
}

// Utility to normalize gender to match your backend values
function normalizeGender(val) {
  if (!val) return null;
  const lower = String(val).toLowerCase();
  if (["male", "m"].includes(lower)) return "male";
  if (["female", "f"].includes(lower)) return "female";
  if (["other", "o"].includes(lower)) return "other";
  if (
    [
      "prefer not to say",
      "prefer_not_to_say",
      "prefer-not-to-say",
      "n/a",
    ].includes(lower)
  )
    return "prefer_not_to_say";
  return null;
}

// Utility: Normalize phone (treat empty/blank as null)
function normalizePhone(val) {
  if (!val || String(val).trim() === "") return null;
  return String(val).trim();
}

router.post("/users", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  const results = [];
  let hasError = false,
    imported = 0,
    skipped = 0,
    errors = [];

  try {
    // Parse CSV
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(csv())
        .on("data", (row) => {
          if (!row.first_name || !row.last_name) hasError = true;
          results.push(row);
        })
        .on("end", resolve)
        .on("error", reject);
    });

    if (hasError) {
      return res.status(400).json({
        message: "Missing required user fields in CSV (first_name, last_name)",
      });
    }

    for (const u of results) {
      let familyId = null;
      if (u.family_name) {
        const fam = await db.query(
          "SELECT id FROM families WHERE family_name=$1",
          [u.family_name]
        );
        if (fam.rows.length > 0) familyId = fam.rows[0].id;
        else {
          const ins = await db.query(
            "INSERT INTO families (family_name) VALUES ($1) RETURNING id",
            [u.family_name]
          );
          familyId = ins.rows[0].id;
        }
      }

      const gender = normalizeGender(u.gender);
      const active = normalizeStatus(u.status);
      const phone = normalizePhone(u.phone);
      const role = (u.role || "").trim().toLowerCase();

      try {
        if (role === "elder") {
          // Upsert by email if present, else insert new always
          if (u.email) {
            await db.query(
              `INSERT INTO elders (first_name, last_name, email, phone, role, family_id, gender, active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (email) DO UPDATE
               SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, phone=EXCLUDED.phone,
                   family_id=EXCLUDED.family_id, gender=EXCLUDED.gender, active=EXCLUDED.active`,
              [
                u.first_name,
                u.last_name,
                u.email,
                phone,
                "elder",
                familyId,
                gender,
                active,
              ]
            );
          } else {
            // If no email, just insert new row
            await db.query(
              `INSERT INTO elders (first_name, last_name, email, phone, role, family_id, gender, active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                u.first_name,
                u.last_name,
                null,
                phone,
                "elder",
                familyId,
                gender,
                active,
              ]
            );
          }
        } else {
          // Upsert by email if present, else insert new always
          if (u.email) {
            await db.query(
              `INSERT INTO users (first_name, last_name, email, phone, role, family_id, gender, active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (email) DO UPDATE
               SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, phone=EXCLUDED.phone,
                   role=EXCLUDED.role, family_id=EXCLUDED.family_id, gender=EXCLUDED.gender, active=EXCLUDED.active`,
              [
                u.first_name,
                u.last_name,
                u.email,
                phone,
                u.role || null,
                familyId,
                gender,
                active,
              ]
            );
          } else {
            // If no email, just insert new row
            await db.query(
              `INSERT INTO users (first_name, last_name, email, phone, role, family_id, gender, active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                u.first_name,
                u.last_name,
                null,
                phone,
                u.role || null,
                familyId,
                gender,
                active,
              ]
            );
          }
        }
        imported++;
      } catch (err) {
        skipped++;
        errors.push({
          user: `${u.first_name} ${u.last_name}`,
          phone,
          error: err.message,
        });
        continue;
      }
    }

    res.json({ message: "Import complete", imported, skipped, errors });
  } catch (err) {
    console.error("Import error", err);
    res.status(500).json({
      message: "Import error",
      error: err.message,
      detail: err.detail,
    });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

module.exports = router;

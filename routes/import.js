// routes/import.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const db = require("../db");

const upload = multer({ dest: "uploads/" });

router.post("/users", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  const results = [];
  let hasError = false;

  try {
    // Parse CSV
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(csv())
        .on("data", (row) => {
          if (!row.first_name || !row.last_name || !row.email || !row.role) {
            hasError = true;
          }
          results.push(row);
        })
        .on("end", resolve)
        .on("error", reject);
    });

    if (hasError) {
      return res.status(400).json({
        message:
          "Missing required user fields in CSV (first_name, last_name, email, role)",
      });
    }

    for (const u of results) {
      // Find or create family if family_name is provided
      let familyId = null;
      if (u.family_name) {
        const fam = await db.query(
          "SELECT id FROM families WHERE family_name=$1",
          [u.family_name]
        );
        if (fam.rows.length > 0) {
          familyId = fam.rows[0].id;
        } else {
          const ins = await db.query(
            "INSERT INTO families (family_name) VALUES ($1) RETURNING id",
            [u.family_name]
          );
          familyId = ins.rows[0].id;
        }
      }

      // Choose table based on role
      if (u.role.trim().toLowerCase() === "elder") {
        // Insert or update elder by email
        await db.query(
          `INSERT INTO elders (first_name, last_name, email, phone, role, family_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (email) DO UPDATE
           SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, phone=EXCLUDED.phone, family_id=EXCLUDED.family_id`,
          [u.first_name, u.last_name, u.email, u.phone, u.role, familyId]
        );
      } else {
        // Insert or update user by email
        await db.query(
          `INSERT INTO users (first_name, last_name, email, phone, role, family_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (email) DO UPDATE
           SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, phone=EXCLUDED.phone, role=EXCLUDED.role, family_id=EXCLUDED.family_id`,
          [u.first_name, u.last_name, u.email, u.phone, u.role, familyId]
        );
      }
    }

    res.json({ message: "Import complete" });
  } catch (err) {
    console.error("Import error", err);
    res.status(500).json({ message: "Import error", error: err.message });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

module.exports = router;

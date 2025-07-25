const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const router = express.Router();
const authenticate = require("../middleware/authenticate");

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${file.fieldname}-${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"));
    }
  },
});

// ✅ POST /api/uploads/avatar?userId=11&type=user
router.post(
  "/avatar",
  authenticate,
  upload.single("avatar"),
  async (req, res) => {
    try {
      if (!req.file) {
        console.log("No file received in upload.");
        return res.status(400).json({ message: "No file uploaded" });
      }
      // Send the uploaded file's URL as response!
      const avatarUrl = `/uploads/${req.file.filename}`;
      res.json({ url: avatarUrl });
    } catch (err) {
      console.error("Avatar upload error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router;

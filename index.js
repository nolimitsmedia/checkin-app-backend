const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = express();
const port = 3001;

const allowedOrigins = [
  "http://localhost:3000", // For local development
  "https://nolimitsmedia.github.io", // For your production frontend (GitHub Pages)
  // Add more domains if you need
];

// ✅ Configure CORS to allow requests from your frontend origin
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// ✅ Import route files
const usersRoutes = require("./routes/users");
const adminsRoutes = require("./routes/admins");
const eventsRoutes = require("./routes/events");
const checkinsRoutes = require("./routes/checkins");
const reportsRoutes = require("./routes/reports");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const elderRoutes = require("./routes/elders");
const familySearch = require("./routes/familySearch");
const uploadsRoute = require("./routes/uploads");
const familiesRouter = require("./routes/families");
const ministriesRouter = require("./routes/ministries");
const path = require("path");

app.use(bodyParser.json());

// ✅ Register routes
app.use("/api/users", usersRoutes);
app.use("/api/admins", adminsRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/checkins", checkinsRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/elders", elderRoutes);
app.use("/api/familySearch", familySearch);
app.use("/api/uploads", uploadsRoute);
app.use("/api/families", familiesRouter);
app.use("/api/ministries", ministriesRouter);
app.use("/api/import", require("./routes/import"));

// Serve static files from /uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ✅ Start server
app.listen(port, () => {
  console.log(`✅ Server is running on http://localhost:${port}`);
});

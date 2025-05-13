import express from "express";
import multer from "multer";
import cors from "cors";
const app = express();
import { Queue } from "bullmq";

const queue = new Queue("pdf-queue");
app.use(cors());

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "-" + uniqueSuffix + file.originalname);
  },
});

const upload = multer({ storage: storage });

app.post("/upload/pdf", upload.single("pdf"), async (req, res) => {
  await queue.add(
    "pdf",
    JSON.stringify({
      filename: req.file.originalname,
      destination: req.file.path,
    })
  );
  return res.json({ msg: "file uploaded" });
});

app.get("/", (req, res) => {
  res.json({ msg: "hello this is sujan" });
});

app.listen(8000, () => {
  console.log("Server is running on port 8000");
});

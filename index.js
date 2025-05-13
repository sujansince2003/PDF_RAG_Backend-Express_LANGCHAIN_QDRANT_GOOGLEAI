import express from "express";
import multer from "multer";
import cors from "cors";
import { Mistral } from "@mistralai/mistralai";

import { Queue } from "bullmq";
import { MistralAIEmbeddings } from "@langchain/mistralai";
import { QdrantVectorStore } from "@langchain/qdrant";

const client = new Mistral({ apiKey: "HS1StuaBt3APyl2O1MchRqUd5t7nIs3P" });

const app = express();
app.use(cors());

const queue = new Queue("pdf-queue");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const upload = multer({ storage: storage });

app.get("/chat", async (req, res) => {
  const userQuery = req.query.message;
  const embeddings = new MistralAIEmbeddings({
    model: "mistral-embed",
    apiKey: "HS1StuaBt3APyl2O1MchRqUd5t7nIs3P",
  });

  const vectorStore = await QdrantVectorStore.fromExistingCollection(
    embeddings,
    {
      url: "http://localhost:6333",
      collectionName: "pdf_documents",
    }
  );

  const ret = vectorStore.asRetriever({
    k: 2,
  });
  const result = await ret.invoke(userQuery);

  const SYSTEM_PROMPT = `
  You are helfull AI Assistant who answeres the user query based on the available context from PDF File.
  Context:
  ${JSON.stringify(result)}
  `;

  const chatResult = await client.chat.complete({
    model: "mistral-large-latest",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userQuery },
    ],
  });

  return res.json({
    answer: chatResult.choices[0].message.content,
    docs: result,
  });
});

app.post("/upload/pdf", upload.single("pdf"), async (req, res) => {
  await queue.add(
    "file-ready",
    JSON.stringify({
      filename: req.file.originalname,
      destination: req.file.destination,
      path: req.file.path,
    })
  );
  console.log("file uplaoded");
  return res.json({ message: "uploaded" });
});

app.get("/", (req, res) => {
  res.json({ msg: "hello this is sujan" });
});

app.listen(8000, () => {
  console.log("Server is running on port 8000");
});

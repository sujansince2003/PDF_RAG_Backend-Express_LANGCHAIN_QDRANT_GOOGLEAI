import express from "express";
import multer from "multer";
import cors from "cors";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { Queue } from "bullmq";
import dotenv from "dotenv";
dotenv.config();

// Initialize the Gemini chat client with a specific model version
const chatModel = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-flash", // <--- CHANGE THIS LINE
  // OR: model: "gemini-1.5-pro",
  apiKey: process.env.GOOGLE_API_KEY,
});

const app = express();
app.use(cors());
app.use(express.json());

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
  if (!userQuery) {
    return res.status(400).json({ message: "Query message is required." });
  }

  const embeddings = new GoogleGenerativeAIEmbeddings({
    model: "embedding-001",
    apiKey: process.env.GOOGLE_API_KEY,
  });

  try {
    const vectorStore = await QdrantVectorStore.fromExistingCollection(
      embeddings,
      {
        url: "http://localhost:6333",
        collectionName: "pdf_documents",
      }
    );

    const retriever = vectorStore.asRetriever({
      k: 2,
    });
    const result = await retriever.invoke(userQuery);

    const SYSTEM_PROMPT = `
You are a helpful AI Assistant.
Answer the user's query using the provided "Context from PDF File" first.
If the answer is *not* found in the provided context, then use your general knowledge to answer.
When you answer based on your general knowledge (not from the PDF), explicitly state "Note: This information is from my general knowledge and not found in the provided PDF." at the end of your answer.

Context from PDF File:
${result.map((doc) => doc.pageContent).join("\n\n")}
`;

    const chatResult = await chatModel.invoke([
      ["system", SYSTEM_PROMPT],
      ["user", userQuery],
    ]);

    return res.json({
      answer: chatResult.content,
      docs: result,
    });
  } catch (error) {
    console.error("Chat processing failed:", error);
    return res.status(500).json({ message: "Error processing chat query." });
  }
});

app.post("/upload/pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No PDF file uploaded." });
  }
  await queue.add(
    "file-ready",
    JSON.stringify({
      filename: req.file.originalname,
      destination: req.file.destination,
      path: req.file.path,
    })
  );
  console.log("file uploaded");
  return res.json({ message: "uploaded" });
});

app.get("/", (req, res) => {
  res.json({ msg: "hello this is sujan" });
});

app.listen(8000, () => {
  console.log("Server is running on port 8000");
});

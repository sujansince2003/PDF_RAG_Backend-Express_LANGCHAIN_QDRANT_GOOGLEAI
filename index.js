// backend/index.js
import express from "express";
import multer from "multer";
import cors from "cors";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { Queue } from "bullmq";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import path from "path";
import fs from "fs/promises";
import { QdrantClient } from "@qdrant/js-client-rest";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;
const prisma = new PrismaClient();

const chatModel = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
});

const qdrantClient = new QdrantClient({
  host: process.env.QDRANT_HOST || "localhost",
  port: parseInt(process.env.QDRANT_PORT || "6333"),
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const queue = new Queue("pdf-queue", {
  connection: {
    host: process.env.VALKEY_HOST || "localhost",
    port: parseInt(process.env.VALKEY_PORT || "6379"),
  },
});

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: async function (req, file, cb) {
      // ✨ MODIFIED: Get userId from req.query instead of req.body ✨
      // Multer processes the body, but query params are available earlier.
      const userId = req.query.userId;
      if (!userId || typeof userId !== "string") {
        return cb(
          new Error(
            "User ID is required and must be a string for file upload destination."
          ),
          null
        );
      }
      const userUploadsDir = path.join(__dirname, "uploads", userId);
      try {
        await fs.mkdir(userUploadsDir, { recursive: true });
        cb(null, userUploadsDir);
      } catch (err) {
        cb(err, null);
      }
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `${uniqueSuffix}-${file.originalname}`);
    },
  }),
});

app.get("/", (req, res) => {
  res.json({ msg: "hello this is sujan" });
});

app.post("/chat", async (req, res) => {
  const { userQuery, documentId, userId } = req.body;

  if (!userQuery || !documentId || !userId) {
    return res
      .status(400)
      .json({ message: "Missing required chat parameters." });
  }

  const embeddings = new GoogleGenerativeAIEmbeddings({
    model: "embedding-001",
    apiKey: process.env.GOOGLE_API_KEY,
  });

  try {
    const collectionName = `pdf_documents_${documentId}`;

    const collectionExists = await qdrantClient
      .getCollection(collectionName)
      .then(() => true)
      .catch((err) => {
        if (!err.message.includes("Not found")) {
          console.error(
            `Error checking Qdrant collection ${collectionName}:`,
            err
          );
        }
        return false;
      });

    if (!collectionExists) {
      return res.status(404).json({
        message: `Document collection for ID ${documentId} not found in Qdrant. It might not have been processed yet.`,
      });
    }

    const vectorStore = await QdrantVectorStore.fromExistingCollection(
      embeddings,
      {
        url: `http://${process.env.QDRANT_HOST || "localhost"}:${
          process.env.QDRANT_PORT || "6333"
        }`,
        collectionName: collectionName,
      }
    );

    const retriever = vectorStore.asRetriever({
      k: 4,
    });

    const relevantDocs = await retriever.invoke(userQuery);
    const contextContent = relevantDocs
      .map((doc) => doc.pageContent)
      .join("\n\n");

    const PROMPT_TEMPLATE = `
      You are a helpful AI Assistant. Your primary goal is to answer questions based on the provided "Context from PDF File".

      If the user's question can be directly and comprehensively answered using ONLY the provided "Context from PDF File", then provide that answer. Do not add information that is not in the context.

      If the user's question CANNOT be directly and comprehensively answered from the "Context from PDF File", then:
      1. First, state what you *can* find in the PDF related to the query (if anything relevant but insufficient).
      2. Then, proceed to answer the question using your general knowledge.
      3. **Important:** When you use your general knowledge, clearly indicate this by starting that part of your answer with "However, based on my general knowledge: " or "Outside the PDF context, I know that: ".

      Do not invent information. If the context is empty or irrelevant, you should rely entirely on your general knowledge and state that the answer is from general knowledge.

      ---
      Context from PDF File:
      ${
        contextContent.trim()
          ? contextContent
          : "No relevant information found in the PDF context."
      }
      ---
      User Question: ${userQuery}
      ---
      Answer:
    `;

    const chatResult = await chatModel.invoke([
      ["system", PROMPT_TEMPLATE],
      ["user", userQuery],
    ]);

    return res.json({
      answer: chatResult.content,
      docs: relevantDocs,
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

  // documentId is still in req.body from the Next.js API route's FormData
  const { documentId } = req.body;
  // userId is now from req.query
  const userId = req.query.userId;

  if (!documentId || !userId || typeof userId !== "string") {
    await fs
      .unlink(req.file.path)
      .catch((err) =>
        console.error("Failed to clean up incomplete upload:", err)
      );
    console.error("Missing documentId or userId in PDF upload request.");
    return res.status(400).json({ message: "Missing documentId or userId." });
  }

  await queue.add(
    "file-ready",
    JSON.stringify({
      filename: req.file.originalname,
      destination: req.file.destination,
      path: req.file.path,
      documentId: documentId,
      userId: userId,
    })
  );
  console.log(
    `File uploaded: ${req.file.originalname} for document ${documentId} by user ${userId}.`
  );
  return res.json({ message: "uploaded", documentId: documentId });
});

app.post("/delete-collection", async (req, res) => {
  const { collectionName } = req.body;
  if (!collectionName) {
    return res.status(400).json({ message: "Collection name is required." });
  }
  try {
    await qdrantClient.deleteCollection(collectionName);
    console.log(`Qdrant collection ${collectionName} deleted.`);
    return res
      .status(200)
      .json({ message: `Collection ${collectionName} deleted.` });
  } catch (error) {
    console.error(`Error deleting Qdrant collection ${collectionName}:`, error);
    return res
      .status(500)
      .json({ message: `Failed to delete collection: ${error.message}` });
  }
});

app.post("/delete-file", async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ message: "File path is required." });
  }
  try {
    const uploadsBaseDir = path.resolve(__dirname, "uploads");
    const resolvedFilePath = path.resolve(filePath);

    if (!resolvedFilePath.startsWith(uploadsBaseDir)) {
      console.warn(
        `Attempted to delete file outside uploads directory: ${filePath}`
      );
      return res
        .status(403)
        .json({ message: "Access denied: Invalid file path." });
    }

    await fs.unlink(resolvedFilePath);
    console.log(`File ${filePath} deleted from server.`);
    return res.status(200).json({ message: `File ${filePath} deleted.` });
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error);
    return res
      .status(500)
      .json({ message: `Failed to delete file: ${error.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// backend/worker.js
import { Worker } from "bullmq";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import fs from "fs/promises"; // Use promises version of fs for file cleanup
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client"; // Import PrismaClient

dotenv.config();

// Initialize Prisma Client for the worker
const prisma = new PrismaClient();

const embeddings = new GoogleGenerativeAIEmbeddings({
  model: "embedding-001",
  apiKey: process.env.GOOGLE_API_KEY,
});

const worker = new Worker(
  "pdf-queue",
  async (job) => {
    console.log(`Processing job ${job.id}:`, job.data);
    // Get documentId and userId from job.data
    const { filename, path, documentId, userId } = JSON.parse(job.data);

    if (!documentId || !userId) {
      console.error(`Job ${job.id}: Missing documentId or userId. Skipping.`);
      // Optionally, mark job as failed or update document status in Prisma
      throw new Error("Missing documentId or userId in job data.");
    }

    try {
      // Load PDF
      const loader = new PDFLoader(path);
      const docs = await loader.load();

      console.log(
        `Job ${job.id}: Preparing to embed ${docs.length} documents for ${filename}.`
      );

      // Split documents
      const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });
      const splitDocs = await textSplitter.splitDocuments(docs);

      // Create a unique collection name for this document
      const collectionName = `pdf_documents_${documentId}`;

      // Embed and store in Qdrant
      // fromDocuments handles creating the collection if it doesn't exist
      const vectorStore = await QdrantVectorStore.fromDocuments(
        splitDocs,
        embeddings,
        {
          url: `http://${process.env.QDRANT_HOST || "localhost"}:${
            process.env.QDRANT_PORT || "6333"
          }`,
          collectionName: collectionName, // Use dynamic collection name
        }
      );

      // Update the Document in Prisma with the Qdrant collection name
      await prisma.document.update({
        where: { id: documentId, userId: userId }, // Ensure it's the correct user's document
        data: { qdrantId: collectionName }, // Store the collection name as qdrantId
      });

      console.log(
        `Job ${job.id}: PDF "${filename}" embedded and stored in Qdrant collection "${collectionName}".`
      );

      // Clean up the uploaded file after successful processing
      await fs.unlink(path);
      console.log(`Job ${job.id}: Cleaned up file ${path}`);
    } catch (error) {
      console.error(`Job ${job.id}: Processing failed for ${filename}:`, error);
      // You might want to update the document status in Prisma to 'failed' here
      // Re-throw to mark the job as failed in BullMQ
      throw error;
    }
  },
  {
    concurrency: 2,
    // Use connection details from .env
    connection: {
      host: process.env.VALKEY_HOST || "localhost",
      port: parseInt(process.env.VALKEY_PORT || "6379"),
    },
  }
);

console.log("Worker started.");

// Handle worker events (optional, but good for logging)
worker.on("completed", (job) => {
  console.log(`Job ${job.id} has completed!`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job.id} has failed with error: ${err.message}`);
});

worker.on("error", (err) => {
  console.error(`Worker error: ${err.message}`);
});

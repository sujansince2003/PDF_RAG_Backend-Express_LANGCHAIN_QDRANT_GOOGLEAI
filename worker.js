import { Worker } from "bullmq";
// Import GoogleGenerativeAIEmbeddings instead of MistralAIEmbeddings
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import dotenv from "dotenv";
dotenv.config();
console.log("worker started");
console.log(process.env.GOOGLE_API_KEY);

const worker = new Worker(
  "pdf-queue",
  async (job) => {
    const data = JSON.parse(job.data);
    const loader = new PDFLoader(data.path);
    const docs = await loader.load();

    console.log("Preparing to embed", docs.length, "documents");

    try {
      // Initialize Gemini Embeddings
      const embeddings = new GoogleGenerativeAIEmbeddings({
        // You can choose a different embedding model if available,
        // for example: "embedding-001" or "text-embedding-004"
        model: "embedding-001",
        apiKey: process.env.GOOGLE_API_KEY, // Use environment variable for API key
      });

      console.log("Embedding model loaded (Gemini)");

      // LangChain's embedDocuments method is designed to handle an array of Document objects directly
      // It's generally better to pass the full Document objects if the vector store can use them
      // If embedDocuments expects string content, then map to pageContent as you did before
      const vectors = await embeddings.embedDocuments(
        docs.map((doc) => doc.pageContent) // Keep this if embedDocuments expects strings
      );
      console.log(
        "✅ Embedding successful:",
        vectors.length,
        "vectors created"
      );

      const vectorStore = await QdrantVectorStore.fromDocuments(
        docs,
        embeddings,
        {
          url: "http://localhost:6333", // Qdrant local instance
          collectionName: "pdf_documents",
        }
      );

      // The fromDocuments call already adds the documents.
      // Calling addDocuments again here would duplicate them.
      // So, you can remove this line:
      // await vectorStore.addDocuments(docs);
      console.log("Vector store saved");
    } catch (error) {
      console.error(" Processing failed:", error.message || error);
    }
  },
  {
    concurrency: 2, // Reduced concurrency for local models
    connection: {
      host: "localhost",
      port: 6379,
    },
  }
);

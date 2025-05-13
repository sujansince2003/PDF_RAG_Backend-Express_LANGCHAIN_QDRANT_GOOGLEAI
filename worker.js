import { Worker } from "bullmq";
import { MistralAIEmbeddings } from "@langchain/mistralai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";

console.log("worker started");

const worker = new Worker(
  "pdf-queue",
  async (job) => {
    const data = JSON.parse(job.data);
    const loader = new PDFLoader(data.path);
    const docs = await loader.load();

    console.log("Preparing to embed", docs.length, "documents");

    try {
      const embeddings = new MistralAIEmbeddings({
        model: "mistral-embed",
        apiKey: "HS1StuaBt3APyl2O1MchRqUd5t7nIs3P",
      });

      console.log("Embedding model loaded");

      const vectors = await embeddings.embedDocuments(
        docs.map((doc) => doc.pageContent)
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

      await vectorStore.addDocuments(docs);
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

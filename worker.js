import { Worker } from "bullmq";

const worker = new Worker(
  "pdf-queue",
  async (job) => {
    console.log("job", job.data);
  },
  {
    concurrency: 100,
    connection: {
      host: "localhost",
      port: 6379,
    },
  }
);

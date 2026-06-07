import { startWorker } from "./src/redis/streamWorker";
import { state } from "./src/state";

console.log("Starting engine worker...");

async function bootstrap() {
  await state.initialize();
  await startWorker();
}

bootstrap()
  .then(() => {
    console.log("Worker loop ended.");
  })
  .catch((err) => {
    console.error("Fatal worker error:", err);
  });
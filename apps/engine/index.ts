import { startWorker } from "./src/redis/streamWorker";
import { startDBWriter } from "./src/redis/dbWriter";

async function bootstrap() {
  await Promise.all([
    startWorker(),
    startDBWriter(),
  ]);
}

bootstrap()
  .then(() => {
    console.log("Engine and DB Writer loops ended.");
  })
  .catch((err) => {
    console.error("Fatal engine / worker error:", err);
  });
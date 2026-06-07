import { redis } from "./redis";
import { handleOnRamp } from "../handlers/onramp";
import { handleCreateOrder } from "../handlers/createOrder";

export async function startWorker() {
  try {
    await redis.xGroupCreate("engine-stream", "engine-group", "0", {
      MKSTREAM: true,
    });
  } catch (err: any) {
    if (!err.message?.includes("BUSYGROUP")) {
      console.error("Error creating Redis stream / consumer group:", err);
    }
  }

  while (true) {
    const messages = await redis.xReadGroup(
      "engine-group",
      "engine-1",
      [
        {
          key: "engine-stream",
          id: ">",
        },
      ],
      {
        BLOCK: 0,
      }
    );

    if (!messages) continue;

    for (const stream of messages) {
      for (const msg of stream.messages) {
        try {
          const type = msg.message.type;

          switch (type) {
            case "RAMP_USER":
              await handleOnRamp(msg.message);
              break;

            case "CREATE_ORDER":
              await handleCreateOrder(msg.message);
              break;

            default:
              console.log("Unknown Event:", type);
          }

          await redis.xAck(
            "engine-stream",
            "engine-group",
            msg.id
          );
        } catch (err) {
          console.error(err);
        }
      }
    }
  }
}
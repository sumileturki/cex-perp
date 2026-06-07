import express from "express"
import { registerUser } from "./src/controller/auth.controller";
import cookieParser from "cookie-parser";
import authRoute from "./src/route/auth.route"
import orderRoute from "./src/route/order.route"

const app= express();
app.use(express.json())
app.use(cookieParser());

app.use("/api/auth", authRoute);
app.use("/api/v1", orderRoute );



app.listen(3000, () => {
  console.log("Server running on port 3000");
});
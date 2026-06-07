import { prisma } from "db";
import { UserRegisterSchema, UserLoginSchema } from "../schema/auth.schema";
import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { success } from "zod";

export const registerUser = async (req: Request, res: Response) => {
  try {
    const parsedData = UserRegisterSchema.safeParse(req.body);

    if (!parsedData.success) {
      return res.status(400).json({
        success: false,
        errors: parsedData.error.issues,
      });
    }
    const { username, password, email } = parsedData.data;

    const existingUser = await prisma.user.findUnique({
      where: {
        email: email,
      },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "User already exists",
      });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
      },
    });

    const token = jwt.sign(
      {
        id: user.id,
      },
      process.env.JWT_SECRET!,
      {
        expiresIn: "7d",
      },
    );

    res.cookie("token", token);

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      token,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error while registration",
      error,
    });
  }
};
export const loginUser = async (req: Request, res: Response) => {
  try {
    const parsedData = UserLoginSchema.safeParse(req.body);

    if (!parsedData.success) {
      return res.status(400).json({
        success: false,
        errors: parsedData.error.issues,
      });
    }

    const existingUser = await prisma.user.findUnique({
      where: {
        username: parsedData.data.username,
      },
    });

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: "User does not exist",
      });
    }

    const isPasswordCorrect = await bcrypt.compare(
      parsedData.data.password,
      existingUser.password,
    );

    if (!isPasswordCorrect) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const token = jwt.sign(
      {
        id: existingUser?.id,
      },
      process.env.JWT_SECRET!,
      {
        expiresIn: "7d",
      },
    );

    res.cookie("token", token);
    

    return res.status(200).json({
      success: true,
      user: {
        id: existingUser.id,
        username: existingUser.username,
        email: existingUser.email,
      },
    });

     
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error while Login",
      error,
    });
  }
};

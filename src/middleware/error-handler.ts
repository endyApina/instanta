import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../errors/app-error";

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const message = issue && !/^(Invalid|Too small|Too big|Unrecognized)/.test(issue.message)
      ? issue.message : "Some details are missing or incorrect. Check the form and try again.";
    response.status(400).json({
      success: false,
      error: { code: "INVALID_REQUEST", message },
    });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    response.status(409).json({
      success: false,
      error: { code: "CONFLICT", message: "These details are already in use. Sign in or recover your account if it belongs to you." },
    });
    return;
  }
  if (error instanceof SyntaxError) {
    response.status(400).json({
      success: false,
      error: { code: "INVALID_JSON", message: "We could not read those details. Refresh the page and try again." },
    });
    return;
  }
  console.error("Unhandled request error", error);
  response.status(500).json({
    success: false,
    error: { code: "INTERNAL_SERVER_ERROR", message: "Something went wrong. Please try again. If it continues, contact support." },
  });
};

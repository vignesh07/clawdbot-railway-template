import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

export const workstudioRouter = express.Router();

workstudioRouter.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "ai-workstudio", version: "v1" });
});

workstudioRouter.use(express.static(publicDir, {
  index: "index.html",
  fallthrough: true,
}));

workstudioRouter.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

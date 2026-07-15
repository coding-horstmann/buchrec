import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 3000);
const username = process.env.APP_USERNAME;
const password = process.env.APP_PASSWORD;
const production = process.env.NODE_ENV === "production";

if (production && (!username || !password)) {
  throw new Error("APP_USERNAME und APP_PASSWORD muessen in Produktion gesetzt sein.");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  next();
});
app.get("/health", (_request, response) => {
  response.json({ status: "ok", storage: "browser-only" });
});

app.use((request, response, next) => {
  if (!username || !password) {
    return next();
  }

  const authorization = request.headers.authorization || "";
  const [scheme, encoded] = authorization.split(" ");
  if (scheme !== "Basic" || !encoded) {
    response.setHeader("WWW-Authenticate", 'Basic realm="buchrec"');
    return response.status(401).send("Anmeldung erforderlich");
  }

  const [providedUser = "", providedPassword = ""] = Buffer.from(encoded, "base64")
    .toString("utf8")
    .split(":");

  if (!safeEqual(providedUser, username) || !safeEqual(providedPassword, password)) {
    response.setHeader("WWW-Authenticate", 'Basic realm="buchrec"');
    return response.status(401).send("Anmeldung fehlgeschlagen");
  }

  return next();
});

app.use(
  express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "dist"), {
    etag: true,
    maxAge: production ? "1y" : 0,
    immutable: production,
    setHeaders(response, filePath) {
      if (filePath.endsWith("index.html")) response.setHeader("Cache-Control", "no-store");
    },
  }),
);

app.use((request, response) => {
  if (request.method !== "GET") return response.status(404).send("Nicht gefunden");
  response.setHeader("Cache-Control", "no-store");
  return response.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "dist", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`buchrec laeuft auf Port ${port}; Finanzdaten bleiben im Browser.`);
});

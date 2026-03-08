import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import httpProxy from "http-proxy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const SETUP_PASSWORD = (process.env.SETUP_PASSWORD || "").trim();
const OPENFANG_HOME = process.env.OPENFANG_HOME || "/data";
const CONFIG_PATH = path.join(OPENFANG_HOME, "config.toml");
const USER_CONFIG_PATH = path.join(OPENFANG_HOME, "config.user.toml");
const SECRETS_PATH = path.join(OPENFANG_HOME, "secrets.env");
const DAEMON_HOST = "127.0.0.1";
const DAEMON_PORT = 4200;
const DAEMON_BASE_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`;
const LOG_LIMIT = 250;

const requiredVariables = ["SETUP_PASSWORD", "OPENFANG_API_KEY"];

const state = {
  daemonProc: null,
  daemonPid: null,
  daemonHealthy: false,
  daemonStartedAt: null,
  daemonExitedAt: null,
  daemonExitCode: null,
  daemonSignal: null,
  restartCount: 0,
  pendingRestart: false,
  scheduledSpawn: null,
  healthTimer: null,
  lastHealthAt: null,
  lastHealthPayload: null,
  lastError: "",
  bootLogs: [],
  shuttingDown: false,
};

function logLine(scope, message) {
  const line = `[${new Date().toISOString()}] [${scope}] ${message}`;
  state.bootLogs.push(line);
  if (state.bootLogs.length > LOG_LIMIT) {
    state.bootLogs = state.bootLogs.slice(-LOG_LIMIT);
  }
  const writer = scope === "error" ? console.error : console.log;
  writer(line);
}

function getMissingRequiredVariables() {
  return requiredVariables.filter((name) => !String(process.env[name] || "").trim());
}

function hashString(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function timingSafeEqualString(a, b) {
  const left = hashString(a);
  const right = hashString(b);
  return crypto.timingSafeEqual(left, right);
}

function parseBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const result = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function getRuntimeApiKey() {
  const direct = String(process.env.OPENFANG_API_KEY || "").trim();
  if (direct) {
    return direct;
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    return "";
  }

  const content = fs.readFileSync(CONFIG_PATH, "utf8");
  const match = content.match(/^\s*api_key\s*=\s*"([^"]*)"/m);
  return match ? match[1] : "";
}

function buildDaemonEnv() {
  return {
    ...process.env,
    ...parseEnvFile(SECRETS_PATH),
    OPENFANG_HOME,
  };
}

function scheduleSpawn(delayMs = 1500) {
  if (state.shuttingDown || state.scheduledSpawn) {
    return;
  }

  state.scheduledSpawn = setTimeout(() => {
    state.scheduledSpawn = null;
    spawnDaemon();
  }, delayMs);
}

function spawnDaemon() {
  if (state.shuttingDown || state.daemonProc) {
    return;
  }

  const missing = getMissingRequiredVariables();
  if (missing.length > 0) {
    state.lastError = `Missing required variables: ${missing.join(", ")}`;
    logLine("error", state.lastError);
    return;
  }

  logLine("wrapper", `starting OpenFang with config ${CONFIG_PATH}`);

  const proc = childProcess.spawn("openfang", ["start", "--config", CONFIG_PATH], {
    env: buildDaemonEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.daemonProc = proc;
  state.daemonPid = proc.pid ?? null;
  state.daemonHealthy = false;
  state.daemonStartedAt = new Date().toISOString();
  state.daemonExitedAt = null;
  state.daemonExitCode = null;
  state.daemonSignal = null;
  state.lastError = "";

  proc.stdout.on("data", (chunk) => {
    String(chunk)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => logLine("openfang", line));
  });

  proc.stderr.on("data", (chunk) => {
    String(chunk)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => logLine("error", line));
  });

  proc.on("error", (error) => {
    state.lastError = `Failed to spawn OpenFang: ${error.message}`;
    logLine("error", state.lastError);
  });

  proc.on("exit", (code, signal) => {
    state.daemonProc = null;
    state.daemonPid = null;
    state.daemonHealthy = false;
    state.daemonExitedAt = new Date().toISOString();
    state.daemonExitCode = code;
    state.daemonSignal = signal;

    const reason = `OpenFang exited with code ${String(code)} signal ${String(signal)}`;
    state.lastError = reason;
    logLine("error", reason);

    if (state.shuttingDown) {
      return;
    }

    state.restartCount += 1;
    scheduleSpawn(2000);
  });
}

async function probeDaemon() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`${DAEMON_BASE_URL}/api/health`, {
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);

    state.daemonHealthy = response.ok;
    state.lastHealthPayload = payload;
    state.lastHealthAt = new Date().toISOString();
  } catch {
    state.daemonHealthy = false;
    state.lastHealthPayload = null;
    state.lastHealthAt = new Date().toISOString();
  } finally {
    clearTimeout(timeout);
  }
}

function restartDaemon(reason = "manual restart") {
  logLine("wrapper", reason);

  if (!state.daemonProc) {
    scheduleSpawn(0);
    return;
  }

  state.pendingRestart = true;
  const proc = state.daemonProc;
  proc.kill("SIGTERM");

  setTimeout(() => {
    if (state.daemonProc && state.daemonProc.pid === proc.pid) {
      state.daemonProc.kill("SIGKILL");
    }
  }, 5000);
}

function renderSetupUnavailablePage(message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenFang Setup Unavailable</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #08111f;
        color: #e6edf7;
        display: grid;
        min-height: 100vh;
        place-items: center;
      }
      main {
        width: min(680px, calc(100vw - 32px));
        background: rgba(9, 17, 31, 0.88);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 20px;
        padding: 28px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
      }
      a {
        color: #8ed0ff;
      }
      code {
        background: rgba(148, 163, 184, 0.16);
        border-radius: 8px;
        padding: 2px 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>OpenFang is still booting</h1>
      <p>${message}</p>
      <p>Use <a href="/setup">/setup</a> for live status, auth handoff, and advanced config.</p>
    </main>
  </body>
</html>`;
}

function renderAuthBridge(target) {
  const token = getRuntimeApiKey();
  const safeTarget = typeof target === "string" && target.startsWith("/") ? target : "/";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opening OpenFang</title>
  </head>
  <body>
    <script>
      const token = ${JSON.stringify(token)};
      const target = ${JSON.stringify(safeTarget)};
      if (token) {
        localStorage.setItem("openfang-api-key", token);
      }
      window.location.replace(target);
    </script>
  </body>
</html>`;
}

function buildStatusPayload() {
  const envStatuses = [
    {
      name: "SETUP_PASSWORD",
      configured: Boolean(SETUP_PASSWORD),
      required: true,
    },
    {
      name: "OPENFANG_API_KEY",
      configured: Boolean(getRuntimeApiKey()),
      required: true,
    },
    {
      name: "ANTHROPIC_API_KEY",
      configured: Boolean(buildDaemonEnv().ANTHROPIC_API_KEY),
      required: false,
    },
    {
      name: "OPENAI_API_KEY",
      configured: Boolean(buildDaemonEnv().OPENAI_API_KEY),
      required: false,
    },
    {
      name: "GROQ_API_KEY",
      configured: Boolean(buildDaemonEnv().GROQ_API_KEY),
      required: false,
    },
    {
      name: "GEMINI_API_KEY",
      configured: Boolean(buildDaemonEnv().GEMINI_API_KEY),
      required: false,
    },
  ];

  return {
    ok: getMissingRequiredVariables().length === 0,
    configPaths: {
      openfangHome: OPENFANG_HOME,
      config: CONFIG_PATH,
      userConfig: USER_CONFIG_PATH,
      secrets: SECRETS_PATH,
    },
    env: envStatuses,
    daemon: {
      running: Boolean(state.daemonProc),
      healthy: state.daemonHealthy,
      pid: state.daemonPid,
      startedAt: state.daemonStartedAt,
      exitedAt: state.daemonExitedAt,
      exitCode: state.daemonExitCode,
      signal: state.daemonSignal,
      restartCount: state.restartCount,
      lastHealthAt: state.lastHealthAt,
      health: state.lastHealthPayload,
      lastError: state.lastError,
    },
    logs: state.bootLogs.slice(-40),
    docs: {
      gettingStarted: "https://www.openfang.sh/docs/getting-started",
      configuration: "https://www.openfang.sh/docs/configuration",
    },
  };
}

function validateUserConfig(content) {
  const forbiddenRootKeys = ["include", "home_dir", "data_dir", "api_listen", "api_key"];

  for (const key of forbiddenRootKeys) {
    const pattern = new RegExp(`^\\s*${key}\\s*=`, "m");
    if (pattern.test(content)) {
      return `Do not set \`${key}\` in config.user.toml. That key is owned by the Railway wrapper.`;
    }
  }

  return null;
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    res.status(503).send("SETUP_PASSWORD is not configured in Railway Variables.");
    return;
  }

  const auth = parseBasicAuth(req.headers.authorization);
  if (!auth || !timingSafeEqualString(auth.password, SETUP_PASSWORD)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenFang Setup"');
    res.status(401).send("Authentication required.");
    return;
  }

  next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/setup/healthz", (_req, res) => {
  const missing = getMissingRequiredVariables();
  const childCrashed = !state.daemonProc && state.daemonExitCode !== null;
  const statusCode = missing.length > 0 || childCrashed ? 503 : 200;

  res.status(statusCode).json({
    ok: statusCode === 200,
    missing,
    daemonRunning: Boolean(state.daemonProc),
    daemonHealthy: state.daemonHealthy,
    restartCount: state.restartCount,
    lastError: state.lastError || null,
  });
});

app.use("/setup/assets", requireSetupAuth, express.static(path.join(__dirname, "public")));
app.use("/setup", requireSetupAuth);

app.get("/setup", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/setup/api/status", (_req, res) => {
  res.json(buildStatusPayload());
});

app.get("/setup/api/config", async (_req, res) => {
  const content = await fsp.readFile(USER_CONFIG_PATH, "utf8").catch(() => "");
  res.json({ content });
});

app.post("/setup/api/config", async (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  if (content === null) {
    res.status(400).json({ error: "Missing config content." });
    return;
  }

  const validationError = validateUserConfig(content);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  await fsp.writeFile(USER_CONFIG_PATH, content, "utf8");
  restartDaemon("restarting after config.user.toml update");
  res.json({ status: "saved" });
});

app.post("/setup/api/restart", (_req, res) => {
  restartDaemon("manual restart from setup page");
  res.json({ status: "restarting" });
});

app.get("/setup/open-dashboard", (req, res) => {
  const target = typeof req.query.target === "string" ? req.query.target : "/";
  res.send(renderAuthBridge(target));
});

const proxy = httpProxy.createProxyServer({
  target: DAEMON_BASE_URL,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  proxyTimeout: 120000,
});

proxy.on("error", (error, req, res) => {
  state.lastError = `proxy error: ${error.message}`;
  logLine("error", state.lastError);

  if (res && !res.headersSent) {
    res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
  }

  if (res) {
    res.end(
      renderSetupUnavailablePage(
        "The OpenFang daemon is not ready yet. Wait a few seconds and retry, or open /setup for live logs."
      )
    );
  }
});

app.use((req, res) => {
  if (!state.daemonProc && !state.daemonHealthy) {
    res
      .status(503)
      .send(
        renderSetupUnavailablePage(
          "The daemon has not finished starting yet, so the built-in dashboard is temporarily unavailable."
        )
      );
    return;
  }

  proxy.web(req, res, { target: DAEMON_BASE_URL });
});

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/setup")) {
    socket.destroy();
    return;
  }

  if (!state.daemonProc && !state.daemonHealthy) {
    socket.destroy();
    return;
  }

  proxy.ws(req, socket, head, { target: DAEMON_BASE_URL });
});

async function gracefulShutdown(signal) {
  if (state.shuttingDown) {
    return;
  }

  state.shuttingDown = true;
  logLine("wrapper", `received ${signal}, shutting down`);

  if (state.healthTimer) {
    clearInterval(state.healthTimer);
    state.healthTimer = null;
  }

  if (state.scheduledSpawn) {
    clearTimeout(state.scheduledSpawn);
    state.scheduledSpawn = null;
  }

  if (state.daemonProc) {
    state.daemonProc.kill("SIGTERM");
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

spawnDaemon();
probeDaemon().catch(() => {});
state.healthTimer = setInterval(() => {
  probeDaemon().catch(() => {});
}, 3000);

server.listen(PORT, "0.0.0.0", () => {
  logLine("wrapper", `setup available at http://0.0.0.0:${PORT}/setup`);
  logLine("wrapper", `proxying dashboard traffic to ${DAEMON_BASE_URL}`);
});

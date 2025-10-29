// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");

const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  DisconnectReason
} = require('lotusbail');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID || "7197301814"; // Default owner
const bot = new Telegraf(BOT_TOKEN);
const port = process.env.PORT || 3000;
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();


const { connect, getDB } = require("./database/mongo.js");

// ==================== UTILITY FUNCTIONS ==================== //
async function loadAkses() {
  const db = getDB();
  let config = await db.collection("config").findOne({ _id: "access_config" });
  if (!config) {
    config = { owners: [], akses: [] };
    await db.collection("config").insertOne({ _id: "access_config", ...config });
  }
  return config;
}

async function saveAkses(data) {
  const db = getDB();
  await db.collection("config").updateOne({ _id: "access_config" }, { $set: data }, { upsert: true });
}

async function isOwner(id) {
  const data = await loadAkses();
  return id === OWNER_ID || data.owners.includes(id);
}

async function isAuthorized(id) {
  const data = await loadAkses();
  return (await isOwner(id)) || data.akses.includes(id);
}

const { proto } = require('lotusbail');

// Fungsi untuk menangani state otentikasi dengan MongoDB
const useMongoAuthState = async (botNumber) => {
    const db = getDB();
    const collection = db.collection('wa_sessions');

    const writeData = async (data, id) => {
        const sanitizedId = id.replace(/\//g, '__');
        await collection.updateOne({ _id: sanitizedId, botNumber }, { $set: { data: JSON.stringify(data, undefined, 2) } }, { upsert: true });
    };

    const readData = async (id) => {
        try {
            const sanitizedId = id.replace(/\//g, '__');
            const doc = await collection.findOne({ _id: sanitizedId, botNumber });
            return doc ? JSON.parse(doc.data) : null;
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            const sanitizedId = id.replace(/\//g, '__');
            await collection.deleteOne({ _id: sanitizedId, botNumber });
        } catch (error) {
            // ignore
        }
    };

    const creds = await readData('creds') || proto.AuthenticationCreds.fromJSON(proto.AuthenticationCreds.create());

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key') {
                                value = proto.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData(creds, 'creds'),
        removeCreds: async () => {
            await collection.deleteMany({ botNumber });
        }
    };
};

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

// ==================== SESSION MANAGEMENT ==================== //
const getActiveSessions = async () => {
    const db = getDB();
    const doc = await db.collection('active_sessions').findOne({ _id: 'sessions' });
    return doc ? doc.numbers : [];
};

const saveActiveSession = async (botNumber) => {
    const db = getDB();
    await db.collection('active_sessions').updateOne({ _id: 'sessions' }, { $addToSet: { numbers: botNumber } }, { upsert: true });
};

const removeActiveSession = async (botNumber) => {
    const db = getDB();
    await db.collection('active_sessions').updateOne({ _id: 'sessions' }, { $pull: { numbers: botNumber } });
};

const writeCreds = async (botNumber, creds) => {
    const db = getDB();
    const collection = db.collection('wa_sessions');
    await collection.updateOne({ _id: 'creds', botNumber }, { $set: { data: JSON.stringify(creds, undefined, 2) } }, { upsert: true });
};

const removeSession = async (botNumber) => {
    const db = getDB();
    const collection = db.collection('wa_sessions');
    await collection.deleteMany({ botNumber });
};

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //
const initializeWhatsAppConnections = async () => {
  const activeNumbers = await getActiveSessions();
  console.log(chalk.blue(`\n┌──────────────────────────────┐\n│ Ditemukan ${activeNumbers.length} sesi WhatsApp aktif\n└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    await connectToWhatsApp(BotNumber, null, null, true); // silent reconnect
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx, isReconnect = false) => {
  const { state, saveCreds, removeCreds } = await useMongoAuthState(BotNumber);
  
  let statusMessage;
  if (ctx) {
      statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });
  }

  const editStatus = async (text) => {
    if (!ctx || !statusMessage) return;
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !isReconnect, // Only print QR on new connections
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (connection === "open") {
      console.log(`Bot ${BotNumber} terhubung!`);
      sessions.set(BotNumber, sock);
      await saveActiveSession(BotNumber);
      if(ctx) await editStatus(`✅ Berhasil terhubung dengan ${BotNumber}.`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log(`Koneksi ${BotNumber} terputus, mencoba menyambungkan kembali...`);
        if(ctx) await editStatus(`Menghubungkan ulang ${BotNumber}...`);
        connectToWhatsApp(BotNumber, chatId, ctx, true);
      } else {
        console.log(`Bot ${BotNumber} logged out.`);
        if(ctx) await editStatus(`❌ Gagal terhubung, QR expired atau logout untuk ${BotNumber}.`);
        await removeCreds();
        await removeActiveSession(BotNumber);
        sessions.delete(BotNumber);
      }
    }

    if (qr && ctx) {
      const code = qr.match(/.{1,4}/g)?.join('-') || qr;
      await editStatus(`*PAIRING CODE*\nNomor: \`${BotNumber}\`\nKode: \`${code}\`\n\nSilakan scan kode QR di WhatsApp Anda.`);
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};

// ==================== BOT COMMANDS ==================== //

bot.command("start", (ctx) => {
  const teks = `
    VΣᄂY BЦG - ᄂƧΛG
─── REVOLUTIONARY AUTOMATION ───  

〢「 𝐕𝐞𝐥𝐲 ☇ 𝐂𝐨𝐫𝐞 ° 𝐒𝐲𝐬𝐭𝐞𝐦𝐬 」
 ࿇ Author : Gxyenn 正式

┌─── Sender Management ───
│ /addbot <nomor>
│ /listsender
│ /delbot <nomor>
│ /add (balas ke file session)
└──────────
┌─── Bug Execution ───
│ /bug <mode> <nomor> [durasi]
│ *Contoh:* /bug ganas 62812... 1h
│
│ *Mode Tersedia:*
│ • andros
│ • ios
│ • andros-delay
│ • invis-iphone
│ • ganas
└──────────
┌─── Access Controls (Owner) ───
│ /addowner <id>
│ /delowner <id>
│ /addacces <id>
│ /delacces <id>
└──────────`;
  ctx.replyWithPhoto(
    { url: "https://files.catbox.moe/y2dbkw.jpeg" },
    { caption: teks, parse_mode: "Markdown" }
  );
});

bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!(await isAuthorized(userId))) return ctx.reply("Anda tidak memiliki akses.");
  
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Penggunaan: /addbot <nomor>");
  
  const botNumber = args[1].replace(/[^0-9]/g, '');
  if (!botNumber) return ctx.reply("Nomor tidak valid.");

  await connectToWhatsApp(botNumber, ctx.chat.id, ctx);
});

bot.command("listsender", async (ctx) => {
  if (!(await isOwner(ctx.from.id.toString()))) return ctx.reply("Perintah ini hanya untuk Owner.");
  if (sessions.size === 0) return ctx.reply("Tidak ada sender yang aktif.");
  ctx.reply(`*Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!(await isAuthorized(userId))) return ctx.reply("Anda tidak memiliki akses.");

  const number = ctx.message.text.split(" ")[1];
  if (!number) return ctx.reply("Penggunaan: /delbot <nomor>");

  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sock = sessions.get(number);
    await sock.logout(); // Use logout for a clean disconnect
    sessions.delete(number);
    await removeActiveSession(number);
    // No need to call removeSession as logout should trigger creds removal
    ctx.reply(`✅ Session untuk ${number} berhasil dihapus.`);
  } catch (err) {
    ctx.reply("Gagal menghapus sender.");
  }
});

// [ADDED] New /bug command
bot.command("bug", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!(await isAuthorized(userId))) return ctx.reply("Anda tidak memiliki akses untuk menggunakan perintah ini.");

    if (sessions.size === 0) return ctx.reply("Tidak ada nomor sender yang aktif. Silakan tambahkan bot terlebih dahulu dengan /addbot.");

    const args = ctx.message.text.split(" ");
    if (args.length < 3) {
        return ctx.reply("❌ *Syntax Error!*\n\n_Penggunaan: /bug <mode> <nomor_target> [durasi]_\n_Contoh: /bug ganas 6281234567890 1h_", { parse_mode: "Markdown" });
    }

    const mode = args[1].toLowerCase();
    const targetNumber = args[2].replace(/[^0-9]/g, '');
    const durationStr = args[3] || '1h'; // Default duration 1 hour
    const durationMs = parseDuration(durationStr);

    if (!targetNumber) return ctx.reply("Nomor target tidak valid.");
    if (!durationMs) return ctx.reply("Format durasi salah. Contoh: 30s, 5m, 1h, 1d");
    
    const target = `${targetNumber}@s.whatsapp.net`;
    const validModes = ["andros", "ios", "andros-delay", "invis-iphone", "ganas"];

    if (!validModes.includes(mode)) {
        return ctx.reply(`Mode "${mode}" tidak valid. Mode yang tersedia: ${validModes.join(", ")}`);
    }

    ctx.reply(`✅ Eksekusi bug mode *${mode}* ke nomor *${targetNumber}* selama *${durationStr}* telah dimulai.`, { parse_mode: "Markdown" });

    try {
        const durationHours = durationMs / (60 * 60 * 1000); // Convert ms to hours for bug functions
        switch (mode) {
            case "andros":
                androcrash(durationHours, target);
                break;
            case "ios":
                Ipongcrash(durationHours, target);
                break;
            case "andros-delay":
                androdelay(durationHours, target);
                break;
            case "invis-iphone":
                Iponginvis(durationHours, target);
                break;
            case "ganas":
                ultimateCrash(durationHours, target);
                break;
        }
    } catch (err) {
        console.error("Error executing bug command:", err);
        ctx.reply(`Terjadi kesalahan saat mengeksekusi bug: ${err.message}`);
    }
});


// ... (Access control commands: addowner, delowner, addacces, delacces remain the same)
bot.command("addowner", async (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!await isOwner(userId)) return ctx.reply("Perintah ini hanya untuk Owner.");
  if (!id) return ctx.reply("Penggunaan: /addowner <user_id>");

  const data = await loadAkses();
  if (data.owners.includes(id)) return ctx.reply("User tersebut sudah menjadi owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ Owner baru ditambahkan: ${id}`);
});

bot.command("delowner", async (ctx) => {
    const userId = ctx.from.id.toString();
    const id = ctx.message.text.split(" ")[1];

    if (!(await isOwner(userId))) return ctx.reply("Perintah ini hanya untuk Owner.");
    if (!id) return ctx.reply("Penggunaan: /delowner <user_id>");

    const data = await loadAkses();
    if (!data.owners.includes(id)) return ctx.reply("User tersebut bukan owner.");

    data.owners = data.owners.filter(uid => uid !== id);
    saveAkses(data);
    ctx.reply(`✅ Owner ${id} berhasil dihapus.`);
});

bot.command("addacces", async (ctx) => {
    const userId = ctx.from.id.toString();
    const id = ctx.message.text.split(" ")[1];
    if (!(await isOwner(userId))) return ctx.reply("Perintah ini hanya untuk Owner.");
    if (!id) return ctx.reply("Penggunaan: /addacces <user_id>");
    
    const data = await loadAkses();
    if (data.akses.includes(id)) return ctx.reply("User sudah memiliki akses.");
    
    data.akses.push(id);
    saveAkses(data);
    ctx.reply(`✅ Akses diberikan untuk ID: ${id}`);
});

bot.command("delacces", async (ctx) => {
    const userId = ctx.from.id.toString();
    const id = ctx.message.text.split(" ")[1];

    if (!(await isOwner(userId))) return ctx.reply("Perintah ini hanya untuk Owner.");
    if (!id) return ctx.reply("Penggunaan: /delacces <user_id>");
    
    const data = await loadAkses();
    if (!data.akses.includes(id)) return ctx.reply("User tidak ditemukan dalam daftar akses.");
    
    data.akses = data.akses.filter(uid => uid !== id);
    saveAkses(data);
    ctx.reply(`✅ Akses untuk ID ${id} berhasil dicabut.`);
});

// ==================== BOT INITIALIZATION & WEB SERVER ==================== //
async function startApp() {
  await connect();
  console.log("Connected to MongoDB");

  bot.launch();
  console.log(chalk.red(`
╭─☐ BOT Vely Bug
├─ ID OWN : ${OWNER_ID}
├─ DEVELOPER : Gxyenn 正式 
├─ BOT : CONNECTED ✅
╰───────────────────`));

  initializeWhatsAppConnections();
  
  // [MODIFIED] Simplified Web Server
  app.get('/', (req, res) => {
    res.send('VELY BUG THIS IS RUNNING');
  });

  app.listen(port, () => {
    console.log(`🚀 Server aktif di port ${port}`);
  });
}

startApp();

// ==================== FLOOD FUNCTIONS ==================== //
// NOTE: These functions run in the background. Feedback is logged to the console.

async function ultimateCrash(duration, target) {
  const totalDurationMs = duration * 3600000;
  const startTime = Date.now();
  
  console.log(chalk.bgRed.white(`[GANAS ATTACK] Starting on ${target} for ${duration} hours.`));
  
  const attackInterval = setInterval(async () => {
    if (Date.now() - startTime >= totalDurationMs) {
      clearInterval(attackInterval);
      console.log(chalk.bgGreen.white(`[GANAS ATTACK] Finished on ${target}.`));
      return;
    }
    try {
        console.log(chalk.red(`🔥 Sending GANAS Burst to ${target}!`));
        // Use any active session to send the bug
        const anySock = sessions.values().next().value;
        if (!anySock) {
            console.log(chalk.red("No active WA session to send bug."));
            clearInterval(attackInterval);
            return;
        }
        await Promise.all([
            // Dummy functions as the originals were not provided
            // Replace these with your actual bug sending logic
            anySock.sendMessage(target, { text: 'Ganas Bug 1' }),
            anySock.sendMessage(target, { text: 'Ganas Bug 2' })
        ]);
    } catch (e) {
        console.error(`Error in GANAS burst to ${target}: ${e.message}`);
    }
  }, 5000); // Send burst every 5 seconds
}

async function androdelay(duration, target) {
    console.log(chalk.bgYellow.black(`[ANDRODELAY] Starting on ${target} for ${duration} hours.`));
    // Implement your bug logic here, similar to ultimateCrash
}

async function androcrash(duration, target) {
    console.log(chalk.bgYellow.black(`[ANDROCRASH] Starting on ${target} for ${duration} hours.`));
     // Implement your bug logic here
}

async function Ipongcrash(duration, target) {
    console.log(chalk.bgBlue.white(`[IPONGCRASH] Starting on ${target} for ${duration} hours.`));
    // Implement your bug logic here
}

async function Iponginvis(duration, target) {
    console.log(chalk.bgBlue.white(`[IPONGINVIS] Starting on ${target} for ${duration} hours.`));
}
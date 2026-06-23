const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  makeInMemoryStore,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require('baileys');
const { default: axios } = require('axios');
const cron = require('node-cron');
const { Boom } = require('@hapi/boom');
const pinoModule = require('pino');
const logger = pinoModule({ level: 'silent' });
const fs = require('fs');
const path = require('path');
const mega = require('megajs');

const {
  serialize,
  commands,
  whatsappAutomation,
  callAutomation,
  externalPlugins,
} = require('./lib');

const config = require('./config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const express = require('express');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 8000;

const NodeCache = require('node-cache');
const groupCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
  useClones: false,
  deleteOnExpire: true,
  maxKeys: 500,
});

// ✅ Helper: key কে সবসময় string এ convert করো
function toSafeKey(key) {
  if (key === null || key === undefined) return 'null';
  if (typeof key === 'string') return key;
  if (typeof key === 'number') return String(key);
  if (typeof key === 'object') return JSON.stringify(key);
  return String(key);
}

// ✅ Safe cache wrapper
const safeCache = {
  get: (key) => {
    try {
      return groupCache.get(toSafeKey(key));
    } catch (err) {
      return undefined;
    }
  },
  set: (key, value, ttl) => {
    try {
      if (ttl !== undefined) {
        return groupCache.set(toSafeKey(key), value, ttl);
      }
      return groupCache.set(toSafeKey(key), value);
    } catch (err) {
      return false;
    }
  },
  del: (key) => {
    try {
      return groupCache.del(toSafeKey(key));
    } catch (err) {
      return 0;
    }
  },
  keys: () => {
    try {
      return groupCache.keys();
    } catch (err) {
      return [];
    }
  },
};

// --- Detect hosting platform ---
let platform =
  process.env.AWS_LAMBDA_FUNCTION_NAME?.includes('AZURE_HTTP_FUNCTIONS')
    ? 'AZURE_HTTP_FUNCTIONS'
    : process.env.PITCHER_API_BASE_URL?.includes('codesandbox')
    ? 'CODESANDBOX'
    : process.env.VERCEL
    ? 'VERCEL'
    : process.env.NETLIFY
    ? 'NETLIFY'
    : process.env.TERMUX_VERSION
    ? 'TERMUX'
    : process.env.DYNO
    ? 'HEROKU'
    : process.env.KOYEB_APP_ID
    ? 'KOYEB'
    : process.env.GITHUB_SERVER_URL
    ? 'GITHUB'
    : process.env.RENDER
    ? 'RENDER'
    : process.env.RAILWAY_SERVICE_NAME
    ? 'RAILWAY'
    : process.env.REPLIT_USER
    ? 'REPLIT'
    : process.env.SPACE_ID
    ? 'HUGGINGFACE'
    : process.env.DIGITALOCEAN_APP_NAME
    ? 'DIGITALOCEAN'
    : process.env.AWS_REGION
    ? 'AWS'
    : process.env.FLY_IO
    ? 'FLY_IO'
    : process.env.CF_PAGES
    ? 'CLOUDFLARE'
    : process.env.AZURE
    ? 'AZURE'
    : 'VPS';

// --- Web server / self-ping for free-tier hosts ---
if (platform === 'REPLIT' || platform === 'RENDER') {
  let deployedUrl = '';

  app.get('/', function (req, res) {
    if (!deployedUrl) {
      deployedUrl = req.protocol + '://' + req.get('host');
      console.log('Detected Deployed URL:', deployedUrl);
    }
    res.json({ status: 'Active', deployedUrl });
  });

  console.log('web Starting...');

  async function pingSelf() {
    if (!deployedUrl) {
      console.log('Deployed URL is not yet set.');
      return;
    }
    try {
      const response = await axios.get(deployedUrl);
      console.log('Successfully visited ' + deployedUrl + ' - Status: ' + response.status);
    } catch (err) {
      console.error('Error visiting ' + deployedUrl + ':', err.message);
    }
  }

  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log('Connected to Server -- ', PORT);
    cron.schedule('*/10 * * * * *', pingSelf);
  });
}

console.log('Running on platform: ' + platform);

if (!fs.existsSync('./lib/session')) fs.mkdirSync('./lib/session', { recursive: true });

(async function Sparky() {
  try {
    // --- Session Loader (Mega.nz) ---
    async function loadSession() {
      const sessionId = config.SESSION_ID;

      if (!sessionId) {
        throw new Error('SESSION_ID is not set in config.');
      }

      if (!sessionId.startsWith('RABBITXMD-')) {
        throw new Error('Invalid SESSION_ID format. Must start with "RABBITXMD-".');
      }

      const megaFileId = sessionId.replace('RABBITXMD-', '');
      const megaUrl = 'https://mega.nz/file/' + megaFileId;

      const megaFile = mega.File.fromURL(megaUrl);
      const downloadStream = megaFile.download();

      const chunks = [];
      for await (const chunk of downloadStream) {
        chunks.push(chunk);
      }

      const credsJson = Buffer.concat(chunks).toString('utf8');
      const creds = JSON.parse(credsJson);

      fs.writeFileSync('./lib/session/creds.json', JSON.stringify(creds, null, 2), 'utf8');
      console.log('Session loaded from Mega.');
    }

    try {
      await loadSession();
    } catch (err) {
      console.error('Session load failed:', err.message);
    }

    const { state, saveCreds } = await useMultiFileAuthState('./lib/session');
    const { version } = await fetchLatestBaileysVersion();

    const client = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      downloadHistory: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      printQRInTerminal: false,
      version,
      logger,
      getMessage: false,
      // ✅ Fix: jid কে সবসময় safe string key দিয়ে cache থেকে নাও
      cachedGroupMetadata: async (jid) => {
        try {
          return safeCache.get(jid);
        } catch (err) {
          return undefined;
        }
      },
    });

    const ownerJid =
      (config.SUDO !== '' ? config.SUDO.split(',')[0] : client.user.id.split(':')[0]) +
      '@s.whatsapp.net';

    // ✅ Fix: array key এর বদলে string key ব্যবহার করো
    const updateCheckInterval = setInterval(async () => {
      try {
        // ✅ string key দিয়ে get করো, array দিয়ে নয়
        const updates = safeCache.get('BOT_UPDATES');

        if (!updates || !updates.total || updates.total <= 0) return;

        let msg = '*_New updates available for RabbitXMD_*\n\n';
        if (Array.isArray(updates.total)) {
          updates.total.forEach((item, idx) => {
            msg += '```' + (idx + 1) + '. ' + item.name + '\n```';
          });
          await client.sendMessage(ownerJid, {
            text:
              msg +
              "\n_Type '" +
              (config.PREFIX === 'false' ? '' : config.PREFIX) +
              "update now' to update the bot._",
          });
          clearInterval(updateCheckInterval);
        }
      } catch (err) {
        // interval এ error হলে চুপ থাকো
      }
    }, 60000);

    // --- Database sync ---
    try {
      await config.DATABASE.sync;
      console.log('Database synced.');
    } catch (err) {
      console.error('Error while syncing database:', err.message);
    }

    // --- Load external plugins ---
    async function loadExternalPlugins() {
      try {
        let plugins = await externalPlugins.findAll();
        plugins.map(async (plugin) => {
          if (!fs.existsSync('./plugins/' + plugin.dataValues.name + '.js')) {
            const pluginResp = await axios.get(plugin.dataValues.url);
            if (pluginResp.status === 200) {
              console.log('Installing external plugin:', plugin.dataValues.name);
              fs.writeFileSync('./plugins/' + plugin.dataValues.name + '.js', pluginResp.data);
              require('./plugins/' + plugin.dataValues.name + '.js');
              console.log('External plugin loaded:', plugin.dataValues.name);
            }
          }
        });
      } catch (err) {
        console.error('External plugin load error:', err.message);
      }
    }

    // --- Connection updates ---
    client.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'connecting') {
        console.log('Connecting...');
      } else if (connection === 'open') {
        await loadExternalPlugins();
        console.log('Session connected!');

        try {
          const channelJid = 'Whatsapp Channel';
          await client.groupAcceptInvite(channelJid);
        } catch (err) {
          // channel join optional, error হলে skip
        }

        fs.readdirSync('./plugins')
          .filter((file) => path.extname(file) === '.js')
          .forEach((file) => {
            try {
              require('./plugins/' + file);
            } catch (err) {
              console.error('Plugin load error:', file, err.message);
            }
          });

        const startMsg =
          '*RABBITXMD STARTED!*\n\n_Mode: ' +
          config.WORK_TYPE +
          '_\n_Prefix: ' +
          config.PREFIX +
          '_\n_Version: ' +
          config.VERSION +
          '_\n_Menu Type: ' +
          config.MENU_TYPE +
          '_\n_Language: ' +
          config.LANGUAGE +
          '_\n\n*Extra Configurations*\n\n```Always online: ' +
          (config.ALWAYS_ONLINE ? '✅' : '❌') +
          '\nAuto status view: ' +
          (config.AUTO_STATUS_VIEW ? '✅' : '❌') +
          '\nAuto reject calls: ' +
          (config.CALL_BLOCK ? '✅' : '❌') +
          '\nAuto status save: ' +
          (config.SAVE_STATUS ? '✅' : '❌') +
          '\nAuto call blocker: ' +
          (config.CALL_BLOCK ? '✅' : '❌') +
          '\nAuto read messages: ' +
          (config.READ_MESSAGES ? '✅' : '❌') +
          '\nAuto status reply: ' +
          (config.STATUS_REPLY ? '✅' : '❌') +
          '\nAuto status reaction: ' +
          (config.STATUS_REACTION ? '✅' : '❌') +
          '\nPM Blocker: ' +
          (config.PM_BLOCK ? '✅' : '❌') +
          '\nPM Disabler: ' +
          (config.DISABLE_PM ? '✅' : '❌') +
          '```';

        const startMsgJid =
          (config.SUDO !== '' ? config.SUDO.split(',')[0] : client.user.id.split(':')[0]) +
          '@s.whatsapp.net';

        if (config.START_MSG) {
          await client.sendMessage(
            startMsgJid,
            {
              text: startMsg,
              contextInfo: {
                externalAdReply: {
                  title: 'RABBITXMD UPDATES',
                  body: 'RABBITXMD UPDATES',
                  sourceUrl: 'https://whatsapp.com/channel/0029Va9ZOf36rsR1Ym7O2x00',
                  mediaUrl: 'https://whatsapp.com/channel/0029Va9ZOf36rsR1Ym7O2x00',
                  mediaType: 1,
                  showAdAttribution: false,
                  renderLargerThumbnail: true,
                  thumbnailUrl: 'https://i.imgur.com/Q2UNwXR.jpg',
                },
              },
            },
            { quoted: false }
          );
        }
      } else if (connection === 'close') {
        const reasonCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reasonCode === DisconnectReason.connectionReplaced) {
          console.log('Connection replaced. Logging out...');
          await client.logout();
        } else {
          console.log('Reconnecting...');
          await sleep(3000);
          Sparky();
        }
      }
    });

    // ✅ Fix: group metadata cache করার সময় safe key ব্যবহার করো
    client.ev.on('groups.update', async (updates) => {
      for (const update of updates) {
        try {
          if (update.id) {
            safeCache.set(update.id, update);
          }
        } catch (err) {
          // cache error হলে skip
        }
      }
    });

    // ✅ Fix: group participants update এ safe cache
    client.ev.on('group-participants.update', async ({ id, participants, action }) => {
      try {
        if (id) {
          const cached = safeCache.get(id);
          if (cached) {
            safeCache.set(id, { ...cached, participants });
          }
        }
      } catch (err) {
        // cache error হলে skip
      }
    });

    // --- Incoming messages ---
    client.ev.on('messages.upsert', async (messageUpdate) => {
      let m;
      try {
        m = await serialize(JSON.parse(JSON.stringify(messageUpdate.messages[0])), client);
      } catch (err) {
        console.error('Error serializing message:', err.message);
        return;
      }

      await whatsappAutomation(client, m, messageUpdate);

      if (config.DISABLE_PM && !m.isGroup) return;

      commands.forEach(async (command) => {
        if (command.fromMe && !m.fromMe) return;

        let args;
        try {
          if (command.on) {
            command.function({ m, args: m.body, client });
          } else if (command.name && command.name.test(m.body || '')) {
            args = (m.body || '').replace(command.name, '$1').trim();
            command.function({ m, args, client });
          }
        } catch (err) {
          console.error('Command error:', err.message);
        }
      });
    });

    // --- Save credentials ---
    client.ev.on('creds.update', saveCreds);

    // --- Call automation ---
    client.ev.on('call', async (calls) => {
      for (let call of calls) {
        await callAutomation(client, call);
      }
    });

  } catch (err) {
    console.error('Error:', err.message);
    await sleep(3000);
    Sparky();
  }
})();

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

// --- Web server / self-ping for free-tier hosts (Render/Replit etc.) ---
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
      console.log('Successfully visited ' + deployedUrl + ' - Status code: ' + response.status);
    } catch (err) {
      console.error('Error visiting ' + deployedUrl + ':', err);
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
    // --- RabbitXMD Session Loader (Mega.nz only) ---
    async function loadSession() {
      const sessionId = config.SESSION_ID;

      if (!sessionId) {
        throw new Error('SESSION_ID is not set in config.');
      }

      if (!sessionId.startsWith('RABBITXMD-')) {
        throw new Error('Invalid SESSION_ID format. It must start with "RABBITXMD-".');
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

      console.log('RabbitXMD session loaded from Mega.');
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
      cachedGroupMetadata: async (jid) => groupCache.get(jid),
    });

    const ownerJid =
      (config.SUDO !== '' ? config.SUDO.split(',')[0] : client.user.id.split(':')[0]) +
      '@s.whatsapp.net';

    // --- Periodic "update available" checker (runs once then clears) ---
    const updateCheckInterval = setInterval(async () => {
      await groupCache.keys(); // (kept from original; placeholder timer tick)
      const updates = await groupCache.get(['LOGS', 'X', 'BOT']); // placeholder; replace with real update source
      let msg = '*_New updates available for RabbitXMD_*\n\n';
      updates?.total?.forEach?.((item, idx) => {
        msg += '```' + (idx + 1 + '. ' + item.name + '\n') + '```';
      });
      if (updates?.total > 0) {
        await client.sendMessage(ownerJid, {
          text:
            msg +
            ("\n_Type '" +
              (config.PREFIX === 'false' ? '' : config.PREFIX) +
              "update now' to update the bot._"),
        });
        clearInterval(updateCheckInterval);
      }
    }, 60000);

    // --- Database sync ---
    try {
      await config.DATABASE.sync;
      console.log('Database synced.');
    } catch (err) {
      console.error('Error while syncing database:', err);
    }

    // --- Load external plugins ---
    async function loadExternalPlugins() {
      try {
        let plugins = await externalPlugins.findAll();
        plugins.map(async (plugin) => {
          if (!fs.existsSync('./plugins/' + plugin.dataValues.name + '.js')) {
            const pluginResp = await axios.get(plugin.dataValues.url);
            if (pluginResp.status == 200) {
              console.log('Installing external plugins...');
              fs.writeFileSync('./plugins/' + plugin.dataValues.name + '.js', pluginResp.data);
              require('./plugins/' + plugin.dataValues.name + '.js');
              console.log('External plugins loaded successfully.');
            }
          }
        });
      } catch (err) {
        console.log(err);
      }
    }

    // --- Connection updates ---
    client.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'connecting') {
        console.log('Connecting...');
      } else if (connection === 'open') {
        await loadExternalPlugins();
        console.log('Session connected and session files saved.');

        try {
          const channelJid = 'Whatsapp Channel'; // placeholder original obfuscated value
          await client.groupAcceptInvite(channelJid);
        } catch (err) {
          console.error('❌ Error while joining group or following channel:', err.message);
        }

        fs.readdirSync('./plugins')
          .filter((file) => path.extname(file) === '.js')
          .forEach((file) => require('./plugins/' + file));

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

        if (config.START_MSG)
          return await client.sendMessage(
            startMsgJid,
            {
              text: startMsg,
              contextInfo: {
                externalAdReply: {
                  title: 'RABBITXMD UPDATES ',
                  body: 'RABBITXMD UPDATES ',
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
      } else if (connection === 'close') {
        const reasonCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reasonCode === DisconnectReason.connectionReplaced) {
          console.log('Connection replaced. Logout current session first.');
          await client.logout();
        } else {
          console.log('Reconnecting...');
          await sleep(3000);
          Sparky();
        }
      }
    });

    // --- Incoming messages ---
    client.ev.on('messages.upsert', async (messageUpdate) => {
      let m;
      try {
        m = await serialize(JSON.parse(JSON.stringify(messageUpdate.messages[0])), client);
      } catch (err) {
        console.error('Error serializing message:', err);
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
          console.log(err);
        }
      });
    });

    // --- Save credentials on update ---
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

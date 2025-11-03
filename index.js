const express = require('express');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const os = require('os');

const app = express();

const ZIP_CODE = process.env.ZIP_CODE || '90210';
const WS4KP_HOST = process.env.WS4KP_HOST || 'localhost';
const WS4KP_PORT = process.env.WS4KP_PORT || '8080';
const STREAM_PORT = process.env.STREAM_PORT || '9798';
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`;
const HLS_SETUP_DELAY = 2000;
const FRAME_RATE = process.env.FRAME_RATE || 10;
const chnlNum = process.env.CHANNEL_NUMBER || '275';

// Idle behavior
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '60000', 10);
const IDLE_KEEP_ALIVE = (process.env.IDLE_KEEP_ALIVE || 'true') === 'true'; // when true, keep ffmpeg running and throttle captures instead of stopping
const IDLE_CAPTURE_MS = parseInt(process.env.IDLE_CAPTURE_MS || '1000', 10); // capture interval when idle (ms)

const OUTPUT_DIR = path.join(__dirname, 'output');
const AUDIO_DIR = path.join(__dirname, 'music');
const LOGO_DIR = path.join(__dirname, 'logo');
const HLS_FILE = path.join(OUTPUT_DIR, 'stream.m3u8');

// Ensure directories exist
[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

app.use('/logo', express.static(LOGO_DIR));

// State
let ffmpegProc = null;
let ffmpegStream = null;
let browser = null;
let page = null;
let captureInterval = null;
let isStreamReady = false;
let lastScreenshot = null; // Keep last successful frame to maintain continuity
let startingPromise = null; // to prevent concurrent startTranscoding runs
let idleTimer = null;
let lastClientTime = 0;
let idleMode = false;
let setCaptureRate = null; // function assigned in startTranscoding to change capture interval

const waitFor = ms => new Promise(resolve => setTimeout(resolve, ms));

function getContainerLimits() {
  let cpuQuotaPath = '/sys/fs/cgroup/cpu.max';
  let memLimitPath = '/sys/fs/cgroup/memory.max';
  let cpus = os.cpus().length;
  let memory = os.totalmem();

  try {
    const [quota, period] = fs.readFileSync(cpuQuotaPath, 'utf8').trim().split(' ');
    if (quota !== 'max') {
      cpus = parseFloat((parseInt(quota) / parseInt(period)).toFixed(2));
    }
  } catch {}

  try {
    const raw = fs.readFileSync(memLimitPath, 'utf8').trim();
    if (raw !== 'max') {
      memory = parseInt(raw);
    }
  } catch {}

  return { cpus, memoryMB: Math.round(memory / (1024 * 1024)) };
}

function createAudioInputFile() {
  // Default MP3 files to use if AUDIO_DIR is empty or inaccessible
  const defaultMp3s = [
    '01 Weatherscan Track 26.mp3',
    '02 Weatherscan Track 3.mp3',
    '03 Tropical Breeze.mp3',
    '04 Late Nite Cafe.mp3',
    '05 Care Free.mp3',
    '06 Weatherscan Track 14.mp3',
    '07 Weatherscan Track 18.mp3'
  ];

  let files = [];
  try {
    // Read only MP3 files from AUDIO_DIR
    files = fs.readdirSync(AUDIO_DIR).filter(file => file.toLowerCase().endsWith('.mp3'));
    if (files.length === 0) {
      console.warn('No MP3 files found in music directory; using default music list');
      files = defaultMp3s;
    }
  } catch (err) {
    console.error(`Failed to read music directory: ${err.message}`);
    console.warn('Using default music list due to error');
    files = defaultMp3s;
  }

  console.log(`Loaded ${files.length} music files`);
  const audioList = files.map(file => `file '${path.join(AUDIO_DIR, file)}'`).join('\n');
  fs.writeFileSync(path.join(__dirname, 'audio_list.txt'), audioList);

  // Note: Update README to inform users they can add MP3 files to the 'music' folder
  // and that the default files (listed above) are used if no MP3s are found.
}

function generateXMLTV(host) {
  const now = new Date();
  const baseUrl = `http://${host}`;
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<channel id="WS4000">
<display-name>WeatherStar 4000</display-name>
<icon src="${baseUrl}/logo/ws4000.png" />
</channel>`;

  for (let i = 0; i < 24; i++) {
    const startTime = new Date(now.getTime() + i * 3600 * 1000);
    const endTime = new Date(startTime.getTime() + 3600 * 1000);
    const start = startTime.toISOString().replace(/[-:T]/g, '').split('.')[0] + ' +0000';
    const end = endTime.toISOString().replace(/[-:T]/g, '').split('.')[0] + ' +0000';
    xml += `
<programme start="${start}" end="${end}" channel="WS4000">
<title lang="en">Local Weather</title>
<desc lang="en">Enjoy your local weather with a touch of nostalgia.</desc>
<icon src="${baseUrl}/logo/ws4000.png" />
</programme>`;
  }

  xml += `</tv>`;
  return xml;
}

async function startBrowser() {
  if (browser) await browser.close().catch(() => {});

  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--ignore-certificate-errors',
      '--window-size=1280,720'
    ],
    defaultViewport: null
  });

  page = await browser.newPage();
  await page.goto(WS4KP_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  try {
    const zipInput = await page.waitForSelector('input[placeholder="Zip or City, State"], input', { timeout: 5000 });
    if (zipInput) {
      await zipInput.type(ZIP_CODE, { delay: 100 });
      await waitFor(1000);
      await page.keyboard.press('ArrowDown');
      await waitFor(500);
      const goButton = await page.$('button[type="submit"]');
      if (goButton) await goButton.click();
      else await zipInput.press('Enter');
      await page.waitForSelector('div.weather-display, #weather-content', { timeout: 30000 });
    }
  } catch {}

  await page.setViewport({ width: 1280, height: 720 });
}

function cleanOutputDir() {
  try {
    const files = fs.readdirSync(OUTPUT_DIR);
    for (const f of files) {
      if (f.endsWith('.m3u8') || f.endsWith('.ts') || f.endsWith('.key')) {
        try { fs.unlinkSync(path.join(OUTPUT_DIR, f)); } catch (e) {}
      }
    }
  } catch (e) {
    console.warn('cleanOutputDir error:', e.message || e);
  }
}

async function startTranscoding() {
  // ensure only one startTranscoding runs at once
  if (startingPromise) return startingPromise;
  startingPromise = (async () => {
    // remove leftover HLS files from previous runs so clients don't get old segments
    cleanOutputDir();

    await startBrowser();
    createAudioInputFile();

    ffmpegStream = new PassThrough();

    // Keep ffmpeg running and generate PTS for image2pipe input so timelines are continuous.
    ffmpegProc = ffmpeg()
      .input(ffmpegStream)
      .inputFormat('image2pipe')
      .inputOptions([`-framerate ${FRAME_RATE}`, '-fflags +genpts'])
      .input(path.join(__dirname, 'audio_list.txt'))
      .inputOptions(['-f concat', '-safe 0', '-stream_loop -1'])
      .complexFilter([
        '[0:v]scale=1280:720[v]',
        '[1:a]volume=0.5[a]'
      ])
      .outputOptions([
        '-map [v]',
        '-map [a]',
        '-c:v libx264',
        '-c:a aac',
        '-b:a 128k',
        '-preset ultrafast',
        '-b:v 1000k',
        '-f hls',
        '-hls_time 2',
        '-hls_list_size 3', // keep a small sliding window
        '-hls_flags delete_segments' // ensure old segments are deleted by FFmpeg
      ])
      .output(HLS_FILE)
      .on('start', () => {
        console.log('Started FFmpeg');
        setTimeout(() => isStreamReady = true, HLS_SETUP_DELAY);
      })
      .on('error', async (err) => {
        console.error('FFmpeg error:', err);
        // teardown and allow subsequent requests to restart after a short delay
        await stopTranscoding();
        setTimeout(() => { startingPromise = null; }, 2000);
      })
      .on('end', () => {
        ffmpegProc = null;
        ffmpegStream = null;
        isStreamReady = false;
        startingPromise = null;
      });

    // captureLoop defined here but referenced externally via setCaptureRate
    async function captureLoopFn() {
      if (!ffmpegProc || !ffmpegStream) return;
      try {
        if (!page || (typeof page.isClosed === 'function' && await page.isClosed())) {
          console.warn('Page closed or unavailable — restarting browser');
          await startBrowser();
          return;
        }
        const screenshot = await page.screenshot({
          type: 'jpeg',
          clip: { x: 4, y: 47, width: 631, height: 480 }
        });
        lastScreenshot = screenshot;
        const ok = ffmpegStream.write(screenshot);
        if (!ok) {
          // backpressure: wait a tick to avoid excessive memory growth
          await new Promise(resolve => ffmpegStream.once('drain', resolve));
        }
      } catch (err) {
        console.error('Screenshot capture failed:', err.message || err);
        // If we have a last good frame, write it to keep FFmpeg timeline continuous.
        if (lastScreenshot && ffmpegStream) {
          try {
            ffmpegStream.write(lastScreenshot);
          } catch (e) {
            console.error('Failed to write lastScreenshot:', e.message || e);
          }
        } else {
          // No last frame available — wait briefly and try again.
          await waitFor(500);
        }
      }
    }

    // allow external rate changes by assigning setCaptureRate here
    setCaptureRate = (ms) => {
      if (captureInterval) clearInterval(captureInterval);
      captureInterval = setInterval(captureLoopFn, ms);
    };

    // Start at normal capture rate
    setCaptureRate(Math.max(20, Math.round(1000 / FRAME_RATE)));

    ffmpegProc.run();

    // startingPromise resolves once ffmpegProc exists (not necessarily isStreamReady)
    startingPromise = null;
  })().catch(err => {
    startingPromise = null;
    throw err;
  });

  return startingPromise;
}

async function enterIdleMode() {
  if (!IDLE_KEEP_ALIVE) {
    // default behavior is to fully stop
    return stopTranscoding();
  }
  if (idleMode) return;
  idleMode = true;
  console.log('Entering idle mode — throttling captures to save CPU but keeping FFmpeg alive');
  try {
    if (typeof setCaptureRate === 'function') {
      setCaptureRate(Math.max(200, IDLE_CAPTURE_MS)); // e.g. 1 fps or as configured
    }
  } catch (e) {
    console.error('Failed to switch to idle capture rate:', e.message || e);
  }
}

async function exitIdleMode() {
  if (!idleMode) return;
  idleMode = false;
  console.log('Exiting idle mode — restoring normal capture rate');
  try {
    if (typeof setCaptureRate === 'function') {
      setCaptureRate(Math.max(20, Math.round(1000 / FRAME_RATE)));
    }
  } catch (e) {
    console.error('Failed to restore capture rate:', e.message || e);
  }
}

async function stopTranscoding() {
  if (captureInterval) clearInterval(captureInterval);
  captureInterval = null;
  isStreamReady = false;

  if (ffmpegProc) {
    try {
      ffmpegProc.kill('SIGINT');
    } catch (e) {
      console.error('Error killing FFmpeg process:', e.message || e);
    }
    ffmpegProc = null;
  }

  if (ffmpegStream) {
    try {
      ffmpegStream.end();
    } catch (e) {}
    ffmpegStream = null;
  }

  lastScreenshot = null;
  idleMode = false;

  if (browser) await browser.close().catch(() => {});
  browser = null;
  page = null;
}

// Ensure transcoding runs on-demand and schedule idle stop
async function ensureTranscodingRunning(awaitReady = false, waitMs = 5000) {
  lastClientTime = Date.now();
  scheduleIdleStop();

  // if ffmpeg running but idle mode active, wake it
  if (ffmpegProc && idleMode) {
    await exitIdleMode();
  }

  if (ffmpegProc) {
    if (awaitReady) {
      const start = Date.now();
      while (!isStreamReady && Date.now() - start < waitMs) {
        await waitFor(100);
      }
    }
    return;
  }

  // start it
  try {
    await startTranscoding();
  } catch (e) {
    console.error('Failed to start transcoding:', e);
    return;
  }

  if (awaitReady) {
    const start = Date.now();
    while (!isStreamReady && Date.now() - start < waitMs) {
      await waitFor(100);
    }
  }
}

function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const idleDuration = Date.now() - lastClientTime;
    if (idleDuration >= IDLE_TIMEOUT_MS) {
      if (IDLE_KEEP_ALIVE) {
        // throttle captures instead of stopping ffmpeg
        await enterIdleMode();
      } else {
        console.log('No clients for', IDLE_TIMEOUT_MS, 'ms — stopping transcoding to avoid stale segments');
        await stopTranscoding();
        // remove leftover files to ensure next start doesn't serve old segments
        cleanOutputDir();
      }
    } else {
      scheduleIdleStop();
    }
  }, IDLE_TIMEOUT_MS + 1000);
}

// Serve playlist and ensure we start transcoding on demand. Wait briefly for playlist to be ready.
app.get('/playlist.m3u', async (req, res) => {
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  const baseUrl = `http://${host}`;

  // start transcoding and wait for the HLS playlist to be produced (best-effort)
  await ensureTranscodingRunning(true, 5000);

  const m3uContent = `#EXTM3U
#EXTINF:-1 channel-id="WS4000" tvg-id="WS4000" tvg-chno="${chnlNum}" tvc-guide-placeholders="3600" tvc-guide-title="Local Weather" tvc-guide-description="Enjoy your local weather with a touch of nostalgia." tvc-guide-art="${baseUrl}/logo/ws4000.png" tvg-logo="${baseUrl}/logo/ws4000.png",WeatherStar 4000
${baseUrl}/stream/stream.m3u8
`;
  res.set('Content-Type', 'application/x-mpegURL');
  res.send(m3uContent);
});

app.get('/guide.xml', (req, res) => {
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  res.set('Content-Type', 'application/xml');
  res.send(generateXMLTV(host));
});

app.get('/health', (req, res) => {
  res.status(isStreamReady ? 200 : 503).json({ ready: isStreamReady });
});

// Middleware: start transcoding on any request to /stream/* (segments or playlist)
app.use('/stream', async (req, res, next) => {
  // update client activity and ensure transcoding is running; don't block segments too long
  lastClientTime = Date.now();
  scheduleIdleStop();
  try {
    // start but don't wait long for readiness when serving segments
    await ensureTranscodingRunning(false);
  } catch (e) {
    console.error('Error ensuring transcoding for stream request:', e);
  }
  next();
}, express.static(OUTPUT_DIR));

const { cpus, memoryMB } = getContainerLimits();
console.log(`Running with ${cpus} CPU cores, ${memoryMB}MB RAM`);

app.listen(STREAM_PORT, () => {
  console.log(`Streaming server running on port ${STREAM_PORT}`);
  // Do not start transcoding automatically on startup.
  // It will be started on-demand when a client requests /playlist.m3u or /stream/*
});

process.on('SIGINT', async () => {
  console.log('SIGINT received');
  await stopTranscoding();
  process.exit();
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received');
  await stopTranscoding();
  process.exit();
});

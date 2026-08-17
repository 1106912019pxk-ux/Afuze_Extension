#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import vm from 'node:vm';

const DEFAULT_ROOM = '6657';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const options = {
    roomId: DEFAULT_ROOM,
    rate: '-1',
    check: false,
    noUrl: false,
  };

  for (const arg of argv) {
    if (/^\d+$/.test(arg)) {
      options.roomId = arg;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--no-url') {
      options.noUrl = true;
    } else if (arg.startsWith('--rate=')) {
      options.rate = arg.slice('--rate='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node douyu.mjs [roomId] [--check] [--rate=-1] [--no-url]\n\nExamples:\n  node douyu.mjs\n  node douyu.mjs 6657\n  node douyu.mjs 6657 --check`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.text();
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 160)}`);
  }
}

async function getRoomInfo(roomId) {
  const data = await fetchJson(`https://www.douyu.com/betard/${roomId}`, {
    headers: {
      Referer: `https://www.douyu.com/${roomId}`,
    },
  });

  if (!data?.room) {
    throw new Error(`Room ${roomId} was not found in /betard response`);
  }

  return data.room;
}

async function getSignScript(primaryRoomId, fallbackRoomId) {
  const candidates = [...new Set([primaryRoomId, fallbackRoomId].filter(Boolean).map(String))];

  for (const roomId of candidates) {
    const data = await fetchJson(`https://www.douyu.com/swf_api/homeH5Enc?rids=${roomId}`, {
      headers: {
        Referer: `https://www.douyu.com/${fallbackRoomId || roomId}`,
      },
    });

    const script = data?.data?.[`room${roomId}`];
    if (script) {
      return script;
    }
  }

  throw new Error('Douyu did not return the H5 signing script');
}

function makeSign(signScript, realRoomId) {
  const did = randomBytes(16).toString('hex');
  const timestamp = Math.round(Date.now() / 1000).toString();

  // Douyu's current H5 signing function uses CryptoJS.MD5.  A complete
  // crypto-js dependency is unnecessary here: Node's built-in MD5 is enough.
  const sandbox = {
    CryptoJS: {
      MD5(value) {
        return createHash('md5').update(String(value)).digest('hex');
      },
    },
  };

  vm.createContext(sandbox);
  new vm.Script(signScript, { filename: 'douyu-sign.js' }).runInContext(sandbox, {
    timeout: 1500,
  });

  if (typeof sandbox.ub98484234 !== 'function') {
    throw new Error('Signing function ub98484234 was not created');
  }

  const result = sandbox.ub98484234(String(realRoomId), did, timestamp);
  if (typeof result !== 'string' || !result.includes('=')) {
    throw new Error(`Unexpected signing result: ${String(result).slice(0, 120)}`);
  }

  return new URLSearchParams(result);
}

async function getPlayData(requestRoomId, realRoomId, signParams, rate) {
  const body = new URLSearchParams(signParams);
  body.set('cdn', '');
  body.set('rate', String(rate));
  body.set('ver', 'Douyu_226050601');
  body.set('iar', '1');
  body.set('ive', '1');
  body.set('hevc', '0');
  body.set('fa', '0');

  // Prefer the canonical numeric room id, then fall back to the public/alias id.
  const endpoints = [...new Set([realRoomId, requestRoomId].map(String))];
  let lastError;

  for (const endpointRoomId of endpoints) {
    try {
      const result = await fetchJson(
        `https://www.douyu.com/lapi/live/getH5Play/${endpointRoomId}`,
        {
          method: 'POST',
          headers: {
            Referer: `https://www.douyu.com/${requestRoomId}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body: body.toString(),
        },
      );

      if (result?.error === 0 && result?.data?.rtmp_url && result?.data?.rtmp_live) {
        return result.data;
      }

      lastError = new Error(
        `getH5Play(${endpointRoomId}) error=${result?.error}, msg=${result?.msg || 'unknown'}`,
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to get Douyu play data');
}

function buildStreamUrl(playData) {
  const base = String(playData.rtmp_url).replace(/\/$/, '');
  const live = String(playData.rtmp_live).replaceAll('&amp;', '&');
  return `${base}/${live}`;
}

async function checkDirectStream(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    // Deliberately do NOT send a Douyu Referer here.  Afuze normally receives
    // only the URL, so this test checks whether the CDN URL is truly direct.
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Range: 'bytes=0-1023',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        reason: `${response.status} ${response.statusText}`,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        ok: true,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        firstBytes: '',
      };
    }

    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    const bytes = value || new Uint8Array();
    const firstBytes = Buffer.from(bytes.slice(0, 8)).toString('hex');
    const isFlv = bytes.length >= 3 && bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56;

    return {
      ok: true,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      firstBytes,
      isFlv,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const room = await getRoomInfo(options.roomId);
  const realRoomId = String(room.room_id || options.roomId);

  if (Number(room.show_status) !== 1) {
    console.log(`Room: ${options.roomId} -> ${realRoomId}`);
    console.log(`Anchor: ${room.owner_name || '-'}`);
    console.log(`Title: ${room.room_name || '-'}`);
    console.log('Status: OFFLINE');
    process.exitCode = 2;
    return;
  }

  if (Number(room.videoLoop) === 1) {
    throw new Error('The room is currently replaying VOD instead of a real live stream');
  }

  const signScript = await getSignScript(realRoomId, options.roomId);
  const signParams = makeSign(signScript, realRoomId);
  const playData = await getPlayData(options.roomId, realRoomId, signParams, options.rate);
  const streamUrl = buildStreamUrl(playData);

  console.log(`Room: ${options.roomId} -> ${realRoomId}`);
  console.log(`Anchor: ${room.owner_name || '-'}`);
  console.log(`Title: ${room.room_name || '-'}`);
  console.log('Status: LIVE');
  console.log(`Rate: ${playData.rate ?? options.rate}`);
  console.log(`CDN: ${playData.rtmp_cdn || '-'}`);
  console.log(`Format: ${/\.flv(?:\?|$)/i.test(streamUrl) ? 'FLV' : 'unknown'}`);

  if (options.check) {
    const result = await checkDirectStream(streamUrl);
    if (result.ok) {
      console.log(
        `Direct check: OK (HTTP ${result.status}, ${result.contentType || 'no content-type'}${
          result.isFlv === true ? ', FLV header OK' : ''
        })`,
      );
    } else {
      console.log(`Direct check: FAILED (${result.reason || 'unknown'})`);
      process.exitCode = 3;
    }
  }

  if (!options.noUrl) {
    console.log('\nAfuze stream URL:');
    console.log(streamUrl);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});

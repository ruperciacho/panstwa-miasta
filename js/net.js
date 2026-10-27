// Warstwa komunikacji. Dwa warianty o tym samym interfejsie:
//  - Supabase Realtime (produkcja): broadcast + presence na kanale gry,
//  - BroadcastChannel (tryb ?local): karty jednej przeglądarki — do testów bez internetu.
//
// Interfejs: createTransport({ code, me, local, onMessage, onPresence, onStatus })
//   → { send(msg), close() }
// onPresence dostaje tablicę id graczy, którzy są teraz połączeni (łącznie z nami).

import { CONFIG } from './config.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    clientPromise = import(SUPABASE_ESM).then(({ createClient }) =>
      createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 20 } },
      }));
  }
  return clientPromise;
}

export async function createTransport(opts) {
  return opts.local ? localTransport(opts) : supabaseTransport(opts);
}

async function supabaseTransport({ code, me, onMessage, onPresence, onStatus }) {
  let client;
  try {
    client = await getClient();
  } catch (e) {
    onStatus('LOAD_ERROR', e);
    throw e;
  }
  const channel = client.channel(CONFIG.CHANNEL_PREFIX + code, {
    config: { broadcast: { self: false, ack: false }, presence: { key: me.id } },
  });
  channel.on('broadcast', { event: 'm' }, ({ payload }) => payload && onMessage(payload));
  channel.on('presence', { event: 'sync' }, () => onPresence(Object.keys(channel.presenceState())));
  channel.subscribe(async (status, err) => {
    // Callback odpala się także po każdym ponownym połączeniu — wtedy ponownie zgłaszamy obecność.
    if (status === 'SUBSCRIBED') {
      try { await channel.track({ name: me.name }); } catch { /* spróbujemy przy kolejnym połączeniu */ }
    }
    onStatus(status, err);
  });
  return {
    send(msg) {
      return channel.send({ type: 'broadcast', event: 'm', payload: { ...msg, from: me.id } });
    },
    close() {
      try { channel.untrack(); } catch { /* ignore */ }
      client.removeChannel(channel);
    },
  };
}

function localTransport({ code, me, onMessage, onPresence, onStatus }) {
  const bc = new BroadcastChannel('pm-local-' + code);
  const seen = new Map();
  const emit = () => onPresence([me.id, ...seen.keys()]);
  const ping = () => bc.postMessage({ __presence: 1, from: me.id });
  bc.onmessage = (e) => {
    const m = e.data;
    if (m && m.__presence) {
      const isNew = !seen.has(m.from);
      if (m.bye) seen.delete(m.from);
      else seen.set(m.from, Date.now());
      if (isNew || m.bye) {
        emit();
        if (isNew) ping(); // przedstaw się nowemu
      }
      return;
    }
    if (m) onMessage(m);
  };
  const timer = setInterval(() => {
    ping();
    const now = Date.now();
    let changed = false;
    for (const [id, t] of seen) if (now - t > 3500) { seen.delete(id); changed = true; }
    if (changed) emit();
  }, 1000);
  setTimeout(() => { onStatus('SUBSCRIBED'); ping(); emit(); }, 30);
  return {
    send(msg) { bc.postMessage({ ...msg, from: me.id }); },
    close() {
      clearInterval(timer);
      bc.postMessage({ __presence: 1, from: me.id, bye: 1 });
      bc.close();
    },
  };
}

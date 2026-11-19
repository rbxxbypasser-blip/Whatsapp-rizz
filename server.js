// RizzMate - single file backend. Env: APP_PASSWORD, SESSION_SECRET, VENICE_API_KEY
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import QRCode from 'qrcode'
import pino from 'pino'
import makeWASocket, {
  BufferJSON, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, proto
} from '@whiskeysockets/baileys'

/* ---------------- store ---------------- */
const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data')
fs.mkdirSync(DATA, { recursive: true })
const SESSION = path.join(DATA, 'session.json')
const F = {
  contacts: path.join(DATA, 'contacts.json'),
  settings: path.join(DATA, 'settings.json'),
  hist: path.join(DATA, 'history.json'),
  logs: path.join(DATA, 'logs.json')
}
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const wr = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f) }

const DEFAULTS = {
  myName: 'Alex',
  model: process.env.VENICE_MODEL || 'venice-uncensored',
  masterOn: true,
  replyToGroups: false,
  maxReplyChars: 200,
  delayMin: 1200,
  delayMax: 4500,
  contextMessages: 16,
  maxBubbles: 2,
  messiness: 65
}

const state = {
  contacts: rd(F.contacts, {}),
  settings: { ...DEFAULTS, ...rd(F.settings, {}) },
  hist: rd(F.hist, {}),
  logs: rd(F.logs, [])
}

const saveContacts = () => wr(F.contacts, state.contacts)
const saveSettings = () => wr(F.settings, state.settings)

function log(kind, text, jid = null) {
  state.logs.unshift({ ts: Date.now(), kind, text, jid })
  if (state.logs.length > 400) state.logs.length = 400
  wr(F.logs, state.logs)
}

function push(jid, role, text) {
  ;(state.hist[jid] ||= []).push({ role, text, ts: Date.now() })
  const cap = Math.max(30, state.settings.contextMessages * 2)
  if (state.hist[jid].length > cap) state.hist[jid] = state.hist[jid].slice(-cap)
  wr(F.hist, state.hist)
}

const histOf = (jid) => (state.hist[jid] || []).slice(-state.settings.contextMessages)

function contact(jid, extra = {}) {
  if (!state.contacts[jid]) {
    state.contacts[jid] = {
      jid,
      name: extra.name || extra.notify || jid.split('@')[0],
      rizz: false,
      goal: 'get her to agree to a date this week',
      tone: 'playful, teasing, unbothered',
      lastMsg: '',
      lastMsgAt: 0,
      lastReplyAt: 0,
      sentCount: 0
    }
  }
  return state.contacts[jid]
}

/* ---------------- ai ---------------- */
const BASE = (process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1').replace(/\/+$/, '')

function clean(raw, max) {
  let t = (raw || '').trim()
  t = t.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '')
  t = t.replace(/^["“'‘](.*)["”'’]$/s, '$1')
  t = t.replace(/^(me|you|reply|assistant)\s*:\s*/i, '')
  t = t.replace(/\s*[—–]\s*/g, ' - ')
  t = t.replace(/[ \t]{2,}/g, ' ').trim()
  t = t.replace(/(?<![.!?…])\.$/, '')
  if (t.length > max) {
    const cut = t.slice(0, max)
    const sp = cut.lastIndexOf(' ')
    t = sp > max * 0.6 ? cut.slice(0, sp) : cut
  }
  return t
}

function systemPrompt(c, s, hint, askedRecently) {
  return `you are ${s.myName}, texting on whatsapp. a real guy. nobody knows there is software involved.

the important part: you are NOT a perfect texter. you do not always have the right line. you are not always funny. sometimes you are dry, blunt, low effort, or a bit off. real people are inconsistent - be inconsistent.

how you text:
- SHORT. usually 3-12 words. sometimes one word.
- lowercase almost always. drop apostrophes sometimes (dont, im, thats). no full stop at the end.
- emoji are occasional, not decoration. maybe 4 in 10 messages. never more than 2. never the same one twice in a row.
- no em dashes, no semicolons, no markdown, no lists.
- react to her message, dont restate it back at her.
- mirror her length. 3 words in, 3-8 words out.
- if she is dry, be dry back. dont over-perform to rescue the conversation.
- sometimes change the subject abruptly, like a real person.
- a small typo now and then is good. dont overdo it.
- never say you are an ai, never explain yourself.

flirting:
- confident, teasing, unbothered. never eager.
- compliment then undercut it.
- call her out when she is boring.
- escalate only when she gives you something to escalate on.
- no pet names unless she starts it.

${askedRecently ? 'your last few replies all ended in a question. do not ask one this time.' : ''}
this reply: ${hint}
goal with her: ${c.goal || 'keep her interested'}
tone: ${c.tone || 'playful'}

output only the message text. no quotes, no name prefix, no explanation.`
}

async function chat(messages, maxTokens = 140) {
  const key = process.env.VENICE_API_KEY
  if (!key) throw new Error('VENICE_API_KEY not set')
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: state.settings.model,
      messages,
      temperature: 1.05,
      max_tokens: maxTokens,
      venice_parameters: { include_venice_system_prompt: false }
    })
  })
  if (!res.ok) throw new Error(`venice ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const d = await res.json()
  return (d.choices?.[0]?.message?.content || '').trim()
}

const DRY = /^(lol|lmao|haha|hehe|ok|okay|k|yeah|yea|yep|fr|true|👍|😂|😭|💀|🙂)$/i

function rollMood(herText) {
  const m = state.settings.messiness / 100
  const dry = DRY.test(herText.trim())
  if (dry && Math.random() < 0.2 * m) return { skip: true }

  const mood = { skip: false, hint: 'normal reply, keep it short', max: state.settings.maxReplyChars, double: Math.random() < 0.12 * m }
  const r = Math.random()

  if (r < 0.2 * m) {
    mood.hint = 'dry and low effort. 2-5 words. no question, no emoji'
    mood.max = 45
  } else if (r < 0.36 * m) {
    mood.hint = 'one short blunt line. no emoji'
    mood.max = 55
  } else if (r < 0.48 * m) {
    mood.hint = 'short and a bit chaotic, change the subject'
    mood.max = 70
  } else if (r < 0.62) {
    mood.hint = 'ask her something short'
  }
  if (Math.random() < 0.55) mood.hint += '. no emoji this time'
  return mood
}

function askedRecently(jid) {
  const mine = (state.hist[jid] || []).filter((h) => h.role === 'me').slice(-3)
  return mine.length === 3 && mine.every((h) => h.text.trim().endsWith('?'))
}

async function generate(c, jid, hint) {
  const msgs = [{ role: 'system', content: systemPrompt(c, state.settings, hint, askedRecently(jid)) }]
  for (const h of histOf(jid)) msgs.push({ role: h.role === 'me' ? 'assistant' : 'user', content: h.text })
  return clean(await chat(msgs), state.settings.maxReplyChars)
}

async function generateOpener(c, jid) {
  const h = histOf(jid)
  const hint = h.length
    ? 'send the next text now, short and specific'
    : 'first text ever. specific and low effort. not hey, not wyd'
  const msgs = [{ role: 'system', content: systemPrompt(c, state.settings, hint, false) }]
  for (const x of h) msgs.push({ role: x.role === 'me' ? 'assistant' : 'user', content: x.text })
  if (!h.length) msgs.push({ role: 'user', content: 'write the first message' })
  return clean(await chat(msgs), 90)
}

/* ---------------- whatsapp ---------------- */
const logger = pino({ level: 'warn' })
let sock = null
let status = 'idle'
let qrUrl = null
let pairCode = null
let pairPhone = null
let pairTried = false
let reconnect = null
let bootAt = Date.now()
const inboundAt = new Map()

async function authState() {
  let d = { creds: initAuthCreds(), keys: {} }
  try { d = JSON.parse(fs.readFileSync(SESSION, 'utf8'), BufferJSON.reviver) } catch {}
  const save = () => { const t = SESSION + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, BufferJSON.replacer)); fs.renameSync(t, SESSION) }
  const keys = {
    get: async (type, ids) => {
      const out = {}
      for (const id of ids) {
        let v = d.keys[`${type}-${id}`]
        if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v)
        if (v) out[id] = v
      }
      return out
    },
    set: async (patch) => {
      for (const cat of Object.keys(patch)) for (const id of Object.keys(patch[cat])) {
        const k = `${cat}-${id}`
        if (patch[cat][id]) d.keys[k] = patch[cat][id]
        else delete d.keys[k]
      }
      save()
    }
  }
  return { state: { creds: d.creds, keys }, saveCreds: (u) => { if (u) Object.assign(d.creds, u); save() } }
}

function textOf(m) {
  const msg = m?.message
  if (!msg) return ''
  if (msg.ephemeralMessage) return textOf({ message: msg.ephemeralMessage.message })
  if (msg.viewOnceMessage) return textOf({ message: msg.viewOnceMessage.message })
  if (msg.viewOnceMessageV2) return textOf({ message: msg.viewOnceMessageV2.message })
  if (msg.documentWithCaptionMessage) return textOf({ message: msg.documentWithCaptionMessage.message })
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || ''
}

function ingest(list = []) {
  let changed = false
  for (const c of list) {
    if (!c?.id?.endsWith('@s.whatsapp.net')) continue
    const before = JSON.stringify(state.contacts[c.id] || {})
    contact(c.id, { name: c.name || c.verifiedName, notify: c.notify })
    if (JSON.stringify(state.contacts[c.id]) !== before) changed = true
  }
  if (changed) saveContacts()
}

async function onMessage(m) {
  if (!m?.message || m.key?.fromMe) return
  const jid = m.key?.remoteJid
  if (!jid || jid.endsWith('@broadcast')) return
  if (jid.endsWith('@g.us') && !state.settings.replyToGroups) return
  const text = textOf(m).trim()
  if (!text) return
  const ts = Number(m.messageTimestamp) * 1000
  if (ts && ts < bootAt - 60000) return

  const c = contact(jid, { notify: m.pushName })
  c.lastMsg = text.slice(0, 200)
  c.lastMsgAt = Date.now()
  saveContacts()
  push(jid, 'her', text)
  inboundAt.set(jid, Date.now())
  log('in', `${c.name}: ${text.slice(0, 110)}`, jid)

  if (!state.settings.masterOn || !c.rizz) return
  clearTimeout(timers.get(jid))
  timers.set(jid, setTimeout(() => {
    timers.delete(jid)
    run(jid).catch((e) => log('error', e.message, jid))
  }, 2500))
}

async function start(fresh = false) {
  if (fresh) { try { fs.rmSync(SESSION, { force: true }) } catch {} }
  if (sock) { try { sock.ev.removeAllListeners(); sock.end(undefined) } catch {} }
  sock = null
  status = 'connecting'; qrUrl = null; pairCode = null; pairTried = false; bootAt = Date.now()

  const { state: auth, saveCreds } = await authState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version, auth, logger, printQRInTerminal: false, syncFullHistory: true,
    markOnline: false, getMessage: async () => undefined,
    browser: ['RizzMate', 'Chrome', '2.0.0']
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      status = 'qr'
      try { qrUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }) } catch {}
      if (pairPhone && !pairTried) {
        pairTried = true
        try { pairCode = await sock.requestPairingCode(pairPhone); log('system', 'pairing code issued') }
        catch (e) { log('error', `pairing failed: ${e.message}`) }
      }
    }
    if (u.connection === 'open') {
      status = 'open'; qrUrl = null; pairCode = null; pairPhone = null
      log('system', `linked as ${sock.user?.name || sock.user?.id}`)
    }
    if (u.connection === 'close') {
      if (u.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        status = 'loggedout'; log('error', 'unlinked, scan again')
        try { fs.rmSync(SESSION, { force: true }) } catch {}
      } else {
        status = 'reconnecting'
        clearTimeout(reconnect)
        reconnect = setTimeout(() => start().catch(() => {}), 3000)
      }
    }
  })
  sock.ev.on('messaging-history.set', ({ contacts, chats }) => { ingest(contacts); ingest(chats) })
  sock.ev.on('contacts.upsert', ingest)
  sock.ev.on('contacts.update', ingest)
  sock.ev.on('chats.upsert', ingest)
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) onMessage(m).catch((e) => log('error', e.message))
  })
  return sock
}

async function send(jid, text) {
  if (!sock || status !== 'open') throw new Error('whatsapp not linked')
  await sock.sendMessage(jid, { text })
}

const typing = (jid, on) => sock?.sendPresenceUpdate(on ? 'composing' : 'paused', jid).catch(() => {})

/* ---------------- rizz engine ---------------- */
const timers = new Map()
const recent = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FOLLOW_UPS = ['?', 'you there', 'hellooo', '👀', 'well', 'ok then', 'so']

function bubble(text) {
  const lines = text.split(/\n+/).filter(Boolean)
  if (lines.length > 1) return lines.slice(0, state.settings.maxBubbles)
  if (text.length > 130) {
    const i = text.indexOf('. ')
    if (i > 30) return [text.slice(0, i + 1), text.slice(i + 2)]
  }
  return [text]
}

async function deliver(jid, text) {
  const c = contact(jid)
  for (const part of bubble(text)) {
    const wait = Math.min(Math.max(part.length * 30, state.settings.delayMin), state.settings.delayMax) + Math.random() * 900
    await typing(jid, true)
    await sleep(wait)
    await send(jid, part)
    await typing(jid, false)
    push(jid, 'me', part)
    ;(recent.get(jid) || recent.set(jid, []).get(jid)).push(Date.now())
    c.sentCount++
    c.lastReplyAt = Date.now()
    saveContacts()
    log('out', `you → ${c.name}: ${part}`, jid)
    await sleep(400 + Math.random() * 700)
  }
}

async function run(jid) {
  const c = state.contacts[jid]
  if (!c?.rizz || !state.settings.masterOn) return
  const now = Date.now()
  const r = (recent.get(jid) || []).filter((t) => now - t < 60000)
  recent.set(jid, r)
  if (r.length >= 5) return log('system', `rate limited on ${c.name}`, jid)

  const last = (state.hist[jid] || []).at(-1)
  const mood = rollMood(last?.text || '')
  if (mood.skip) return log('skip', `stayed quiet on ${c.name}`, jid)

  const reply = await generate(c, jid, mood.hint)
  if (!reply) return
  await deliver(jid, reply)

  if (mood.double && Math.random() < 0.7) {
    const before = inboundAt.get(jid) || 0
    await sleep(5000 + Math.random() * 7000)
    if ((inboundAt.get(jid) || 0) === before) {
      await typing(jid, true)
      await sleep(900)
      await send(jid, FOLLOW_UPS[Math.floor(Math.random() * FOLLOW_UPS.length)])
      await typing(jid, false)
      push(jid, 'me', '…')
      log('out', `you → ${c.name}: (follow up)`, jid)
    }
  }
}

/* ---------------- web ---------------- */
const app = express()
const PORT = process.env.PORT || 3000
const PW = process.env.APP_PASSWORD || 'rizz'
const TOKEN = crypto.createHash('sha256').update(PW + (process.env.SESSION_SECRET || 'x')).digest('hex')

app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())

const guard = (fn) => (req, res) => {
  if (req.cookies?.rizz !== TOKEN) return res.status(401).json({ error: 'auth' })
  Promise.resolve(fn(req, res)).catch((e) => { log('error', e.message); res.status(500).json({ error: e.message }) })
}

app.get('/healthz', (_, res) => res.type('text').send('ok'))
app.post('/api/login', (req, res) => {
  if ((req.body?.password || '') !== PW) return res.status(401).json({ error: 'wrong password' })
  res.cookie('rizz', TOKEN, { httpOnly: true, sameSite: 'lax', secure: !!process.env.RENDER, maxAge: 30 * 864e5 })
  res.json({ ok: true })
})
app.post('/api/logout', (_, res) => { res.clearCookie('rizz'); res.json({ ok: true }) })

app.get('/api/state', guard(async (_, res) => res.json({
  status: { status, connected: status === 'open', qr: qrUrl, pairCode, me: sock?.user?.name || null },
  settings: state.settings,
  contacts: Object.values(state.contacts)
    .sort((a, b) => (b.lastMsgAt || 0) - (a.lastMsgAt || 0))
    .map(({ jid, name, rizz, goal, tone, lastMsg, lastMsgAt, lastReplyAt, sentCount }) =>
      ({ jid, name, rizz, goal, tone, lastMsg, lastMsgAt, lastReplyAt, sentCount })),
  logs: state.logs.slice(0, 60)
})))

app.get('/api/contact/:jid', guard(async (req, res) => {
  const c = state.contacts[req.params.jid]
  if (!c) return res.status(404).json({ error: 'nope' })
  res.json({ contact: c, history: (state.hist[req.params.jid] || []).slice(-40) })
}))

app.post('/api/contact/:jid/rizz', guard(async (req, res) => {
  const c = contact(req.params.jid)
  c.rizz = !!req.body?.on
  saveContacts()
  res.json({ rizz: c.rizz })
}))

app.post('/api/contact/:jid/update', guard(async (req, res) => {
  const c = state.contacts[req.params.jid]
  if (!c) return res.status(404).json({ error: 'nope' })
  if (typeof req.body?.goal === 'string') c.goal = req.body.goal.slice(0, 300)
  if (typeof req.body?.tone === 'string') c.tone = req.body.tone.slice(0, 200)
  if (req.body?.name) c.name = String(req.body.name).slice(0, 60)
  saveContacts()
  res.json({ ok: true })
}))

app.post('/api/contact/:jid/now', guard(async (req, res) => {
  const c = contact(req.params.jid)
  if (req.body?.mode === 'opener') {
    const text = await generateOpener(c, req.params.jid)
    await typing(req.params.jid, true)
    await sleep(1400)
    await send(req.params.jid, text)
    await typing(req.params.jid, false)
    push(req.params.jid, 'me', text)
    log('out', `you → ${c.name}: ${text}`, req.params.jid)
    return res.json({ sent: text })
  }
  await run(req.params.jid)
  res.json({ ok: true })
}))

app.post('/api/settings', guard(async (req, res) => {
  for (const k of Object.keys(DEFAULTS)) if (req.body?.[k] !== undefined) state.settings[k] = req.body[k]
  saveSettings()
  res.json({ ok: true })
}))

app.post('/api/wa/connect', guard(async (_, res) => { await start(); res.json({ ok: true }) }))
app.post('/api/wa/pair', guard(async (req, res) => {
  pairPhone = String(req.body?.phone || '').replace(/\D/g, '')
  pairTried = false
  if (sock && status === 'qr') { try { pairCode = await sock.requestPairingCode(pairPhone); pairTried = true } catch {} }
  res.json({ ok: true })
}))
app.post('/api/wa/logout', guard(async (_, res) => { try { await sock?.logout() } catch {}; try { fs.rmSync(SESSION, { force: true }) } catch {}; status = 'loggedout'; res.json({ ok: true }) }))

app.use(express.static(path.join(import.meta.dirname, 'public')))
app.get('*', (_, res) => res.sendFile(path.join(import.meta.dirname, 'public', 'index.html')))

app.listen(PORT, () => {
  console.log(`up on ${PORT}`)
  if (process.env.VENICE_API_KEY) start().catch((e) => console.error(e.message))
})
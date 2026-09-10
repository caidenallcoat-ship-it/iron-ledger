/**
 * Who the caller is.
 *
 * The app started as one person behind one shared secret. Making it two people
 * did not need accounts, passwords or email: a long random key already worked
 * as a bearer token, so each person simply gets their own. The key IS the
 * identity. Nothing is stored but its SHA-256, so a dump of the database hands
 * over nobody's access.
 *
 * Layout:
 *   iron-ledger:u:<uid>        the person's record
 *   iron-ledger:k:<sha256>     key hash -> uid
 *   iron-ledger:users          uid -> {name, admin, created}
 *   iron-ledger:subs:<uid>     that person's push subscriptions
 *
 * The single-tenant keys (iron-ledger:state, iron-ledger:subs) are migrated to
 * the owner the first time they are seen, and left in place afterwards rather
 * than deleted — an old deploy rolling back should find its data where it left
 * it, not an empty ledger.
 */
import { redis, STATE_DOC, SUBS_HASH } from "./_lib.js";

export const USERS_HASH = "iron-ledger:users";
export const uidDoc = (uid) => "iron-ledger:u:" + uid;
export const keyDoc = (hash) => "iron-ledger:k:" + hash;
export const subsDoc = (uid) => "iron-ledger:subs:" + uid;

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A key long enough that guessing it is not a strategy. */
export function mintKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 40);
}

function newUid() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "u_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readUsers() {
  const out = await redis(["HGETALL", USERS_HASH]);
  const flat = (out && out.result) || [];
  const users = {};
  // Upstash returns HGETALL as a flat [field, value, field, value, ...].
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      try { users[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip a bad row */ }
    }
  } else if (flat && typeof flat === "object") {
    for (const k of Object.keys(flat)) {
      try { users[k] = typeof flat[k] === "string" ? JSON.parse(flat[k]) : flat[k]; } catch {}
    }
  }
  return users;
}

export async function listUsers() {
  const users = await readUsers();
  return Object.keys(users).map((uid) => ({ uid, ...users[uid] }));
}

/**
 * The owner: whoever holds LEDGER_KEY. Created on first sight, and given the
 * record the app already had so nothing is lost in the move.
 */
async function ensureOwner() {
  const ownerKey = process.env.LEDGER_KEY;
  if (!ownerKey) return null;
  const hash = await sha256(ownerKey);
  const found = await redis(["GET", keyDoc(hash)]);
  if (found && found.result) return found.result;

  const uid = newUid();
  const legacy = await redis(["GET", STATE_DOC]);
  if (legacy && legacy.result) {
    await redis(["SET", uidDoc(uid), legacy.result]);
  }
  const legacySubs = await redis(["HGETALL", SUBS_HASH]);
  const flat = (legacySubs && legacySubs.result) || [];
  if (Array.isArray(flat) && flat.length) {
    for (let i = 0; i < flat.length; i += 2) {
      await redis(["HSET", subsDoc(uid), flat[i], flat[i + 1]]);
    }
  }
  await redis(["SET", keyDoc(hash), uid]);
  await redis(["HSET", USERS_HASH, uid, JSON.stringify({
    name: "Caiden", admin: true, created: new Date().toISOString(), migrated: true,
  })]);
  return uid;
}

/** uid for this key, or null. Creates the owner on first sight. */
export async function userForKey(key) {
  if (!key) return null;
  if (process.env.LEDGER_KEY && key === process.env.LEDGER_KEY) {
    return await ensureOwner();
  }
  const out = await redis(["GET", keyDoc(await sha256(key))]);
  const uid = (out && out.result) || null;
  if (!uid) return null;
  /* A key that resolves to somebody who has been removed is not a key. The
     hash is deleted on removal too, but this is the check that actually
     decides it, so a stale mapping from any source grants nothing. */
  const who = await userInfo(uid);
  return who ? uid : null;
}

export async function userInfo(uid) {
  const users = await readUsers();
  return users[uid] || null;
}

/** Add a person. Returns their key exactly once — it is never recoverable. */
export async function createUser(name) {
  const uid = newUid();
  const key = mintKey();
  const hash = await sha256(key);
  await redis(["SET", keyDoc(hash), uid]);
  await redis(["HSET", USERS_HASH, uid, JSON.stringify({
    name: String(name || "").slice(0, 40) || "Unnamed",
    admin: false, created: new Date().toISOString(),
    // Kept so removal can revoke the key rather than orphan it.
    keyHash: hash,
  })]);
  return { uid, key, name };
}

export async function renameUser(uid, name) {
  const users = await readUsers();
  if (!users[uid]) return false;
  users[uid].name = String(name || "").slice(0, 40) || users[uid].name;
  await redis(["HSET", USERS_HASH, uid, JSON.stringify(users[uid])]);
  return true;
}

export async function removeUser(uid) {
  const users = await readUsers();
  if (!users[uid]) return false;
  if (users[uid].admin) return false;          // the owner is not deletable by accident
  if (users[uid].keyHash) await redis(["DEL", keyDoc(users[uid].keyHash)]);
  await redis(["HDEL", USERS_HASH, uid]);
  await redis(["DEL", uidDoc(uid)]);
  await redis(["DEL", subsDoc(uid)]);
  return true;
}

export async function loadFor(uid) {
  const out = await redis(["GET", uidDoc(uid)]);
  const raw = out && out.result;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function saveFor(uid, state) {
  state.updatedAt = Date.now();
  await redis(["SET", uidDoc(uid), JSON.stringify(state)]);
  /* The owner's record stays mirrored to the original key while the two
     shapes coexist, so a rollback to a single-tenant deploy still finds it. */
  const info = await userInfo(uid);
  if (info && info.admin) await redis(["SET", STATE_DOC, JSON.stringify(state)]);
  return state;
}

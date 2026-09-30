#!/usr/bin/env node
// Discord などに貼られたテキストから FaBrary のデッキリンクを取り出し、
// デッキページをスクレイピングしてメインデッキのカードを fabary-decks.json 形式で抽出する。
//
// 使い方:
//   node scripts/fabrary-scrape.mjs links.txt                 # 抽出結果を標準出力へ
//   node scripts/fabrary-scrape.mjs links.txt --merge         # fabary-decks.json に追記
//   pbpaste | node scripts/fabrary-scrape.mjs --links-only    # リンク抽出だけ確認
//
// FaBrary は JavaScript で描画される SPA なので、Playwright (Chromium) でページを開き、
// 通信で受け取った JSON からデッキを探す。見つからなければ描画後のページ本文を解析する。

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POOL = path.join(ROOT, "IAR_Draft_V1.1.txt");
const DEFAULT_DECKS = path.join(ROOT, "fabary-decks.json");
const COLORS = ["red", "yellow", "blue"];
const PITCH_COLORS = { 1: "red", 2: "yellow", 3: "blue" };
const SIDE_PATTERN = /side|maybe|inventory|consider|wish/i;

// ---- リンク抽出 ----------------------------------------------------------

const LINK_PATTERN = /https?:\/\/(?:www\.)?fabrary\.net\/decks\/([0-9A-Za-z]{26})\b[^\s<>)"']*/g;
// Discord のコピーで入る「ユーザー名 — 8:26」のような投稿者行
const AUTHOR_PATTERN = /^(.+?)\s+[—–-]\s+(?:\d{1,2}:\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|今日|昨日|Today|Yesterday)/;

export function extractDeckLinks(text) {
  const links = [];
  const seen = new Set();
  let author = "";
  let label = "";
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const authorMatch = line.match(AUTHOR_PATTERN);
    if (authorMatch && !line.includes("fabrary.net")) {
      author = authorMatch[1].trim();
      label = "";
      continue;
    }
    const matches = [...line.matchAll(LINK_PATTERN)];
    if (!matches.length) {
      label = line;
      continue;
    }
    // リンクと同じ行にある文字列もラベルとして扱う
    const inlineLabel = line.replace(LINK_PATTERN, "").trim();
    for (const match of matches) {
      const id = match[1].toUpperCase();
      if (seen.has(id)) continue;
      seen.add(id);
      links.push({ id, url: `https://fabrary.net/decks/${id}`, label: inlineLabel || label, author });
    }
    label = "";
  }
  return links;
}

// ---- カードプール --------------------------------------------------------

export function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function splitColor(name) {
  const match = String(name).match(/^(.*?)\s*\((red|yellow|blue)\)\s*$/i);
  return match ? { name: match[1].trim(), color: match[2].toLowerCase() } : { name: String(name).trim(), color: "" };
}

export function parseCardPool(text) {
  const cards = new Map();
  const add = (fullName, extra = {}) => {
    const { name, color } = splitColor(fullName);
    const key = slugify(name);
    if (!cards.has(key)) cards.set(key, { name, colors: new Set(), type: "", collectorNumbers: new Map() });
    const card = cards.get(key);
    card.colors.add(color || "none");
    if (extra.type) card.type = extra.type;
    if (extra.collectorNumber) card.collectorNumbers.set(extra.collectorNumber.toUpperCase(), color || "none");
  };
  const normalized = String(text).replace(/\r\n?/g, "\n");
  const start = normalized.indexOf("[CustomCards]");
  if (start >= 0) {
    const end = normalized.indexOf("\n[", start + 14);
    try {
      for (const card of JSON.parse(normalized.slice(start + 14, end < 0 ? undefined : end))) {
        if (card?.name) add(card.name, { type: card.type, collectorNumber: card.collector_number });
      }
    } catch {
      // CustomCards が壊れていてもシート部分だけで続行する
    }
  }
  let inSheet = false;
  for (const line of normalized.split("\n")) {
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inSheet = !["Settings", "CustomCards", "Layouts"].includes(section[1]);
      continue;
    }
    const card = inSheet && line.match(/^(\d+) (.+)$/);
    if (card) add(card[2]);
  }
  const byCollector = new Map();
  for (const card of cards.values()) {
    for (const [number, color] of card.collectorNumbers) byCollector.set(number, { card, color });
  }
  return { cards, byCollector };
}

function titleFromSlug(value) {
  return value
    .split("-")
    .filter(Boolean)
    .map((word, i) => (i > 0 && ["of", "the", "and", "a", "to", "in"].includes(word) ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

function normalizeColor(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" || /^\d$/.test(String(value))) return PITCH_COLORS[Number(value)] || "";
  const color = String(value).toLowerCase();
  return COLORS.includes(color) ? color : "";
}

// 名前・識別子・ピッチからカード名と色を決め、fabary-decks.json 形式のカードにする
export function resolveCard({ name, color, qty }, pool) {
  let raw = String(name || "").trim();
  let resolvedColor = normalizeColor(color);
  const warnings = [];

  const collector = raw.toUpperCase();
  if (pool.byCollector.has(collector)) {
    const hit = pool.byCollector.get(collector);
    raw = hit.card.name;
    if (!resolvedColor && hit.color !== "none") resolvedColor = hit.color;
  }

  const split = splitColor(raw);
  raw = split.name;
  if (!resolvedColor) resolvedColor = split.color;
  let slug = slugify(raw);
  const slugColor = slug.match(/-(red|yellow|blue)$/);
  if (slugColor && !pool.cards.has(slug)) {
    slug = slug.slice(0, -slugColor[0].length);
    if (!resolvedColor) resolvedColor = slugColor[1];
    if (!/\s/.test(raw)) raw = raw.slice(0, -slugColor[0].length);
  }

  const entry = pool.cards.get(slug);
  let cardName;
  if (entry) {
    cardName = entry.name;
    const pitched = [...entry.colors].filter(c => c !== "none");
    if (!resolvedColor && pitched.length === 1 && !entry.colors.has("none")) resolvedColor = pitched[0];
    if (!resolvedColor && pitched.length > 1) warnings.push(`${cardName}: 色を判別できませんでした`);
  } else {
    cardName = /[\sA-Z]/.test(raw) ? raw : titleFromSlug(slug);
    if (!cardName) return { card: null, warnings: [`カード名を読み取れませんでした: ${JSON.stringify(name)}`] };
    warnings.push(`${cardName}: カードプール(IAR_Draft_V1.1.txt)にないカードです`);
  }

  let section = "deck";
  let finalColor = resolvedColor;
  if (!finalColor) {
    // 色のないカードは装備・武器として Arena 扱い。プールにある非装備カード(Blood Harvest など)はデッキ扱い
    const isDeckCard = entry && entry.type && !/equipment|weapon/i.test(entry.type);
    section = isDeckCard ? "deck" : "arena";
    finalColor = isDeckCard ? "none" : "arena";
  }
  return { card: { name: cardName, qty, color: finalColor, section }, warnings };
}

// ---- JSON からデッキを探す -----------------------------------------------

const QTY_KEYS = ["quantity", "qty", "count", "amount", "mainQuantity", "deckQuantity", "number"];
const NAME_KEYS = ["name", "cardName", "cardIdentifier", "identifier", "cardId", "printingIdentifier", "id"];
const COLOR_KEYS = ["color", "pitch", "colour"];

function pick(obj, keys) {
  for (const key of keys) if (obj?.[key] != null && obj[key] !== "") return obj[key];
  return undefined;
}

function readEntry(el) {
  if (!el || typeof el !== "object" || Array.isArray(el)) return null;
  const qty = Number(pick(el, QTY_KEYS));
  if (!Number.isInteger(qty) || qty < 0 || qty > 99) return null;
  const card = el.card && typeof el.card === "object" ? el.card : null;
  const name = pick(el, NAME_KEYS.filter(k => k !== "id")) ?? pick(card, NAME_KEYS) ?? el.id;
  if (typeof name !== "string" && typeof name !== "number") return null;
  const zone = [el.section, el.zone, el.board, el.location, el.list].filter(v => typeof v === "string").join(" ");
  const sideboard = el.sideboard === true || el.isSideboard === true || SIDE_PATTERN.test(zone);
  const types = [el.type, el.types, el.typeText, card?.type, card?.types, card?.typeText].flat().filter(Boolean).join(" ");
  return { name: String(name), qty, color: pick(el, COLOR_KEYS) ?? pick(card, COLOR_KEYS), sideboard, isHero: /\bhero\b/i.test(types) };
}

function heroFrom(obj) {
  const hero = obj?.hero ?? obj?.heroName ?? obj?.heroIdentifier ?? obj?.heroCard;
  if (typeof hero === "string") return hero;
  if (hero && typeof hero === "object") return pick(hero, ["name", "identifier", "cardIdentifier"]) || "";
  return "";
}

export function findDeckCandidates(json) {
  const candidates = [];
  const walk = (value, trail, parent) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const entries = value.map(readEntry);
      const valid = entries.filter(Boolean);
      if (valid.length >= 3 && valid.length >= value.length * 0.6 && !SIDE_PATTERN.test(trail.at(-1) || "")) {
        candidates.push({
          entries: valid,
          name: typeof parent?.name === "string" ? parent.name : typeof parent?.deckName === "string" ? parent.deckName : "",
          hero: heroFrom(parent),
          trail: trail.join("."),
        });
      }
      value.forEach((item, i) => walk(item, [...trail, String(i)], parent));
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, [...trail, key], value);
  };
  walk(json, [], null);
  return candidates;
}

export function deckFromCandidates(candidates, pool) {
  let best = null;
  for (const candidate of candidates) {
    const main = candidate.entries.filter(e => !e.sideboard && e.qty > 0);
    const known = main.filter(e => resolveCard(e, pool).warnings.length === 0).length;
    const total = main.reduce((sum, e) => sum + e.qty, 0);
    const score = [known, total];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { candidate, main, score };
  }
  if (!best || best.score[0] === 0) return null;
  const heroEntry = best.main.find(e => e.isHero);
  return {
    name: best.candidate.name,
    hero: best.candidate.hero || heroEntry?.name || "",
    entries: best.main.filter(e => !e.isHero),
  };
}

// ---- ページ本文からデッキを読む(JSON が取れなかった場合) -----------------

export function deckFromText(text, pool) {
  const entries = [];
  let side = false;
  for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(sideboard|side board|maybe ?board|inventory|considering)\b/i.test(line)) { side = true; continue; }
    if (/^(main( deck)?|deck( cards)?|arena( cards)?|equipment|weapons?|hero|cards)\b/i.test(line)) { side = false; continue; }
    const match = line.match(/^(\d{1,2})\s*x?\s+(.+?)$/i);
    if (!match || side) continue;
    const entry = { name: match[2], qty: Number(match[1]), color: "" };
    const { card, warnings } = resolveCard(entry, pool);
    // 本文には無関係な数字行も混ざるので、プールで確認できた行か色付きの行だけ採用する
    if (card && (warnings.length === 0 || /\((red|yellow|blue)\)\s*$/i.test(match[2]))) entries.push(entry);
  }
  return entries.length ? { name: "", hero: "", entries } : null;
}

// ---- デッキの組み立て ----------------------------------------------------

function normalizeHero(hero, knownHeroes) {
  const value = String(hero || "").trim();
  if (!value) return "";
  const text = /\s|,/.test(value) ? value : titleFromSlug(slugify(value));
  const first = slugify(text.split(",")[0]).split("-")[0];
  return knownHeroes.find(h => slugify(h) === slugify(text)) || knownHeroes.find(h => slugify(h.split(",")[0]).split("-")[0] === first) || text;
}

export function buildDeck(found, link, pool, { title = "", knownHeroes = [] } = {}) {
  const warnings = [];
  const merged = new Map();
  for (const entry of found.entries) {
    const { card, warnings: w } = resolveCard(entry, pool);
    warnings.push(...w);
    if (!card) continue;
    const key = `${card.name}|||${card.color}`;
    if (merged.has(key)) merged.get(key).qty += card.qty;
    else merged.set(key, { ...card });
  }
  const cleanTitle = title.replace(/\s*[|｜-]\s*FaBrary.*$/i, "").trim();
  const labelHero = link.label ? link.label.split(/[,、]/)[0] : "";
  const hero = normalizeHero(found.hero, knownHeroes) || normalizeHero(labelHero, knownHeroes) || "不明";
  const heroSlugs = new Set([found.hero, hero].filter(Boolean).map(slugify));
  const cards = [...merged.values()].filter(card => !heroSlugs.has(slugify(card.name)));
  return {
    deck: {
      name: found.name || cleanTitle || link.label || `FaBrary ${link.id}`,
      hero,
      cards,
      source: { url: link.url, label: link.label || undefined, author: link.author || undefined },
    },
    warnings: [...new Set(warnings)],
  };
}

// ---- 取得 ----------------------------------------------------------------

async function scrapeWithBrowser(url, { timeout }) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const jsonBodies = [];
    page.on("response", async response => {
      if (!/json/i.test(response.headers()["content-type"] || "")) return;
      try { jsonBodies.push(await response.json()); } catch { /* 本文を読めないレスポンスは無視 */ }
    });
    await page.goto(url, { waitUntil: "networkidle", timeout });
    await page.waitForTimeout(500);
    const snapshot = await page.evaluate(() => ({
      title: document.querySelector('meta[property="og:title"]')?.content || document.title || "",
      text: document.body?.innerText || "",
      embedded: [...document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__')].map(s => s.textContent),
    }));
    return { ...snapshot, jsonBodies, method: "browser" };
  } finally {
    await browser.close();
  }
}

async function scrapeWithFetch(url, { timeout }) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { "user-agent": "Mozilla/5.0 fabrary-scrape" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const embedded = [...html.matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const title = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1] || html.match(/<title>([^<]*)<\/title>/i)?.[1] || "";
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, "");
  return { title, text, embedded, jsonBodies: [], method: "fetch" };
}

export function extractDeckFromPage(page, link, pool, options = {}) {
  const bodies = [...page.jsonBodies];
  for (const source of page.embedded || []) {
    try { bodies.push(JSON.parse(source)); } catch { /* JSON でなければ無視 */ }
  }
  const found = deckFromCandidates(bodies.flatMap(findDeckCandidates), pool) || deckFromText(page.text, pool);
  if (!found) return null;
  return buildDeck(found, link, pool, { ...options, title: page.title });
}

export async function scrapeDeck(link, pool, { timeout = 30000, baseUrl = process.env.FABRARY_BASE_URL, knownHeroes = [] } = {}) {
  const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/decks/${link.id}` : link.url;
  const page = (await scrapeWithBrowser(url, { timeout })) || (await scrapeWithFetch(url, { timeout }));
  const result = extractDeckFromPage(page, link, pool, { knownHeroes });
  if (!result) throw new Error(`デッキのカードを抽出できませんでした (${page.method})`);
  return { ...result, method: page.method };
}

export function mergeDecks(existing, additions) {
  const known = new Set(existing.map(d => d.source?.url).filter(Boolean));
  const added = additions.filter(d => !known.has(d.source.url));
  return { decks: [...existing, ...added], added: added.length, skipped: additions.length - added.length };
}

// ---- CLI -----------------------------------------------------------------

function parseArgs(argv) {
  const args = { input: "-", out: "", merge: "", linksOnly: false, pool: DEFAULT_POOL, timeout: 30000, delay: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--out" || arg === "-o") args.out = next();
    else if (arg === "--merge") args.merge = argv[i + 1] && !argv[i + 1].startsWith("-") ? next() : DEFAULT_DECKS;
    else if (arg === "--links-only") args.linksOnly = true;
    else if (arg === "--pool") args.pool = next();
    else if (arg === "--timeout") args.timeout = Number(next());
    else if (arg === "--delay") args.delay = Number(next());
    else if (arg === "--help" || arg === "-h") args.help = true;
    else args.input = arg;
  }
  return args;
}

async function readInput(input) {
  if (input !== "-") return readFile(input, "utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/fabrary-scrape.mjs [input.txt|-] [--out decks.json] [--merge [fabary-decks.json]] [--links-only] [--pool IAR_Draft_V1.1.txt] [--timeout ms] [--delay ms]");
    return;
  }
  const links = extractDeckLinks(await readInput(args.input));
  if (!links.length) {
    console.error("FaBrary のデッキリンクが見つかりませんでした。");
    process.exitCode = 1;
    return;
  }
  if (args.linksOnly) {
    console.log(JSON.stringify(links, null, 2));
    return;
  }
  const pool = parseCardPool(await readFile(args.pool, "utf8"));
  const existing = args.merge ? JSON.parse(await readFile(args.merge, "utf8")) : [];
  const knownHeroes = [...new Set(existing.map(d => d.hero).filter(h => h && h !== "不明"))];
  const decks = [];
  for (const [i, link] of links.entries()) {
    if (i > 0 && args.delay > 0) await new Promise(resolve => setTimeout(resolve, args.delay));
    try {
      const { deck, warnings, method } = await scrapeDeck(link, pool, { timeout: args.timeout, knownHeroes });
      const total = deck.cards.reduce((sum, c) => sum + c.qty, 0);
      console.error(`✔ ${link.url} → ${deck.name} (${deck.hero}) ${deck.cards.length}種 ${total}枚 [${method}]`);
      for (const warning of warnings) console.error(`  ⚠ ${warning}`);
      decks.push(deck);
    } catch (error) {
      console.error(`✘ ${link.url}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (args.merge) {
    const result = mergeDecks(existing, decks);
    await writeFile(args.merge, JSON.stringify(result.decks, null, 2));
    console.error(`${args.merge} に ${result.added} 件追加しました（登録済み ${result.skipped} 件はスキップ）。`);
  }
  if (args.out) await writeFile(args.out, JSON.stringify(decks, null, 2));
  else if (!args.merge) console.log(JSON.stringify(decks, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

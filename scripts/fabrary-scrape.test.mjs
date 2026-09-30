import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  extractDeckLinks,
  parseCardPool,
  resolveCard,
  findDeckCandidates,
  deckFromCandidates,
  deckFromText,
  buildDeck,
  mergeDecks,
  scrapeDeck,
} from "./fabrary-scrape.mjs";

const pool = parseCardPool(await readFile(fileURLToPath(new URL("../IAR_Draft_V1.1.txt", import.meta.url)), "utf8"));
const DECK_ID = "01M3QEJ4RXXNZCA5DQRSAT0W98";

test("Discord のテキストからリンク・ラベル・投稿者を取り出す", () => {
  const text = `marxinista — 8:26
Levia, LMV
https://fabrary.net/decks/${DECK_ID}
someone — 昨日 21:03
Malice https://fabrary.net/decks/01ABCDEFGHJKMNPQRSTVWXYZ12?tab=cards
重複 https://fabrary.net/decks/${DECK_ID}`;
  assert.deepEqual(extractDeckLinks(text), [
    { id: DECK_ID, url: `https://fabrary.net/decks/${DECK_ID}`, label: "Levia, LMV", author: "marxinista" },
    { id: "01ABCDEFGHJKMNPQRSTVWXYZ12", url: "https://fabrary.net/decks/01ABCDEFGHJKMNPQRSTVWXYZ12", label: "Malice", author: "someone" },
  ]);
});

test("カード名・識別子・ピッチをプールの表記に揃える", () => {
  assert.deepEqual(resolveCard({ name: "beckoning-hunger-red", qty: 2 }, pool).card, { name: "Beckoning Hunger", qty: 2, color: "red", section: "deck" });
  assert.deepEqual(resolveCard({ name: "Beckoning Hunger", color: 3, qty: 1 }, pool).card, { name: "Beckoning Hunger", qty: 1, color: "blue", section: "deck" });
  assert.deepEqual(resolveCard({ name: "IAR005", qty: 1 }, pool).card, { name: "Blood Harvest", qty: 1, color: "none", section: "deck" });
  assert.deepEqual(resolveCard({ name: "dark-arcanite-helm", qty: 1 }, pool).card, { name: "Dark Arcanite Helm", qty: 1, color: "arena", section: "arena" });
  const unknown = resolveCard({ name: "hell-hammer", qty: 1 }, pool);
  assert.deepEqual(unknown.card, { name: "Hell Hammer", qty: 1, color: "arena", section: "arena" });
  assert.equal(unknown.warnings.length, 1);
});

test("API レスポンスの JSON からメインデッキだけを抽出する", () => {
  const response = {
    data: {
      getDeck: {
        name: "Levia LMV",
        hero: { name: "Levia, Redeemed" },
        deckCards: [
          { cardIdentifier: "levia-redeemed", quantity: 1, card: { types: ["Hero"] } },
          { cardIdentifier: "beckoning-hunger-red", quantity: 2 },
          { cardIdentifier: "beckoning-hunger-yellow", quantity: 1 },
          { cardIdentifier: "blood-harvest", quantity: 1 },
          { cardIdentifier: "dark-arcanite-helm", quantity: 1 },
          { cardIdentifier: "cleave-the-heavens-blue", quantity: 1, sideboard: true },
        ],
        sideboardCards: [
          { cardIdentifier: "cleave-the-heavens-red", quantity: 3 },
          { cardIdentifier: "cleave-the-heavens-yellow", quantity: 3 },
          { cardIdentifier: "cleave-the-heavens-blue", quantity: 3 },
        ],
      },
    },
  };
  const found = deckFromCandidates(findDeckCandidates(response), pool);
  const { deck } = buildDeck(found, { id: DECK_ID, url: `https://fabrary.net/decks/${DECK_ID}`, label: "Levia, LMV" }, pool, { knownHeroes: ["Levia", "Malice"] });
  assert.equal(deck.name, "Levia LMV");
  assert.equal(deck.hero, "Levia");
  assert.deepEqual(deck.cards, [
    { name: "Beckoning Hunger", qty: 2, color: "red", section: "deck" },
    { name: "Beckoning Hunger", qty: 1, color: "yellow", section: "deck" },
    { name: "Blood Harvest", qty: 1, color: "none", section: "deck" },
    { name: "Dark Arcanite Helm", qty: 1, color: "arena", section: "arena" },
  ]);
});

test("JSON がない場合はページ本文から読み、サイドボードと無関係な行を除く", () => {
  const found = deckFromText(`Levia LMV
Updated 3 days ago
Main deck
2x Beckoning Hunger (red)
1 Blood Harvest
1 Dark Arcanite Helm
40 cards
Sideboard
3x Cleave the Heavens (blue)`, pool);
  assert.deepEqual(found.entries.map(e => `${e.qty} ${e.name}`), ["2 Beckoning Hunger (red)", "1 Blood Harvest", "1 Dark Arcanite Helm"]);
});

test("登録済みの URL は追記しない", () => {
  const deck = url => ({ name: "d", hero: "Levia", cards: [], source: { url } });
  const result = mergeDecks([{ name: "old", hero: "Malice", cards: [] }, deck("https://fabrary.net/decks/A")], [deck("https://fabrary.net/decks/A"), deck("https://fabrary.net/decks/B")]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.decks.length, 3);
});

test("ブラウザで SPA を開き、通信した JSON からデッキを抽出する", async t => {
  try {
    await import("playwright");
  } catch {
    t.skip("playwright が未インストール");
    return;
  }
  const deckJson = {
    data: {
      deck: {
        name: "Local Levia",
        heroIdentifier: "levia-redeemed",
        cards: [
          { name: "Beckoning Hunger", pitch: 1, quantity: 3 },
          { name: "Blood Harvest", quantity: 1 },
          { name: "Dark Arcanite Plating", quantity: 1 },
        ],
      },
    },
  };
  const server = createServer((req, res) => {
    if (req.url === "/graphql") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(deckJson));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Loading | FaBrary</title><div id="app"></div>
<script>fetch("/graphql",{method:"POST"}).then(r=>r.json()).then(d=>{document.title=d.data.deck.name+" | FaBrary";document.getElementById("app").textContent=d.data.deck.name})</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { deck, method } = await scrapeDeck(
    { id: DECK_ID, url: `https://fabrary.net/decks/${DECK_ID}`, label: "Levia, LMV" },
    pool,
    { baseUrl: `http://127.0.0.1:${server.address().port}`, knownHeroes: ["Levia"] },
  );
  assert.equal(method, "browser");
  assert.equal(deck.name, "Local Levia");
  assert.equal(deck.hero, "Levia");
  assert.equal(deck.source.url, `https://fabrary.net/decks/${DECK_ID}`);
  assert.deepEqual(deck.cards, [
    { name: "Beckoning Hunger", qty: 3, color: "red", section: "deck" },
    { name: "Blood Harvest", qty: 1, color: "none", section: "deck" },
    { name: "Dark Arcanite Plating", qty: 1, color: "arena", section: "arena" },
  ]);
});

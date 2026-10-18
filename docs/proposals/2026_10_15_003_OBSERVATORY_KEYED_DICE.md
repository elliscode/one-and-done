# One & Done — Observatory-Keyed Dice (ChaCha20 stream, rekeyed every 60s)

Implement this as an incremental change to the existing application. Only the dice source is swapped. Rolling stays synchronous, and nothing in the game rules, `rollDice`, or the command handlers changes. Every roll already goes through the injected `rng` function: `GameService` stores it at `server/games/service.js:29` and hands it to handlers as `ctx.rng` at `:149`.

## Background

**Today:** dice use `crypto.randomInt(1, sides + 1)`. It's the default in `server/dice.js:9` and in `service.js:29`, and `server/index.js:39` doesn't override it. That's already a full-strength CSPRNG backed by the OS.

**Goal:** dice should be keyed from **The Observatory**, a separate service at `observatory.elliscode.com` that photographs something silly (a turtle tank, a jellybean tumbler) and serves fresh random bytes mixed with the latest observation. The Observatory's output should really change the dice stream. The game must stay playable, with no waiting and no errors, whenever the Observatory is slow or offline.

**What this does and doesn't claim:**
- The stream's security rests on **fresh local OS randomness** (`crypto.randomBytes`) that goes into every key.
- The Observatory's bytes change the derived key, so the turtle really does affect the rolls.
- They are **not** credited as extra entropy. The dice are **not** stronger than `crypto.randomInt` alone. The point is the story.
- Between rekeys, the dice are a deterministic stream cipher, i.e. a CSPRNG. UI wording says "keyed by", never "rolled by" or "truly random".

## Part 1: The generator (`server/observatory-dice.js`, new)

### Algorithm

| Piece | Choice |
|---|---|
| Stream cipher | ChaCha20 from Node's built-in `crypto.createCipheriv('chacha20', key, iv)` (OpenSSL). No new dependency, and no hand-rolled cipher. |
| Keystream | Encrypt a zero buffer (`Buffer.alloc(256)`) with `cipher.update()`, refilling 256 bytes at a time. |
| Key derivation | `Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'one-and-done/dice/v1', 32))` |
| `ikm` | `randomBytes(32)`: fresh local OS randomness on **every** rekey |
| `salt` | The Observatory's 32 bytes, or an empty buffer for a local-only key |
| IV | 16 zero bytes |

- **`hkdfSync` returns an `ArrayBuffer`.** Wrap it in `Buffer.from(...)`.
- **The zero IV is safe** because every rekey derives a brand-new key, so a (key, nonce) pair is never reused.
- **OpenSSL's IV layout** isn't the RFC's separate counter and nonce. The 16-byte IV is a **4-byte little-endian block counter followed by a 12-byte nonce**. An all-zero IV means block counter 0, nonce 0. The 32-bit block counter allows about 256 GiB of keystream per key; a 60-second key uses a few bytes per roll and never gets close.
- Local randomness is the HKDF input key material and the Observatory bytes are only the salt, the same shape as the Observatory's own core. The derived key is therefore at least as strong as the local randomness, even if the Observatory's output were fully known.

### `rng(sides)`

```js
export function rng(sides) {
  if (!Number.isInteger(sides) || sides < 1 || sides > 256) throw new RangeError(`Unsupported die size ${sides}`);
  const limit = 256 - (256 % sides);   // rejection sampling: no modulo bias for d6/d10/d12/d20
  let b;
  do { b = nextByte(); } while (b >= limit);
  return (b % sides) + 1;
}
```

- **Validation is required.** Without it, `sides > 256` makes `limit` 0 and the loop never ends. `parseDice` already restricts dice to d4–d20, but `rng` is an exported, injectable function and should check its own input.
- `rng` is synchronous and never touches the network. It drops straight into `GameService({ rng })`.

### `rekey(seed | null, meta)`

- Derives a new key as above, creates a new cipher, and **drops the old cipher and any buffered keystream**. The next byte always comes from the new key.
- Records non-secret metadata for display:
  `{ source: 'observatory' | 'local', keyedAt, observedAt, sources: [{ name, observationId, imageUrl? }] }`.
- Key material and seed bytes are never stored outside the cipher, never logged, and never returned.

## Part 2: The reseed lifecycle

`createObservatoryDice({ url, key, intervalMs = 60_000, timeoutMs = 5_000, fetch, randomBytes, setInterval, clearInterval, log })` returns `{ rng, status(), refresh(), stop() }`. The seams in parentheses are injectable for tests; production uses the real ones.

1. **Start:** rekey immediately with a **local-only** key. Rolls work from the first moment and never wait on the network.
2. **Every `intervalMs`** (the timer is `unref`'d so it never keeps the process alive), call `refresh()`:
   - **In-flight guard:** if the previous fetch hasn't finished, skip this tick.
   - `POST {url}/api/v1/random` with body `{"bytes": 32}`, headers `Authorization: Bearer <key>` and `Content-Type: application/json`, and an `AbortController` timeout of `timeoutMs`.
   - **On success:** the response is 2xx JSON with a string `data` that base64url-decodes to **exactly 32 bytes**. Then `rekey(seed, meta)` using `environmentalInput` from the response for the display metadata.
   - **On any failure** (network error, timeout, non-2xx, malformed JSON, missing `data`, wrong length): `rekey(null)`, so the key is fresh and local-only. Log one line with the reason, never the key or the response body. Never throw into the game.
3. **No configuration** (`OBSERVATORY_URL` or `OBSERVATORY_KEY` unset): there's no fetching, but the same timer still rekeys local-only every interval. There is one code path, and the dice behave the same whether or not the Observatory is configured.
4. **`stop()`:** clears the interval and aborts any in-flight fetch. After `stop()` there are no timers or pending requests.

| Situation | Next key | `status().source` |
|---|---|---|
| Startup | Local-only | `local` |
| Fetch succeeded | HKDF(local, salt = Observatory bytes) | `observatory` |
| Fetch failed or timed out | Local-only | `local` |
| Observatory not configured | Local-only, every interval | `local` |

## Part 3: Wiring

**`server/index.js`:**
- `createServer` gains the options `observatoryUrl`, `observatoryKey` and `observatoryIntervalMs`.
- Create the dice source before the `GameService` (`index.js:39`) and pass it in: `new GameService({ db, content, templates, graceMs, rng: dice.rng })`.
- Call `dice.stop()` inside the existing `close()` (`index.js:193`), next to `service.close()`.
- `main` reads `OBSERVATORY_URL`, `OBSERVATORY_KEY` and `OBSERVATORY_INTERVAL_MS` from the environment (alongside the existing reads at `index.js:203-217`).

**`.env.example`:** add these lines:

```
# The Observatory: keys the dice from an external observation service. Leave unset to key locally only.
# OBSERVATORY_URL=https://observatory.elliscode.com
# OBSERVATORY_KEY=
# OBSERVATORY_INTERVAL_MS=60000
```

**Tests:** existing tests keep injecting `scriptedRng` (`test/helpers.js:14`) through `makeService`, so they're unaffected. `createServer` in tests should pass no Observatory URL, so it never makes network calls.

## Part 4: Showing it (the payoff)

- **`GET /api/dice-source`** is public, non-secret, and sent with `Cache-Control: no-store`. It returns `status()`:
  ```json
  { "source": "observatory", "keyedAt": 1792101840000, "observedAt": "2026-10-15T21:04:00Z",
    "sources": [{ "name": "Turtle aquarium", "observationId": "obs_…", "imageUrl": "https://observatory.elliscode.com/observations/…" }] }
  ```
  It never includes key material, seed bytes or the API key. `imageUrl` is passed through only if the Observatory supplies it.
- **A small label** in the DM sidebar and on the player's game screen, refreshed about once a minute:
  - `🐢 Dice keyed by The Observatory · 21:04` (the source name and the observation time, in local time)
  - `Dice keyed locally` when the last key was local-only
- **Out of scope for now:** per-roll labels in the Game Feed, and an observation thumbnail next to the label.

## Part 5: The Observatory contract

This side depends on the Observatory's `POST /api/v1/random`:
- **Request:** `{"bytes": 32}` with `Authorization: Bearer <key>`. Give this app its own named key on the Observatory (e.g. `oneshot:<key>`).
- **Response used:** `data` (base64url, 32 bytes), plus `environmentalInput.sources[]` (`name`, `observationId`, `observedAt`, optional `imageUrl`) for display. Everything else is ignored.
- **Errors** (`401`, `429`, `503`, etc.) all count as a failed fetch and lead to a local-only rekey.

**Cross-repo note:** the Observatory's `docs/INTEGRATION.md` should describe this same construction (HKDF-SHA256, ikm = 32 local bytes, salt = the Observatory's 32 bytes, info `one-and-done/dice/v1`, 32-byte ChaCha20 key, zero IV, rekey on every poll), replacing its earlier `sha256(observatorySeed || local)` description. That edit belongs to the Observatory repo, not this one.

## Part 6: Docs

- The README's Deploy section gains `OBSERVATORY_URL` and `OBSERVATORY_KEY` (optional), with a one-line explanation: dice are keyed from The Observatory when configured, and local-only otherwise.
- `server/observatory-dice.js` opens with a short comment summarizing the construction and the "no entropy credit" statement.

## Part 7: Tests and Acceptance Criteria

New file: `test/observatory-dice.test.js`.

### Cipher interface (RFC 8439 vectors, adapted to OpenSSL)

- **RFC 8439 §2.4.2 keystream:** key `00 01 02 … 1f`, block counter 1, nonce `00 00 00 00 00 00 00 4a 00 00 00 00`. As an OpenSSL IV, that is `01000000` + `000000000000004a00000000`. Encrypt 64 zero bytes and compare the result byte for byte with the RFC's keystream for that block.
- **Block-0 check:** with the same key and nonce, encrypt 128 zero bytes using block counter 0. Bytes 64–127 must equal the counter-1 output above. This proves the generator's zero IV starts at block 0 and the counter increments as expected.

### `rng` validation

- `rng(0)`, `rng(257)`, `rng(1.5)`, `rng(-6)` and `rng('6')` throw a `RangeError` and return immediately (no hang).
- `rng(1)` always returns 1, and `rng(256)` accepts every byte.

### Determinism and mixing (with injected fixed `randomBytes`)

- Same local bytes and same Observatory seed → identical roll sequence.
- Same local bytes, different Observatory seed → different sequence. This proves the turtle changes the stream.
- Same local bytes with `null` versus a real seed → different sequence.
- The HKDF output matches `crypto.hkdfSync` called directly with the same inputs (known-answer check).

### Distribution sanity

- For each of d4, d6, d8, d10, d12 and d20, with real randomness: every face appears and every value stays in `1..sides` over about 10,000 rolls.

### Rekey and buffering

- After a rekey, the next roll comes from the new key's keystream, not leftover bytes. Compare it against a fresh generator built with the same injected inputs.

### Lifecycle (stub `fetch`, injected timer)

- Rolls work before any fetch has completed, and `status().source` is `local`.
- A successful fetch → `source: 'observatory'` with the expected metadata.
- Network error, timeout (the stub never resolves), 401, 429, 503, malformed JSON, missing `data`, and 31- or 33-byte `data` each → a local-only rekey, with no exception reaching the caller.
- A tick that fires while a fetch is still pending is skipped (the stub `fetch` is called once).
- `stop()` aborts the pending fetch (its `AbortSignal` fires) and clears the interval.
- With no URL configured, `fetch` is never called, but rekeys still happen each tick.
- The request carries `Authorization: Bearer <key>` and the body `{"bytes":32}`. Log output never contains the key or the seed bytes.

### API

- `GET /api/dice-source` returns the status shape with `Cache-Control: no-store`, and its body never contains the API key or any seed or key bytes.

### Full suite

- `npm test` passes, and existing tests are unchanged.

### Manual check

1. Run without `OBSERVATORY_URL`. Rolls work, and the label says "Dice keyed locally".
2. Point it at a local Observatory (`http://localhost:3100`) with a valid key. Within a minute the label switches to "keyed by The Observatory".
3. Stop the Observatory. Rolls keep working, and the label falls back to "Dice keyed locally" on the next tick.

## Implementation Approach

1. Write `server/observatory-dice.js` (generator, rekey, lifecycle, status) along with the cipher and validation tests.
2. Add the lifecycle tests with a stub `fetch` and an injected timer.
3. Wire it into `createServer` and `close()`, then add the env reads and the `.env.example` lines.
4. Add `GET /api/dice-source` and the DM and player labels.
5. Update the README, run `npm test`, then do the manual check against a local Observatory.

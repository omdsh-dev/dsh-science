# @deepseek-ai/dsh-session-projection-cache

English | [中文](README.zh.md)

The persisted projection cache (`ctx.sessionProjectionCache`): durable checkpoints of every registered projection unit's state, one record per session on the domain data form (`session_projcache` domain — the shipped json backend lands it beside `workspace.json` under the configured storage root). Design authority: the [session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) (persisted projection cache section).

A stored row `(key → {ver, seq, val})` is a fold shortcut, never an authority. It may be stale (`seq` says exactly how stale), version-incompatible, schema-invalid, or non-canonical; only a row admitted by the live unit may seed a fold. Semantic integrity assumes that the storage record was atomically produced by this cache writer—unit schemas reject malformed state but do not authenticate an otherwise valid forged row. Consequences the implementation commits to:

- **Every automatic write is fail-soft.** A failed durable write logs a warning and keeps the last writer-produced cache cut stale. A live session retains dirty state for the next interval retry; a failed detach retains that exact lifecycle for interval or cold-read retry. When the log revision has advanced beyond that stale cut, the record is a cache miss and the cold path performs a full replay.
- **A `ver` mismatch against the live unit's `stateVersion` discards, never migrates.** A unit bump invalidates its rows at read time; the key refolds from the log.
- **A unit-owned `checkpointStateSchema` rejects invalid private state.** The registry uses it at every persisted-state read face. A rejected row is absent from the zero-I/O listing and pulls a cold read to a full replay; the live path never pays this validation cost.
- **Whole-record writes.** Each write replaces the session's full checkpoint (the registry cut is always complete), snapshotted through the lossless-JSON boundary — a unit state violating the plain-JSON contract fails loud.
- **Records are bound to a durable log revision, not just an id.** Each record stores the source-qualified persistence revision of the exact log it followed; listing and cold reads compare it with the persistence observation they already hold. Recreating an id or swapping a persistence store therefore changes the binding even when header fields collide.
- **The log leads, the cache follows.** Complete checkpoint transactions for one session id are serialized. Each transaction takes its cut after the preceding transaction settles, waits for the exact live or retiring Session lifecycle's persistence drain, then lands the cache row. A crash can leave a revision-mismatched cache cut that is discarded on read, but never a cache cut ahead of the log; an older blocked write cannot replace a newer cut.

## Write policy

Two mandatory points, throttled in between:

| Trigger | Nature |
|---|---|
| `turn/end` | Mandatory — the turn-final value is what cold reads want. |
| Session disposal (detach) | Mandatory — the live-to-cold moment; after it the cold ladder serves this session. |
| `writeEveryEvents` committed events | Config throttle (count). |
| `writeIntervalMs` since the first dirty event | Config throttle (interval). |

Both `Config` fields are required (no defaults): flush cadence is a deployment choice with no universally correct value, stated in cordis.yml.

## Listing read (`cachedSnapshot(snapshot)`)

The zero-I/O rung: whole values viewed straight from the revision-matching stored record (version- and checkpoint-schema-matching keys only), returned only when every served row shares one exact watermark. That common watermark is `asOfSeq`, so a client seeding its per-session value store under higher-seq-wins cannot let an older list block overwrite a newer push frame. `undefined` when no usable record exists (unknown id, unrelated log revision, no admitted rows, or mixed row watermarks); the api-proxy list carrier turns that into an absent column.

## Cold read (`coldSnapshot(id, signal?)`)

The read ladder avoids a full-log load while the checkpoint revision still equals the tail read's revision: cached rows → `sessionProjections.restoreFloor` (the lowest admitted watermark, one event before the first event still needing application) → persistence `readFrom(id, floor)` → `sessionProjections.restore` → fail-soft write-back of the refreshed rows. A rejected private state, changed revision, or overreaching row triggers exactly one authoritative read from seq 0 instead of serving a value from an unproven prefix; this also handles a log shortened by crash repair. No registered units still perform one persistence probe to preserve `not found` and date the empty cut, then serve `{asOfSeq: -1, values: {}}` for an empty log.

`write(session)` queues the serialized checkpoint transaction both mandatory points use; carriers may call it directly (not fail-soft — the fail-soft wrappers own containment). The first transaction for an idle id takes its cut immediately; a queued transaction takes its cut only after its predecessor settles, so it cannot publish an older snapshot later.

## Composition

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

Injects `storageDomain`, `sessionProjections`, `sessionPersistence`, `sessions`. Without this row the projection system runs live-only (watermark cache; cold reads fall back to full log loads wherever a carrier implements them).

## Model Experience

None, as the cache only persists and restores host-side read models of already-logged session state and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the cache never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No eviction or retention surface** — records accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session persistence itself.
- **Interval throttle is per-session coarse** — the timer arms at the first dirty event after a clean write; a steady sub-threshold trickle writes once per interval, not a sliding window.
- **`coldSnapshot` reads are serialized, not deduplicated** — two concurrent cold reads of one session each run the ladder in order; their cache write-backs cannot overtake live checkpoint transactions, but repeated reads still repeat persistence work.

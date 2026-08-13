# science/ — durable Science facts and local Runtime

English | [中文](README.zh.md)

The Science group owns compact, required-on-read records and the host-local Runtime that records environment observations and fresh Python/R runs. The original Session log remains the only durable authority; private process handles and scratch remain operational state.

| Package | Role | ctx key |
|---|---|---|
| [`science-session/`](science-session/README.md) | Versioned Science events, the one strict fold authority, a derived `science` projection, and event-stream invariants | — |
| [`science-runtime/`](science-runtime/README.md) | `ctx.scienceRuntime`: local Conda observation, private scratch, direct argv, exact-Session lifecycle ownership, and durable environment/run mutation | `scienceRuntime` |

The domain fold owns Science transitions; projection code advances that same fold semantics and does not maintain a second provenance state machine. The public package root keeps mutable replay and checkpoint machinery private.

The Runtime observes configured existing prefixes and starts fresh host-local Python/R processes through shared subprocess and sandbox services. It does not manage Conda environments, add a Science tool, preset, prompt, UI, chart, or Outcome consumer. Those later Consumers use the runtime operation instead of duplicating Science Session mutation.

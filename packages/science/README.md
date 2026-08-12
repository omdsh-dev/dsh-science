# science/ — durable Science session facts

English | [中文](README.zh.md)

The Science group owns compact, required-on-read records that identify how a Science session produced runs, chart versions, and published Outcomes. The original Session log remains the only durable authority; projections and future consumers rebuild from those records.

| Package | Role | ctx key |
|---|---|---|
| [`science-session/`](science-session/README.md) | Versioned Science events, the one strict fold authority, a derived `science` projection, and event-stream invariants | — |

The domain fold owns Science transitions; projection code advances that same fold semantics and does not maintain a second provenance state machine. The public package root keeps mutable replay and checkpoint machinery private.

This group contains no interpreter, environment-management, process, tool, or UI implementation. Those responsibilities require separate packages and do not change the Science Session event definitions.

# 0001. Record architecture decisions

- Status: accepted
- Date: 2026-10-23

## Context

The project will be open-sourced and worked on by people and AI agents who were not in the
original discussions. They need the reasons behind choices, not only the code.

## Decision

Record every decision that changes game rules, the wire protocol, storage, Durable Object
layout, deploy flow or licensing as a short ADR in `docs/adr/` (template in the `new-adr`
skill). The longer design discussion lives in the design doc; ADRs link to it.

## Consequences

Small cost per decision. Reviews can ask "where is the ADR?" for rule or protocol changes.

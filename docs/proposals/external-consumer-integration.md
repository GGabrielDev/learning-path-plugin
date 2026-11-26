# Proposal: expose a generic integration contract for external path consumers

## Status

Proposal only. This document does not add a runtime integration or a new
learning methodology to Learning Path.

## Summary

Make Learning Path easier for other LearnHarness plugins to consume by defining
a small, additive, versioned, and domain-agnostic integration contract.

The contract should allow a future plugin-capable LearnHarness SDK to discover
Learning Path capabilities, inspect paths and units, navigate to them, and
associate external plugin-owned records with a path unit. The current host does
not provide first-party plugin-to-plugin services or dependency resolution, so
this proposal intentionally stops at a stable contract and does not use private
host APIs, DOM adapters, shared data files, or direct runtime coupling.

## Motivation

Learning Path already owns useful curriculum state:

- Stable path and unit identities
- Source anchors
- Unit goals and types
- Progression
- Native child-session links
- Plugin-owned path persistence

Other plugins may want to build complementary experiences around that state:

- Assessment and practice tools
- Research or source tools
- Accessibility and presentation tools
- Project or artifact tools
- Analytics and reflection tools

At present, a companion plugin cannot safely consume Learning Path's internal
records without depending on implementation details. Reading private JSON files,
importing bundled code, scraping the UI, or coupling to host-specific navigation
would be fragile and would not be a suitable public dependency boundary.

This proposal makes the existing plugin more extensible without making those
consumer features part of Learning Path itself.

## Design goals

- Remain agnostic to the consumer's pedagogy or domain.
- Be additive to current Learning Path behavior and persisted records.
- Prefer the public LearnHarness plugin SDK and a future host service API.
- Use stable identifiers and validated summaries rather than exposing internal
  storage or mutable implementation objects.
- Keep consumer-owned state in the consumer plugin.
- Make integration optional: Learning Path remains fully functional alone.
- Permit future SDK dependency discovery without requiring it today.
- Make absence, disablement, or incompatibility fail softly.

## Non-goals

This proposal does not add:

- A specific external learning method or mode.
- Scheduling, reminders, spaced review, or streaks.
- Artifact grading or mastery inference.
- A general plugin marketplace or dependency manager.
- Direct writes to the native Knowledge Graph.
- Direct mutation of arbitrary native chats.
- A shared filesystem protocol between plugins.
- A private import path from one plugin bundle into another.
- Arbitrary third-party DOM injection into the Path Hub.

## Proposed capability surface

The exact transport depends on a future LearnHarness SDK feature. The following
is a conceptual public contract, not an assertion that these APIs exist today.

```ts
export const LEARNING_PATH_INTEGRATION_API = 1 as const;

export interface LearningPathIntegration {
  readonly apiVersion: 1;
  getCapabilities(): readonly string[];
  listPaths(): readonly LearningPathSummary[];
  getPath(pathId: string): LearningPathSummary | null;
  listUnits(pathId: string): readonly LearningUnitSummary[];
  getUnit(pathId: string, unitId: string): LearningUnitSummary | null;
  openPath(pathId: string): void;
  openUnit(pathId: string, unitId: string): void;
}

export interface LearningPathSummary {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
  readonly sourceMode: "canonical" | "uploaded";
}

export interface LearningUnitSummary {
  readonly pathId: string;
  readonly unitId: string;
  readonly moduleId: string;
  readonly moduleTitle: string;
  readonly type: string;
  readonly title: string;
  readonly goal: string;
  readonly sourceAnchor?: {
    readonly reference: string;
    readonly chapter?: string;
    readonly section?: string;
    readonly pages?: string;
  };
  readonly progression: "unstarted" | "in_progress" | "consolidated";
}
```

The first version should be read-only and summary-oriented. It should not expose
full path records, internal error ledgers, private chat transcripts, source
contents, or store implementation details.

## Optional generic external references

A later capability may allow a consumer to register a reference owned by that
consumer, without asking Learning Path to interpret it:

```ts
export interface ExternalReference {
  readonly id: string;
  readonly sourcePluginId: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string;
  readonly uri?: string;
  readonly createdAt: string;
}

export interface ExternalReferenceAssociation {
  readonly pathId: string;
  readonly unitId: string;
  readonly reference: ExternalReference;
}
```

The `kind` field must remain opaque to Learning Path. A consumer may use values
such as `submission`, `observation`, or `review`, but Learning Path should not
add special cases for them. The core plugin may display a generic reference,
while the consumer remains responsible for its contents and lifecycle.

This should be a separate capability, not required for the initial read-only
contract. It should use explicit ownership and validation, and should never
allow a consumer to overwrite Learning Path state.

## Future SDK relationship

The current LearnHarness host does not provide a first-party plugin-to-plugin
service registry or dependency resolver. Therefore this proposal should not
pretend that a manifest dependency can be made functional inside the plugin
alone.

A future SDK could provide something like:

```ts
ctx.plugins.registerService({
  id: "learning-path",
  apiVersion: 1,
  service,
});
```

and consumers could request it through a documented host API:

```ts
const learningPath = await ctx.plugins.getService<LearningPathIntegration>(
  "learning-path",
  { minApiVersion: 1 },
);
```

The exact SDK names are intentionally deferred. The important requirements are:

- Host-mediated lookup, not direct plugin imports.
- Explicit service/API versioning.
- Capability discovery.
- Activation-order handling.
- Clear behavior when the provider is absent or disabled.
- No access to private plugin storage.
- No assumption that a plugin's UI bundle is loaded in the same context.

If the SDK later adds manifest dependency metadata, it should complement—not
replace—the runtime capability handshake. A dependency declaration alone cannot
provide a safe service contract.

## Compatibility and migration

The initial implementation in Learning Path should be documentation and design
work, followed by an additive internal adapter when the SDK exposes a suitable
service mechanism.

Requirements:

- Existing `LearningPath` and `PathNode` records remain valid unchanged.
- Existing views and actions behave exactly as before.
- Missing integration support is treated as normal, not as a data error.
- Consumer calls receive immutable validated summaries.
- Unknown future fields are ignored by older consumers.
- The API version is independent of the Learning Path plugin release number.
- Feature capabilities can be checked individually so the contract can grow
  without forcing all consumers to upgrade together.

## Security and privacy boundaries

The integration must not expose more than a consumer needs:

- Do not expose full transcripts by default.
- Do not expose uploaded source contents through path summaries.
- Do not expose private store paths or host-reserved files.
- Do not grant consumers arbitrary write access to paths.
- Keep external records in the consumer's own storage.
- Treat navigation as an explicit host action, not a private route.
- Validate IDs and bound response sizes at the provider boundary.

## Suggested implementation sequence

1. Agree on terminology and stable identifiers.
2. Document the conceptual capability contract in the plugin repository.
3. Identify the minimum LearnHarness SDK additions needed for a host-mediated
   plugin service registry.
4. Add provider-side adapters only after the SDK contract exists.
5. Add contract tests using a fake host service rather than a real companion
   plugin.
6. Add an example consumer fixture that only reads summaries and navigates.
7. Consider generic external references as a separate follow-up capability.

## Acceptance criteria for a future implementation

- No ultralearning- or consumer-specific code is added to Learning Path.
- No private DOM, filesystem, or bundled-module coupling is required.
- The provider can run with no consumer installed.
- A consumer can discover API version and capabilities.
- A consumer can list paths and units using validated summaries.
- A consumer can navigate to a path or unit through a documented host action.
- Existing path files pass unchanged through load, save, and export flows.
- Provider and consumer behavior is covered by contract tests.
- Missing, disabled, or incompatible services fail without affecting Learning
  Path operation.

## Open questions

- Should the host service registry be part of SDK v1 compatibility or a later
  SDK version?
- Should navigation return a promise or be a fire-and-forget host action?
- Should path/unit summaries include child-session IDs, or should session links
  be a separate capability?
- Should generic external references be stored by Learning Path or only indexed
  by it?
- What permission or consent model should apply to cross-plugin reads?
- Should the host support optional dependencies, capability requirements, or
  only runtime service discovery?

## Rationale

The key boundary is that Learning Path should expose **curriculum primitives**,
not adopt every workflow that can use them. A small, versioned, host-mediated,
read-only integration surface preserves the plugin's current scope while making
future companion plugins possible and keeping the design close to the base
LearnHarness SDK.

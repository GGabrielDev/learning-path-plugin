/** Learning Path — versioned, atomic persistence under `ctx.dataDirectory`.
 *
 * Owns exactly these files:
 *   paths/<pathId>.json      versioned path records, one file per path
 *   learning-paths.json      legacy path records, migrated into paths/ on open
 *   settings.json            versioned plugin settings
 *   architect.json           chosen Architect model (needed to re-register)
 *   sources/<sourceId>.md    converted learner uploads (UUID names only)
 *   sources/index.json       versioned upload metadata, for hash deduplication
 *   workspaces/<pathId>/manifest.json  versioned per-path workspace index
 *   workspaces/<pathId>/files/<itemId>.md  workspace item content (UUID names)
 * Workspaces materialize lazily on the first item of a path and are additive:
 * nothing here is required for paths or settings to round-trip. Only the
 * explicit `paths.delete` flow removes a workspace directory; nothing else
 * ever does. Host-reserved `agents/`, `tasks/` and `usage.jsonl` are never
 * read or written.
 *
 * Writes go to a same-directory temporary file, are fsynced and renamed over the
 * target, so a crash never leaves a half-written store. Reads validate the schema
 * version and every record: corrupt JSON, invalid records and newer schema versions
 * throw instead of being overwritten, because the learner's data cannot be rebuilt.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DomainValidationError,
  MAX_WORKSPACE_NOTE_BYTES,
  THINKING_LEVELS,
  isSourceId,
  parseLearningPath,
  parsePluginSettings,
  parseUploadedSourceReference,
  parseWorkspaceItem,
  parseWorkspaceManifest,
  validateLearningPath,
} from "./domain.ts";
import type {
  LearningPath,
  PluginSettings,
  ThinkingLevelName,
  UploadedSourceReference,
  WorkspaceItem,
  WorkspaceManifest,
} from "./domain.ts";

export const STORE_SCHEMA_VERSION = 1;
export const PATHS_DIRECTORY = "paths";
export const LEARNING_PATHS_FILE = "learning-paths.json";
export const LEARNING_PATHS_BACKUP_FILE = "learning-paths.json.backup";
export const SETTINGS_FILE = "settings.json";
export const ARCHITECT_FILE = "architect.json";
export const SOURCES_DIRECTORY = "sources";
export const SOURCE_INDEX_FILE = "index.json";
export const WORKSPACES_DIRECTORY = "workspaces";
export const WORKSPACE_MANIFEST_FILE = "manifest.json";
export const WORKSPACE_FILES_DIRECTORY = "files";
/** Frontend conversion is bounded; this is the backend's own last line of defence. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Thinking levels are part of the validated domain contract. */
export { THINKING_LEVELS };
export type { ThinkingLevelName } from "./domain.ts";

/** The Architect definition needs an explicit model, which survives restart in
 * `architect.json`; plugin settings may override it through the Settings page. */
export interface ArchitectModelConfig {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevel?: ThinkingLevelName;
}

export interface SavedSource {
  readonly reference: UploadedSourceReference;
  /** True when identical Markdown was already stored; no new file was written. */
  readonly deduplicated: boolean;
}
/** Host services own these; the plugin must never touch them. */
export const HOST_RESERVED_ENTRIES = ["agents", "tasks", "usage.jsonl"] as const;

export type StoreErrorCode = "corrupt" | "newer-schema" | "unsupported-schema" | "unsafe" | "io";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
    this.code = code;
  }
}

export function defaultSettings(): PluginSettings {
  return { artifactDefaults: {} };
}

/** UUID-only source ids keep converted uploads inside `sources/`. */
export function assertSourceId(value: unknown): string {
  if (!isSourceId(value)) {
    throw new StoreError("io", "Invalid source ID: expected a UUID.");
  }
  return value.toLowerCase();
}

interface PathsFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly paths: readonly LearningPath[];
}

interface PathRecordFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly path: LearningPath;
}

interface SettingsFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly settings: PluginSettings;
}

interface SourceIndexFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly sources: readonly UploadedSourceReference[];
}

interface ArchitectFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly model: ArchitectModelConfig;
}

function asRecord(value: unknown, filename: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: expected a JSON object. No data was changed.`);
  }
  return value as Record<string, unknown>;
}

function readJsonFile(filename: string): unknown | undefined {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    throw new StoreError("unsafe", `Refusing to follow symlinked Learning Path file: ${filename}. No data was changed.`);
  }
  if (!stat.isFile()) {
    throw new StoreError("corrupt", `Learning Path path is not a regular file: ${filename}. No data was changed.`);
  }
  const text = fs.readFileSync(filename, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: invalid JSON. No data was changed.`);
  }
}

function readSchemaVersion(record: Record<string, unknown>, filename: string): number {
  const version = record.schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: missing schema version. No data was changed.`);
  }
  if ((version as number) > STORE_SCHEMA_VERSION) {
    throw new StoreError(
      "newer-schema",
      `Learning Path data at ${filename} uses newer schema version ${version}; this plugin supports ${STORE_SCHEMA_VERSION}. No data was changed.`,
    );
  }
  if (version !== STORE_SCHEMA_VERSION) {
    throw new StoreError(
      "unsupported-schema",
      `Learning Path data at ${filename} uses unsupported schema version ${version}. No data was changed.`,
    );
  }
  return version;
}

function readRevision(record: Record<string, unknown>, filename: string): number {
  const revision = record.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: invalid revision. No data was changed.`);
  }
  return revision as number;
}

const PATH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Resolve one path's file strictly inside `pathsDirectory`, refusing traversal. */
function pathFilename(pathsDirectory: string, id: string): string {
  if (!PATH_ID_PATTERN.test(id) || id.includes("..")) {
    throw new StoreError("unsafe", `Invalid Learning Path id: ${JSON.stringify(id)}. No data was changed.`);
  }
  const base = path.resolve(pathsDirectory);
  const filename = path.resolve(base, `${id}.json`);
  if (!filename.startsWith(`${base}${path.sep}`)) {
    throw new StoreError("unsafe", `Refusing to resolve Learning Path file outside ${base}: ${filename}. No data was changed.`);
  }
  return filename;
}

function loadPathRecordFile(filename: string): { path: LearningPath; revision: number } {
  const raw = readJsonFile(filename);
  if (raw === undefined) {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: file disappeared. No data was changed.`);
  }
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  const result = validateLearningPath(record.path);
  if (!result.ok) {
    const issue = result.issues[0];
    throw new StoreError(
      "corrupt",
      `Learning Path data at ${filename} is corrupt: path ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}. No data was changed.`,
    );
  }
  return { path: result.value, revision };
}

function loadPathsFile(filename: string): { paths: LearningPath[]; revision: number } {
  const raw = readJsonFile(filename);
  if (raw === undefined) return { paths: [], revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  if (!Array.isArray(record.paths)) {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: paths must be an array. No data was changed.`);
  }
  const seen = new Set<string>();
  const paths = record.paths.map((value, index) => {
    const result = validateLearningPath(value);
    if (!result.ok) {
      const issue = result.issues[0];
      throw new StoreError(
        "corrupt",
        `Learning Path data at ${filename} is corrupt: paths[${index}] ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}. No data was changed.`,
      );
    }
    if (seen.has(result.value.id)) {
      throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: duplicate path id "${result.value.id}". No data was changed.`);
    }
    seen.add(result.value.id);
    return result.value;
  });
  return { paths, revision };
}

function loadSettingsFile(filename: string): { settings: PluginSettings; revision: number } {
  const raw = readJsonFile(filename);
  if (raw === undefined) return { settings: defaultSettings(), revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  try {
    return { settings: parsePluginSettings(record.settings), revision };
  } catch {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: invalid settings. No data was changed.`);
  }
}

/** Validate the persisted Architect model; same guards as any other store file. */
function parseArchitectModel(value: unknown): ArchitectModelConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Architect model must be an object.");
  }
  const record = value as Record<string, unknown>;
  const readText = (candidate: unknown, field: string): string => {
    if (typeof candidate !== "string") throw new Error(`Architect model ${field} must be a string.`);
    if (!candidate.trim() || candidate !== candidate.trim()) {
      throw new Error(`Architect model ${field} must be non-blank without surrounding whitespace.`);
    }
    if (candidate.length > 200) throw new Error(`Architect model ${field} is too long.`);
    return candidate;
  };
  const model: ArchitectModelConfig = {
    provider: readText(record.provider, "provider"),
    id: readText(record.id, "id"),
    ...(record.thinkingLevel === undefined
      ? {}
      : {
          thinkingLevel: (() => {
            const level = record.thinkingLevel;
            if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
              throw new Error(`Architect model thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}.`);
            }
            return level as ThinkingLevelName;
          })(),
        }),
  };
  return model;
}

function loadArchitectFile(filename: string): { model: ArchitectModelConfig | null; revision: number } {
  const raw = readJsonFile(filename);
  if (raw === undefined) return { model: null, revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  try {
    return { model: parseArchitectModel(record.model), revision };
  } catch {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: invalid Architect model. No data was changed.`);
  }
}

function loadSourceIndex(directory: string): { sources: UploadedSourceReference[]; revision: number } {
  const filename = path.join(directory, SOURCE_INDEX_FILE);
  const raw = readJsonFile(filename);
  if (raw === undefined) return { sources: [], revision: 0 };
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const revision = readRevision(record, filename);
  if (!Array.isArray(record.sources)) {
    throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: sources must be an array. No data was changed.`);
  }
  const seen = new Set<string>();
  const sources = record.sources.map((entry, index) => {
    let parsed: UploadedSourceReference;
    try {
      parsed = parseUploadedSourceReference(entry);
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      const issue = error.issues[0];
      throw new StoreError(
        "corrupt",
        `Learning Path data at ${filename} is corrupt: sources[${index}] ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}. No data was changed.`,
      );
    }
    if (seen.has(parsed.sourceId)) {
      throw new StoreError("corrupt", `Learning Path data at ${filename} is corrupt: duplicate source id "${parsed.sourceId}". No data was changed.`);
    }
    seen.add(parsed.sourceId);
    return parsed;
  });
  return { sources, revision };
}

/** Resolve one path's workspace directory strictly inside `workspacesDirectory`,
 * refusing traversal. Workspace ids reuse the path-id pattern: they name a
 * directory, one per path. */
function workspaceFilename(workspacesDirectory: string, id: string): string {
  if (!PATH_ID_PATTERN.test(id) || id.includes("..")) {
    throw new StoreError("unsafe", `Invalid Learning Path id: ${JSON.stringify(id)}. No data was changed.`);
  }
  const base = path.resolve(workspacesDirectory);
  const filename = path.resolve(base, id);
  if (!filename.startsWith(`${base}${path.sep}`)) {
    throw new StoreError(
      "unsafe",
      `Refusing to resolve workspace directory outside ${base}: ${filename}. No data was changed.`,
    );
  }
  return filename;
}

/** Read and validate one workspace manifest; absent file reads as no workspace. */
function loadWorkspaceManifest(manifestFilename: string, expectedPathId: string): WorkspaceManifest | null {
  const raw = readJsonFile(manifestFilename);
  if (raw === undefined) return null;
  const record = asRecord(raw, manifestFilename);
  readSchemaVersion(record, manifestFilename);
  let manifest: WorkspaceManifest;
  try {
    manifest = parseWorkspaceManifest(record);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    const issue = error.issues[0];
    throw new StoreError(
      "corrupt",
      `Learning Path data at ${manifestFilename} is corrupt: manifest ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}. No data was changed.`,
    );
  }
  if (manifest.pathId !== expectedPathId) {
    throw new StoreError(
      "corrupt",
      `Learning Path data at ${manifestFilename} is corrupt: manifest pathId "${manifest.pathId}" does not match the directory "${expectedPathId}". No data was changed.`,
    );
  }
  return manifest;
}

/** Content files are named `<itemId>.md`, so item ids must be UUIDs like sources. */
function assertWorkspaceItemId(value: unknown): string {
  if (typeof value !== "string" || !isSourceId(value)) {
    throw new StoreError("io", "Invalid workspace item ID: expected a UUID.");
  }
  return value;
}

/** Best-effort directory fsync so the rename itself is durable after a crash. */
function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some platforms/filesystems reject directory fsync; the rename is still atomic.
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore a failing close of the best-effort descriptor.
      }
    }
  }
}

/** Write a complete file atomically; on failure the previous bytes and temp cleanup win. */
function atomicWrite(filename: string, content: string): void {
  const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new StoreError("unsafe", `Refusing to overwrite symlinked Learning Path file: ${filename}. No data was changed.`);
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore; the original error is more useful.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface LearningPathStore {
  /** Absolute data directory this store owns. */
  readonly directory: string;
  paths(): readonly LearningPath[];
  path(id: string): LearningPath | null;
  /** Validate and atomically create/update one path, keyed by path id. */
  savePath(value: unknown): LearningPath;
  deletePath(id: string): boolean;
  settings(): PluginSettings;
  saveSettings(value: unknown): PluginSettings;
  /** The explicit model the Path Architect definition is registered with. */
  architectModel(): ArchitectModelConfig | null;
  saveArchitectModel(value: unknown): ArchitectModelConfig;
  /** Stored uploads with metadata; unindexed `.md` files are listed too. */
  sources(): readonly UploadedSourceReference[];
  /** Store converted Markdown, deduplicating identical content by SHA-256 + size. */
  saveSource(value: unknown): SavedSource;
  writeSource(sourceId: string, markdown: string): void;
  readSource(sourceId: string): string | null;
  removeSource(sourceId: string): void;
  listSourceIds(): readonly string[];
  /** The path's workspace manifest, or null before the first item materializes
   * it. Links to nodes the path no longer has are dropped at read; the item
   * itself is always kept. */
  workspace(pathId: string): WorkspaceManifest | null;
  /** Validate and append one workspace item, materializing the workspace
   * lazily. Content-bearing kinds (note, session_artifact, code) need their
   * Markdown content; kind "source" references the global sources store and
   * carries none. Returns the stored item. */
  saveWorkspaceItem(pathId: string, value: unknown, content?: string): WorkspaceItem;
  /** Update only an item's learner-visible metadata: title, caption and links. */
  updateWorkspaceItemMeta(pathId: string, itemId: string, value: unknown): WorkspaceItem;
  /** Remove one item and its content file; false when the item is unknown. */
  deleteWorkspaceItem(pathId: string, itemId: string): boolean;
  /** Item content verbatim; null for missing items, source items or no file. */
  readWorkspaceItemContent(pathId: string, itemId: string): string | null;
}

/**
 * Open the store for one `ctx.dataDirectory`.
 * Throws `StoreError` for corrupt/unsafe/newer data before anything is written.
 */
export function openLearningPathStore(dataDirectory: string): LearningPathStore {
  const directory = path.resolve(dataDirectory);
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) {
    throw new StoreError("io", `Learning Path data directory is not a directory: ${directory}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const pathsDirectory = path.join(directory, PATHS_DIRECTORY);
  const workspacesDirectory = path.join(directory, WORKSPACES_DIRECTORY);
  const legacyPathsFilename = path.join(directory, LEARNING_PATHS_FILE);
  const backupPathsFilename = path.join(directory, LEARNING_PATHS_BACKUP_FILE);
  const settingsFilename = path.join(directory, SETTINGS_FILE);
  const architectFilename = path.join(directory, ARCHITECT_FILE);
  const sourcesDirectory = path.join(directory, SOURCES_DIRECTORY);

  const ensurePathsDirectory = (): void => {
    const pathsStat = fs.lstatSync(pathsDirectory, { throwIfNoEntry: false });
    if (pathsStat?.isSymbolicLink()) {
      throw new StoreError(
        "unsafe",
        `Refusing to follow symlinked Learning Path directory: ${pathsDirectory}. No data was changed.`,
      );
    }
    if (pathsStat && !pathsStat.isDirectory()) {
      throw new StoreError(
        "corrupt",
        `Learning Path paths entry is not a directory: ${pathsDirectory}. No data was changed.`,
      );
    }
    if (!pathsStat) fs.mkdirSync(pathsDirectory, { recursive: true, mode: 0o700 });
  };

  const loadedPaths = ((): { paths: LearningPath[]; revisions: Map<string, number> } => {
    const pathsStat = fs.lstatSync(pathsDirectory, { throwIfNoEntry: false });
    if (pathsStat?.isSymbolicLink()) {
      throw new StoreError(
        "unsafe",
        `Refusing to follow symlinked Learning Path directory: ${pathsDirectory}. No data was changed.`,
      );
    }
    if (pathsStat && !pathsStat.isDirectory()) {
      throw new StoreError(
        "corrupt",
        `Learning Path paths entry is not a directory: ${pathsDirectory}. No data was changed.`,
      );
    }

    const paths: LearningPath[] = [];
    const revisions = new Map<string, number>();
    if (pathsStat) {
      const entries = fs
        .readdirSync(pathsDirectory, { withFileTypes: true })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.name.endsWith(".tmp") || !entry.name.endsWith(".json")) continue;
        const filename = path.join(pathsDirectory, entry.name);
        const loaded = loadPathRecordFile(filename);
        pathFilename(pathsDirectory, loaded.path.id);
        if (`${loaded.path.id}.json` !== entry.name) {
          throw new StoreError(
            "corrupt",
            `Learning Path data at ${filename} is corrupt: path id "${loaded.path.id}" does not match filename. No data was changed.`,
          );
        }
        paths.push(loaded.path);
        revisions.set(loaded.path.id, loaded.revision);
      }
    }
    return { paths, revisions };
  })();

  let pathsState = loadedPaths.paths;
  const revisions = loadedPaths.revisions;

  const legacyStat = fs.lstatSync(legacyPathsFilename, { throwIfNoEntry: false });
  const legacyState = legacyStat ? loadPathsFile(legacyPathsFilename) : null;

  // `workspaces/` is additive: when present it must be a real directory the
  // store owns, never a symlink pointing elsewhere.
  const workspacesStat = fs.lstatSync(workspacesDirectory, { throwIfNoEntry: false });
  if (workspacesStat?.isSymbolicLink()) {
    throw new StoreError(
      "unsafe",
      `Refusing to follow symlinked Learning Path directory: ${workspacesDirectory}. No data was changed.`,
    );
  }
  if (workspacesStat && !workspacesStat.isDirectory()) {
    throw new StoreError(
      "corrupt",
      `Learning Path workspaces entry is not a directory: ${workspacesDirectory}. No data was changed.`,
    );
  }

  let settingsState = loadSettingsFile(settingsFilename);
  let architectState = loadArchitectFile(architectFilename);
  let sourceState = loadSourceIndex(sourcesDirectory);

  if (legacyState) {
    const known = new Set(pathsState.map((candidate) => candidate.id));
    const legacyRevision = Math.max(1, legacyState.revision);
    const pending = legacyState.paths
      .filter((candidate) => !known.has(candidate.id))
      .map((legacyPath) => ({ legacyPath, filename: pathFilename(pathsDirectory, legacyPath.id) }));
    if (pending.length > 0) ensurePathsDirectory();
    for (const { legacyPath, filename } of pending) {
      atomicWrite(
        filename,
        serialize({
          schemaVersion: STORE_SCHEMA_VERSION,
          revision: legacyRevision,
          path: legacyPath,
        } satisfies PathRecordFile),
      );
      pathsState.push(legacyPath);
      revisions.set(legacyPath.id, legacyRevision);
      known.add(legacyPath.id);
    }
    fs.renameSync(legacyPathsFilename, backupPathsFilename);
  }

  const sourceFilename = (sourceId: string): string =>
    path.join(sourcesDirectory, `${assertSourceId(sourceId)}.md`);

  const isStoredSource = (sourceId: string): boolean => {
    const fileStat = fs.lstatSync(sourceFilename(sourceId), { throwIfNoEntry: false });
    return Boolean(fileStat?.isFile() && !fileStat.isSymbolicLink());
  };

  const writeSourceIndex = (sources: UploadedSourceReference[]): void => {
    fs.mkdirSync(sourcesDirectory, { recursive: true, mode: 0o700 });
    atomicWrite(
      path.join(sourcesDirectory, SOURCE_INDEX_FILE),
      serialize({
        schemaVersion: STORE_SCHEMA_VERSION,
        revision: sourceState.revision + 1,
        sources,
      } satisfies SourceIndexFile),
    );
    sourceState = { sources, revision: sourceState.revision + 1 };
  };

  /** Indexed uploads that still have their file, plus Markdown written directly. */
  const listSources = (): UploadedSourceReference[] => {
    const indexed = sourceState.sources.filter((source) => isStoredSource(source.sourceId));
    const known = new Set(indexed.map((source) => source.sourceId));
    const orphans = listSourceIdsImpl()
      .filter((sourceId) => !known.has(sourceId))
      .map((sourceId) => {
        const filename = sourceFilename(sourceId);
        const fileStat = fs.statSync(filename);
        return {
          sourceId,
          name: `${sourceId}.md`,
          uploadedAt: fileStat.mtime.toISOString(),
          byteSize: fileStat.size,
        } satisfies UploadedSourceReference;
      });
    return [...indexed, ...orphans];
  };

  const listSourceIdsImpl = (): string[] => {
    const entries = fs.existsSync(sourcesDirectory)
      ? fs.readdirSync(sourcesDirectory, { withFileTypes: true })
      : [];
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -".md".length))
      .filter((candidate) => isSourceId(candidate))
      .map((candidate) => candidate.toLowerCase())
      .sort();
  };

  const writeSourceFile = (sourceId: string, markdown: string): void => {
    const id = assertSourceId(sourceId);
    if (typeof markdown !== "string") {
      throw new StoreError("io", "Converted source Markdown must be a string.");
    }
    fs.mkdirSync(sourcesDirectory, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(sourcesDirectory, `${id}.md`), markdown);
  };

  /** Workspace item ids are UUIDs, so `files/<id>.md` stays traversal-free. */
  const workspaceContentFile = (pathId: string, itemId: string): string =>
    path.join(workspaceFilename(workspacesDirectory, pathId), WORKSPACE_FILES_DIRECTORY, `${itemId}.md`);

  /** Every directory on a workspace's path must be a real, owned directory. */
  const ensureWorkspaceDirectories = (pathId: string): string => {
    const workspacesStat = fs.lstatSync(workspacesDirectory, { throwIfNoEntry: false });
    if (workspacesStat?.isSymbolicLink()) {
      throw new StoreError(
        "unsafe",
        `Refusing to follow symlinked Learning Path directory: ${workspacesDirectory}. No data was changed.`,
      );
    }
    if (workspacesStat && !workspacesStat.isDirectory()) {
      throw new StoreError(
        "corrupt",
        `Learning Path workspaces entry is not a directory: ${workspacesDirectory}. No data was changed.`,
      );
    }
    const dir = workspaceFilename(workspacesDirectory, pathId);
    const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (dirStat?.isSymbolicLink()) {
      throw new StoreError(
        "unsafe",
        `Refusing to follow symlinked workspace directory: ${dir}. No data was changed.`,
      );
    }
    if (dirStat && !dirStat.isDirectory()) {
      throw new StoreError(
        "corrupt",
        `Learning Path workspace entry is not a directory: ${dir}. No data was changed.`,
      );
    }
    if (!dirStat) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filesDirectory = path.join(dir, WORKSPACE_FILES_DIRECTORY);
    const filesStat = fs.lstatSync(filesDirectory, { throwIfNoEntry: false });
    if (filesStat?.isSymbolicLink()) {
      throw new StoreError(
        "unsafe",
        `Refusing to follow symlinked workspace directory: ${filesDirectory}. No data was changed.`,
      );
    }
    if (filesStat && !filesStat.isDirectory()) {
      throw new StoreError(
        "corrupt",
        `Learning Path workspace entry is not a directory: ${filesDirectory}. No data was changed.`,
      );
    }
    if (!filesStat) fs.mkdirSync(filesDirectory, { recursive: true, mode: 0o700 });
    return dir;
  };

  const workspaceManifestFilename = (pathId: string): string =>
    path.join(workspaceFilename(workspacesDirectory, pathId), WORKSPACE_MANIFEST_FILE);

  /** Real node ids of one path; also the guard against orphaned workspaces. */
  const nodeIdsForPath = (pathId: string): Set<string> => {
    const learningPath = pathsState.find((candidate) => candidate.id === pathId);
    if (!learningPath) {
      throw new StoreError("io", `Unknown learning path "${pathId}". No data was changed.`);
    }
    return new Set(learningPath.modules.flatMap((module) => module.nodes.map((node) => node.id)));
  };

  /** Links are validated against real node ids on every write; at read a link
   * to a node the path no longer has is dropped with the item kept — never
   * data loss. "space" links are workspace-level and always kept. */
  const assertLinksResolve = (item: WorkspaceItem, nodeIds: Set<string>): void => {
    for (const [index, link] of item.links.entries()) {
      if (link.to !== "space" && !nodeIds.has(link.to)) {
        throw new DomainValidationError([
          { path: `item "${item.id}".links[${index}].to`, message: `unknown node id "${link.to}"` },
        ]);
      }
    }
  };

  const writeWorkspaceManifest = (manifest: WorkspaceManifest): void => {
    ensureWorkspaceDirectories(manifest.pathId);
    atomicWrite(workspaceManifestFilename(manifest.pathId), serialize(manifest));
  };

  /** Content-bearing kinds own a file under `files/`; kind "source" references
   * the global sources store and must not carry one. */
  const requiresContentFile = (kind: WorkspaceItem["kind"]): boolean => kind !== "source";

  return {
    directory,

    paths: () => pathsState,

    path(id) {
      return pathsState.find((candidate) => candidate.id === id) ?? null;
    },

    savePath(value) {
      const parsed = parseLearningPath(value);
      const filename = pathFilename(pathsDirectory, parsed.id);
      ensurePathsDirectory();
      const nextRevision = (revisions.get(parsed.id) ?? 0) + 1;
      atomicWrite(
        filename,
        serialize({
          schemaVersion: STORE_SCHEMA_VERSION,
          revision: nextRevision,
          path: parsed,
        } satisfies PathRecordFile),
      );
      const index = pathsState.findIndex((candidate) => candidate.id === parsed.id);
      pathsState =
        index === -1
          ? [...pathsState, parsed]
          : pathsState.map((candidate, position) => (position === index ? parsed : candidate));
      revisions.set(parsed.id, nextRevision);
      return parsed;
    },

    deletePath(id) {
      const index = pathsState.findIndex((candidate) => candidate.id === id);
      if (index === -1) return false;
      const filename = pathFilename(pathsDirectory, id);
      const fileStat = fs.lstatSync(filename, { throwIfNoEntry: false });
      if (fileStat?.isSymbolicLink()) {
        throw new StoreError(
          "unsafe",
          `Refusing to delete symlinked Learning Path file: ${filename}. No data was changed.`,
        );
      }
      // Deleting a path deletes its workspace: one learner decision, guarded by
      // the explicit flow reaching here. Nothing else ever removes a workspace.
      const workspaceDirectory = workspaceFilename(workspacesDirectory, id);
      const workspaceStat = fs.lstatSync(workspaceDirectory, { throwIfNoEntry: false });
      if (workspaceStat?.isSymbolicLink()) {
        throw new StoreError(
          "unsafe",
          `Refusing to delete symlinked workspace directory: ${workspaceDirectory}. No data was changed.`,
        );
      }
      if (workspaceStat && !workspaceStat.isDirectory()) {
        throw new StoreError(
          "corrupt",
          `Learning Path workspace entry is not a directory: ${workspaceDirectory}. No data was changed.`,
        );
      }
      try {
        fs.unlinkSync(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      syncDirectory(pathsDirectory);
      if (workspaceStat) {
        fs.rmSync(workspaceDirectory, { recursive: true, force: true });
        syncDirectory(workspacesDirectory);
      }
      pathsState = pathsState.filter((candidate) => candidate.id !== id);
      revisions.delete(id);
      return true;
    },

    settings: () => settingsState.settings,

    saveSettings(value) {
      const parsed = parsePluginSettings(value);
      atomicWrite(
        settingsFilename,
        serialize({
          schemaVersion: STORE_SCHEMA_VERSION,
          revision: settingsState.revision + 1,
          settings: parsed,
        } satisfies SettingsFile),
      );
      settingsState = { settings: parsed, revision: settingsState.revision + 1 };
      return parsed;
    },

    architectModel: () => architectState.model,

    saveArchitectModel(value) {
      const parsed = parseArchitectModel(value);
      atomicWrite(
        architectFilename,
        serialize({
          schemaVersion: STORE_SCHEMA_VERSION,
          revision: architectState.revision + 1,
          model: parsed,
        } satisfies ArchitectFile),
      );
      architectState = { model: parsed, revision: architectState.revision + 1 };
      return parsed;
    },

    sources: () => listSources(),

    saveSource(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("io", "A source upload needs an object with name and markdown.");
      }
      const record = value as Record<string, unknown>;
      const name = record.name;
      const markdown = record.markdown;
      if (typeof name !== "string") {
        throw new StoreError("io", "A source upload needs a non-blank name.");
      }
      if (typeof markdown !== "string" || markdown.trim().length === 0) {
        throw new StoreError("io", "Converted source Markdown must be a non-empty string.");
      }
      const byteSize = Buffer.byteLength(markdown, "utf8");
      if (byteSize > MAX_SOURCE_BYTES) {
        throw new StoreError("io", `Converted source is ${byteSize} bytes; the limit is ${MAX_SOURCE_BYTES}.`);
      }
      const sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
      // Validate the request before dedupe can short-circuit it.
      const reference = parseUploadedSourceReference({
        sourceId: randomUUID(),
        name,
        uploadedAt: new Date().toISOString(),
        byteSize,
        sha256,
      });

      const duplicate = sourceState.sources.find(
        (source) =>
          source.sha256 === sha256 &&
          source.byteSize === byteSize &&
          isStoredSource(source.sourceId),
      );
      if (duplicate) return { reference: duplicate, deduplicated: true };

      // Drop stale index rows whose file vanished; they must not shadow a new upload.
      const live = sourceState.sources.filter((source) => isStoredSource(source.sourceId));
      writeSourceFile(reference.sourceId, markdown);
      writeSourceIndex([...live, reference]);
      return { reference, deduplicated: false };
    },

    writeSource(sourceId, markdown) {
      writeSourceFile(sourceId, markdown);
    },

    readSource(sourceId) {
      const id = assertSourceId(sourceId);
      const filename = path.join(sourcesDirectory, `${id}.md`);
      const fileStat = fs.lstatSync(filename, { throwIfNoEntry: false });
      if (!fileStat) return null;
      if (fileStat.isSymbolicLink()) {
        throw new StoreError("unsafe", `Refusing to follow symlinked source file: ${filename}.`);
      }
      if (!fileStat.isFile()) {
        throw new StoreError("corrupt", `Source path is not a regular file: ${filename}.`);
      }
      return fs.readFileSync(filename, "utf8");
    },

    removeSource(sourceId) {
      const id = assertSourceId(sourceId);
      try {
        fs.unlinkSync(sourceFilename(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const remaining = sourceState.sources.filter((source) => source.sourceId !== id);
      if (remaining.length !== sourceState.sources.length) writeSourceIndex(remaining);
    },

    listSourceIds: () => listSourceIdsImpl(),

    workspace(pathId) {
      const manifest = loadWorkspaceManifest(workspaceManifestFilename(pathId), pathId);
      if (!manifest) return null;
      const learningPath = pathsState.find((candidate) => candidate.id === pathId);
      const nodeIds = new Set(
        learningPath?.modules.flatMap((module) => module.nodes.map((node) => node.id)) ?? [],
      );
      return {
        ...manifest,
        items: manifest.items.map((item) => ({
          ...item,
          links: item.links.filter((link) => link.to === "space" || nodeIds.has(link.to)),
        })),
      };
    },

    saveWorkspaceItem(pathId, value, content) {
      nodeIdsForPath(pathId);
      const manifestFilename = workspaceManifestFilename(pathId);
      const manifest = loadWorkspaceManifest(manifestFilename, pathId);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("io", "A workspace item needs an object with kind and title.");
      }
      const input = value as Record<string, unknown>;
      // The store owns id and addedAt when the caller does not supply them;
      // most items carry no links yet.
      const parsed = parseWorkspaceItem({
        ...input,
        links: input.links ?? [],
        id: typeof input.id === "string" ? input.id : randomUUID(),
        addedAt: typeof input.addedAt === "string" ? input.addedAt : new Date().toISOString(),
      });
      const items = manifest?.items ?? [];
      if (items.some((existing) => existing.id === parsed.id)) {
        throw new StoreError(
          "io",
          `Workspace item "${parsed.id}" already exists in path "${pathId}". No data was changed.`,
        );
      }
      const withContent = requiresContentFile(parsed.kind);
      let item = parsed;
      if (withContent) {
        if (typeof content !== "string" || content.length === 0) {
          throw new StoreError("io", `A ${parsed.kind} workspace item needs non-empty Markdown content.`);
        }
        const byteSize = Buffer.byteLength(content, "utf8");
        if (byteSize > MAX_WORKSPACE_NOTE_BYTES) {
          throw new StoreError(
            "io",
            `Workspace item content is ${byteSize} bytes; the limit is ${MAX_WORKSPACE_NOTE_BYTES}. No data was changed.`,
          );
        }
        // The index describes the file that was actually written.
        item = { ...parsed, byteSize, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
      } else if (content !== undefined) {
        throw new StoreError("io", "A source workspace item references sources/ and carries no content file.");
      }
      assertLinksResolve(item, nodeIdsForPath(pathId));
      if (item.kind === "source" && !isStoredSource(item.sourceId!)) {
        throw new StoreError(
          "io",
          `Workspace source item references unknown source "${item.sourceId}". No data was changed.`,
        );
      }
      // Revalidating the whole manifest enforces the 300-item cap and every
      // other workspace invariant on the exact bytes about to be written.
      const nextManifest = parseWorkspaceManifest({
        schemaVersion: STORE_SCHEMA_VERSION,
        pathId,
        updatedAt: new Date().toISOString(),
        items: [...items, item],
      });
      ensureWorkspaceDirectories(pathId);
      if (withContent) {
        atomicWrite(workspaceContentFile(pathId, item.id), content!);
      }
      writeWorkspaceManifest(nextManifest);
      return item;
    },

    updateWorkspaceItemMeta(pathId, itemId, value) {
      nodeIdsForPath(pathId);
      assertWorkspaceItemId(itemId);
      const manifestFilename = workspaceManifestFilename(pathId);
      const manifest = loadWorkspaceManifest(manifestFilename, pathId);
      if (!manifest) {
        throw new StoreError("io", `Path "${pathId}" has no workspace yet. No data was changed.`);
      }
      const index = manifest.items.findIndex((candidate) => candidate.id === itemId);
      if (index === -1) {
        throw new StoreError(
          "io",
          `Workspace item "${itemId}" not found in path "${pathId}". No data was changed.`,
        );
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new StoreError("io", "Workspace item metadata needs an object.");
      }
      const allowed = ["title", "caption", "links"];
      const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
      if (unexpected.length > 0) {
        throw new StoreError(
          "io",
          `Workspace item metadata accepts only ${allowed.join(", ")}; got ${unexpected.join(", ")}. No data was changed.`,
        );
      }
      const input = value as Record<string, unknown>;
      const current = manifest.items[index]!;
      // An explicit null caption clears it; nothing else may unset a field.
      const candidate: Record<string, unknown> = { ...current };
      for (const key of allowed) {
        if (!(key in input)) continue;
        if (key === "caption" && input.caption === null) {
          delete candidate.caption;
          continue;
        }
        candidate[key] = input[key];
      }
      const updated = parseWorkspaceItem(candidate);
      assertLinksResolve(updated, nodeIdsForPath(pathId));
      const nextManifest = parseWorkspaceManifest({
        schemaVersion: STORE_SCHEMA_VERSION,
        pathId,
        updatedAt: new Date().toISOString(),
        items: manifest.items.map((entry, position) => (position === index ? updated : entry)),
      });
      writeWorkspaceManifest(nextManifest);
      return updated;
    },

    deleteWorkspaceItem(pathId, itemId) {
      assertWorkspaceItemId(itemId);
      const manifestFilename = workspaceManifestFilename(pathId);
      const manifest = loadWorkspaceManifest(manifestFilename, pathId);
      if (!manifest) return false;
      const index = manifest.items.findIndex((candidate) => candidate.id === itemId);
      if (index === -1) return false;
      const item = manifest.items[index]!;
      const contentFile = workspaceContentFile(pathId, itemId);
      if (requiresContentFile(item.kind)) {
        const fileStat = fs.lstatSync(contentFile, { throwIfNoEntry: false });
        if (fileStat?.isSymbolicLink()) {
          throw new StoreError("unsafe", `Refusing to delete symlinked workspace file: ${contentFile}.`);
        }
      }
      const nextManifest = parseWorkspaceManifest({
        schemaVersion: STORE_SCHEMA_VERSION,
        pathId,
        updatedAt: new Date().toISOString(),
        items: manifest.items.filter((_, position) => position !== index),
      });
      writeWorkspaceManifest(nextManifest);
      try {
        fs.unlinkSync(contentFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      syncDirectory(path.dirname(contentFile));
      return true;
    },

    readWorkspaceItemContent(pathId, itemId) {
      assertWorkspaceItemId(itemId);
      const manifest = loadWorkspaceManifest(workspaceManifestFilename(pathId), pathId);
      if (!manifest) return null;
      const item = manifest.items.find((candidate) => candidate.id === itemId);
      if (!item || item.kind === "source") return null;
      const filename = workspaceContentFile(pathId, itemId);
      const fileStat = fs.lstatSync(filename, { throwIfNoEntry: false });
      if (!fileStat) return null;
      if (fileStat.isSymbolicLink()) {
        throw new StoreError("unsafe", `Refusing to follow symlinked workspace file: ${filename}.`);
      }
      if (!fileStat.isFile()) {
        throw new StoreError("corrupt", `Workspace path is not a regular file: ${filename}.`);
      }
      return fs.readFileSync(filename, "utf8");
    },
  };
}

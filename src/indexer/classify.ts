import type { FileClassification, FileRole } from '../db/store.js';

/**
 * Classify a discovered file path as project-owned, vendored, generated, or
 * test. The result is stored on `files.role` and used to keep PageRank,
 * top-symbol queries, and search defaults focused on first-party code while
 * still letting users opt into vendored/generated results explicitly.
 *
 * Conservative defaults — when in doubt, return 'project' so we don't quietly
 * hide first-party code. The patterns here are kept tight on purpose; broader
 * heuristics (e.g. "anything inside a directory called `lib`") would cause
 * too many false positives across the polyglot scale-test corpus.
 *
 * The function works purely on the relative path string; no filesystem
 * access. That keeps it cheap to call once per discovered file in the
 * indexer hot loop.
 */

// Vendored dependency directories at any nesting depth. The discovery layer
// already excludes most of these from the glob, but a few make it through
// (e.g. project-local copies of small utilities placed under `lib/vendor/`).
// We still tag those that get past discovery so the stored classification is
// useful even on unusual repo layouts.
const VENDOR_DIR_PATTERNS = [
  /(^|[\\/])vendor[\\/]/i,
  /(^|[\\/])vendored[\\/]/i,
  /(^|[\\/])third[_-]?party[\\/]/i,
  /(^|[\\/])external[\\/]/i,
  /(^|[\\/])node_modules[\\/]/i,
  /(^|[\\/])bower_components[\\/]/i,
  // Common engine-specific vendored locations.
  /(^|[\\/])Engine[\\/]Source[\\/]ThirdParty[\\/]/i,
];

// Generated boilerplate. Filename patterns covering protobuf, Unreal header
// tool, gRPC, gqlgen, and a handful of common code-generators. We also tag
// files that live under a `generated/` directory since most projects put
// emitter output there.
const GENERATED_DIR_PATTERNS = [
  /(^|[\\/])generated[\\/]/i,
  /(^|[\\/])Generated[\\/]/,           // Unreal Engine convention
  /(^|[\\/])\.next[\\/]/,
  /(^|[\\/])\.nuxt[\\/]/,
  /(^|[\\/])__generated__[\\/]/,
];

const GENERATED_FILENAME_PATTERNS = [
  /\.generated\.[a-z]+$/i,
  /\.gen\.[a-z]+$/i,
  /\.pb\.[a-z]+$/i,                    // protobuf .pb.go / .pb.h / .pb.ts
  /\.pb\.go$/,
  /_pb\.[a-z]+$/i,                     // gqlgen / Python grpc style
  /\.min\.(js|css)$/i,
  /\.bundle\.js$/i,
];

// Test directories — exposed for completeness even though we don't yet use
// the 'test' role to filter anywhere. Future work: surface test files in
// `strata_behavior` as a behavioral contract.
const TEST_DIR_PATTERNS = [
  /(^|[\\/])tests?[\\/]/i,
  /(^|[\\/])__tests__[\\/]/,
  /(^|[\\/])spec[\\/]/i,
];

const TEST_FILENAME_PATTERNS = [
  /\.test\.[a-z]+$/i,
  /\.spec\.[a-z]+$/i,
  /_test\.[a-z]+$/i,                   // Go convention: foo_test.go
];

/**
 * Compute classification flags for a discovered file. The role precedence is
 * vendor → generated → test → project. Vendor wins over generated because a
 * generated file inside a vendor tree is still vendored code we don't own;
 * the `is_generated` flag remains true so users can still query for it.
 */
export function classifyFile(relativePath: string): FileClassification {
  const isVendor = VENDOR_DIR_PATTERNS.some(p => p.test(relativePath)) ? 1 : 0;
  const isGenerated = (
    GENERATED_DIR_PATTERNS.some(p => p.test(relativePath)) ||
    GENERATED_FILENAME_PATTERNS.some(p => p.test(relativePath))
  ) ? 1 : 0;
  const isTest = (
    TEST_DIR_PATTERNS.some(p => p.test(relativePath)) ||
    TEST_FILENAME_PATTERNS.some(p => p.test(relativePath))
  );

  let role: FileRole;
  if (isVendor) role = 'vendor';
  else if (isGenerated) role = 'generated';
  else if (isTest) role = 'test';
  else role = 'project';

  return { role, isVendor: isVendor as 0 | 1, isGenerated: isGenerated as 0 | 1 };
}

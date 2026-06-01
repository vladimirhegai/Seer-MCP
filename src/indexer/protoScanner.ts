/**
 * v9 Track-H — minimal .proto file scanner.
 *
 * Parses `service X { rpc Foo(Req) returns (Resp); }` blocks with a small
 * regex pipeline (no tree-sitter dependency) and emits one route per rpc
 * with protocol='grpc', service=X, operation='X/Foo', method=ANY.
 *
 * The .proto file itself is upserted into `files` with language='proto' so
 * routes have a valid file_id to reference. We do not extract symbols or
 * edges from .proto — only routes — keeping the scanner deterministic and
 * limited in scope.
 *
 * Recognized syntax (proto3-friendly):
 *   service UserService {
 *     rpc GetUser   (GetUserRequest) returns (GetUserResponse);
 *     rpc ListUsers (ListUsersRequest) returns (stream User) {
 *       option (google.api.http) = { get: "/v1/users" };
 *     }
 *   }
 *
 * Comments (`//` and `/* * /`) are stripped before parsing so they cannot
 * accidentally satisfy a rpc header pattern.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import glob from 'fast-glob';
import { Store, FileClassification } from '../db/store.js';
import { classifyFile } from './classify.js';

export interface ProtoScanResult {
  filesScanned: number;
  filesIndexed: number;
  filesReusedFromCache: number;
  fileIds: number[];
  servicesFound: number;
  rpcsFound: number;
}

const PROTO_SERVICE_RE = /service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
const PROTO_RPC_RE = /rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)/g;

const PROTO_CLASSIFICATION: FileClassification = {
  role: 'project', isVendor: 0, isGenerated: 0,
};

export async function scanProtoFiles(
  absRoot: string,
  store: Store,
): Promise<ProtoScanResult> {
  const entries = await glob(['**/*.proto'], {
    cwd: absRoot,
    ignore: [
      'node_modules/**', '**/node_modules/**',
      '.git/**', '**/.git/**',
      'dist/**', '**/dist/**',
      'build/**', '**/build/**',
      'out/**', '**/out/**',
      'vendor/**', '**/vendor/**', '**/__pycache__/**',
      '.next/**', '**/.next/**',
    ],
    onlyFiles: true, followSymbolicLinks: false, dot: false,
  });
  entries.sort();
  const fileIds: number[] = [];
  let indexed = 0;
  let reused = 0;
  let services = 0;
  let rpcs = 0;
  for (const rel of entries) {
    const abs = path.join(absRoot, rel);
    let src: string;
    try { src = fs.readFileSync(abs, 'utf8'); }
    catch { continue; }
    const sha = crypto.createHash('sha1').update(src).digest('hex');
    const stripped = stripProtoComments(src);
    const lines = src.split('\n').length;
    const classification = classifyFile(rel) ?? PROTO_CLASSIFICATION;
    const { fileId, unchanged } = store.upsertFileWithCache(
      abs, rel, 'proto', sha, lines, classification,
    );
    fileIds.push(fileId);
    if (unchanged) {
      reused++;
      continue;
    }
    indexed++;
    PROTO_SERVICE_RE.lastIndex = 0;
    let svcMatch: RegExpExecArray | null;
    while ((svcMatch = PROTO_SERVICE_RE.exec(stripped)) !== null) {
      const serviceName = svcMatch[1];
      const body = svcMatch[2];
      const bodyOffset = svcMatch.index + svcMatch[0].indexOf('{') + 1;
      services++;
      PROTO_RPC_RE.lastIndex = 0;
      let rpcMatch: RegExpExecArray | null;
      while ((rpcMatch = PROTO_RPC_RE.exec(body)) !== null) {
        const rpcName = rpcMatch[1];
        const inputType = rpcMatch[2];
        const outputType = rpcMatch[3];
        const lineNo = byteOffsetToLine(stripped, bodyOffset + rpcMatch.index);
        const operation = `${serviceName}/${rpcName}`;
        store.insertRoute(
          fileId,
          'ANY',
          operation,           // path = canonical service/method
          'grpc',              // framework
          null,                // handler_name — handlers live in code, not .proto
          lineNo,
          {
            protocol: 'grpc',
            operation,
            service: serviceName,
            metadataJson: JSON.stringify({
              service: serviceName,
              method: rpcName,
              inputType, outputType,
            }),
          },
        );
        rpcs++;
      }
    }
  }
  return {
    filesScanned: entries.length,
    filesIndexed: indexed,
    filesReusedFromCache: reused,
    fileIds,
    servicesFound: services,
    rpcsFound: rpcs,
  };
}

/** Strip // and /* * / comments while preserving line offsets. */
function stripProtoComments(src: string): string {
  // Block comments: replace with same-length runs of spaces (preserving newlines)
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Line comments: replace from // to end of line with spaces
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

/** 0-indexed line number for a given byte offset in `src`. */
function byteOffsetToLine(src: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

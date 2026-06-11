export type TraceOnErrorCode =
  | 'TEST_FILE_NOT_FOUND'
  | 'PLAYWRIGHT_SPAWN_FAILED'
  | 'TRACE_BACKEND_UNREACHABLE'
  | 'RANKER_TIER1_OVERFLOW'
  | 'EVIDENCE_DIR_WRITE_FAILED'
  // Embedded-collector mode (v0.2.0)
  | 'EMBEDDED_PLATFORM_UNSUPPORTED'
  | 'EMBEDDED_DOWNLOAD_FAILED'
  | 'EMBEDDED_CHECKSUM_MISSING'
  | 'EMBEDDED_CHECKSUM_MISMATCH'
  | 'EMBEDDED_PORT_BUSY'
  | 'EMBEDDED_COLLECTOR_SPAWN_FAILED'
  | 'EMBEDDED_COLLECTOR_DOWN';

/**
 * Structured error type for all TraceOn failures the agent skill should
 * pattern-match on. The MCP layer serialises this as a tool-result error
 * with the shape produced by `toJSON()`.
 */
export class TraceOnError extends Error {
  constructor(
    public readonly code: TraceOnErrorCode,
    message: string,
    public readonly userGuidance: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TraceOnError';
  }

  toJSON(): { code: TraceOnErrorCode; message: string; userGuidance: string } {
    return { code: this.code, message: this.message, userGuidance: this.userGuidance };
  }
}

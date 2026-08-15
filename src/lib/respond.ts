export interface ToolResponse {
  /** The SDK's CallToolResult permits arbitrary extra keys, so this must be indexable. */
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Standard success shape: readable JSON plus the machine-validated structured payload. */
export function ok(payload: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Surface failures as tool errors rather than thrown exceptions so the caller sees the
 * reason (a containment violation, a missing file) and can correct the call.
 */
export function fail(message: string): ToolResponse {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

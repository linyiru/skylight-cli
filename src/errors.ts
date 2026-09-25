export type SkylightErrorCode =
  | 'MISSING_OR_INVALID_TOKEN'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_AUTH_RESPONSE'
  | 'INVALID_APPS_RESPONSE'
  | 'INVALID_ENDPOINTS_RESPONSE'
  | 'INVALID_DEPLOYS_RESPONSE'
  | 'INVALID_TRENDS_RESPONSE'
  | 'INVALID_SUMMARY_RESPONSE'
  | 'INVALID_SOURCE_LOCATIONS_RESPONSE'
  | 'INVALID_DEPLOY_RESPONSE'
  | 'INVALID_DATA_URL'
  | 'MISSING_COMPONENT_TOKEN'
  | 'COMPONENT_SELECTION_REQUIRED'
  | 'COMPONENT_NOT_FOUND'
  | 'INVALID_DURATION'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_LIMIT'
  | 'INVALID_SEARCH'
  | 'INVALID_SORT'
  | 'INVALID_STEP'
  | 'INVALID_ENDPOINT'
  | 'INVALID_DEPLOY_ID';

/** Carries a code and HTTP status only, never tokens or response bodies. */
export class SkylightError extends Error {
  readonly code: SkylightErrorCode;
  readonly status: number | undefined;

  constructor(code: SkylightErrorCode, status?: number) {
    super(`Skylight request failed: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'SkylightError';
    this.code = code;
    this.status = status;
  }
}

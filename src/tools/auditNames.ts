/**
 * Name of the audit-query tool.
 *
 * It lives in its own module so the tool registry can list its requirement without
 * importing the tool itself, which would pull the audit reader into every code path.
 */
export const AUDIT_QUERY_TOOL_NAME = 'eurodns_audit_query';

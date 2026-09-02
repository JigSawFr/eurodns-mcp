/**
 * The two unprefixed tool names some clients require verbatim.
 *
 * Their own module for the reason `auditNames.ts` is: the registry lists their scope
 * requirement before dispatch and should not import the tools to learn their names. Keeping
 * them as constants also makes the one place they are spelled searchable — these are the only
 * names in this server that do not carry the `eurodns_` prefix, and that is worth being able
 * to find.
 */
export const COMPAT_SEARCH_TOOL_NAME = 'search';
export const COMPAT_FETCH_TOOL_NAME = 'fetch';

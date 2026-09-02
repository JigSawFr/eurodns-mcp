/**
 * Name of the portfolio-refresh tool.
 *
 * Its own module for the reason `auditNames.ts` is: the registry lists the tool's scope
 * requirement before dispatch, and importing the tool itself to learn its name would pull the
 * portfolio cache into every code path that only wants the string.
 */
export const PORTFOLIO_REFRESH_TOOL_NAME = 'eurodns_portfolio_refresh';

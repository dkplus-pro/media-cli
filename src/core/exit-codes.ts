export const EXIT_CODES = { OK: 0, UNCAUGHT: 1, USAGE: 2, COMMAND: 3, PLUGIN_RESERVED: 4 } as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

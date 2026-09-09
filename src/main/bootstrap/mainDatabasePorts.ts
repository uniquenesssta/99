// Database handles stay opaque at composition boundaries. SQL and connection
// ownership remain inside the existing database runtimes, which still use their
// legacy driver types. Passing a handle does not transfer its close ownership.
export type DatabaseArgument<Operation extends (...args: never[]) => unknown> =
  (db: unknown, ...args: Parameters<Operation> extends [unknown, ...infer Rest] ? Rest : never) => ReturnType<Operation>;

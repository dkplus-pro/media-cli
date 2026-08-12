export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonSchema | JsonValue[];

export interface JsonSchema {
  readonly [key: string]: JsonValue;
}

export interface RuntimeSchema<T> {
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
}

export function defineSchema<T>(
  jsonSchema: JsonSchema,
  parse: (value: unknown) => T
): RuntimeSchema<T> {
  return { jsonSchema, parse };
}

import { ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/** Validates arguments against the tool input schema (Ajv, cached per tool+version). */
export class ArgValidator {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false });
  private readonly cache = new Map<string, ValidateFunction>();

  constructor() {
    addFormats.default(this.ajv);
  }

  validate(cacheKey: string, schema: Record<string, unknown>, args: unknown): void {
    let fn = this.cache.get(cacheKey);
    if (!fn) {
      try {
        fn = this.ajv.compile(schema);
      } catch (err) {
        throw new ValidationError(msg('proxy.invalidInputSchema', { error: (err as Error).message }));
      }
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(cacheKey, fn);
    }
    if (!fn(args)) {
      const errors = (fn.errors ?? []).slice(0, 10).map((e) => ({
        path: e.instancePath || '/',
        // Ajv messages are library text (English) and are passed through untranslated.
        message: e.message ?? 'invalid',
        ...(e.keyword === 'additionalProperties' ? { field: (e.params as { additionalProperty?: string }).additionalProperty } : {}),
        ...(e.keyword === 'enum' ? { allowed: (e.params as { allowedValues?: unknown[] }).allowedValues } : {}),
      }));
      throw new ValidationError(msg('proxy.invalidArgs'), errors);
    }
  }
}

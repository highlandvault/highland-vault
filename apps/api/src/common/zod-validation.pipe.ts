import type { PipeTransform } from '@nestjs/common';
import type { ValidationIssue } from '@hv/contracts';
import type { z } from 'zod';
import { Errors } from './errors';

/**
 * Validates one controller argument (@Body, @Query, @Param) against a shared
 * contract schema. Failures become 400 VALIDATION_FAILED with per-field issues.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw Errors.validation({ issues });
    }
    return result.data;
  }
}

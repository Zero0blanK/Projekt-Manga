import { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

/**
 * Middleware factory that validates request body or query against a Zod schema.
 * Attaches the parsed (and coerced/defaulted) result to req.validated. Controllers read
 * from req.validated instead of req.body/req.query so they get the actually-validated,
 * type-safe value rather than the raw input.
 */

declare global {
  // Express's own types are declared in a global `namespace`, so augmenting Request means
  // re-opening that namespace — there is no ES-module equivalent to do it any other way.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated?: unknown;
    }
  }
}

function validate(schema: ZodSchema, source: (req: Request) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(source(req));
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: result.error.flatten().fieldErrors,
      });
    }
    req.validated = result.data;
    next();
  };
}

export function validateBody(schema: ZodSchema) {
  // A request sent with no body and no matching Content-Type never reaches
  // express.json(), so req.body is undefined rather than {} — treat that the same as
  // an empty object instead of failing schemas where every field is optional.
  return validate(schema, (req) => req.body ?? {});
}

export function validateQuery(schema: ZodSchema) {
  return validate(schema, (req) => req.query);
}

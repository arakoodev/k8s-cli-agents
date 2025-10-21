import { Request, Response, NextFunction } from 'express';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Wraps async route handlers to catch errors
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      log.error({
        err: error,
        path: req.path,
        method: req.method,
        userId: (req as any).user?.uid
      }, 'Unhandled error in route handler');

      // Don't leak internal errors to client
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal server error',
          requestId: req.id // If using request ID middleware
        });
      }

      next(error);
    });
  };
}

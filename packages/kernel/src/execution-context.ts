/**
 * ExecutionContext — common abstraction for guards, interceptors, tracing, logging.
 * Carries request, route, module, controller, handler, container scope, trace context, metadata.
 */

import type { Container } from "./container.js";

export type ExecutionContextArgs = {
  request: Request;
  route?: { method: string; path: string };
  module?: { name: string };
  controller?: { instance: unknown; method: string; handler: (...args: unknown[]) => unknown };
  container?: Container;
  traceId?: string;
  metadata?: Map<string, unknown>;
};

export class ExecutionContext {
  readonly request: Request;
  readonly route?: { method: string; path: string };
  readonly moduleMeta?: { name: string };
  readonly controller?: {
    instance: unknown;
    method: string;
    handler: (...args: unknown[]) => unknown;
  };
  readonly container?: Container;
  readonly traceId?: string;
  readonly metadata: Map<string, unknown>;

  constructor(args: ExecutionContextArgs) {
    this.request = args.request;
    this.route = args.route;
    this.moduleMeta = args.module;
    this.controller = args.controller;
    this.container = args.container;
    this.traceId = args.traceId;
    this.metadata = args.metadata ?? new Map();
  }

  getClass<T = unknown>(): (new (...args: unknown[]) => T) | undefined {
    return this.controller?.instance?.constructor as (new (...args: unknown[]) => T) | undefined;
  }

  getHandler(): ((...args: unknown[]) => unknown) | undefined {
    return this.controller?.handler;
  }

  getRequest(): Request {
    return this.request;
  }

  getRoute(): { method: string; path: string } | undefined {
    return this.route;
  }

  switchToHttp(): { getRequest: () => Request; getResponse?: () => Response | undefined } {
    return { getRequest: () => this.request };
  }
}

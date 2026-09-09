/**
 * @minostack/kernel — deterministic application architecture.
 */

// Tokens & DI
export { createToken, getTokenName, isClassToken, type Token, type TokenBrand } from "./token.js";
export { SCOPE, type Scope } from "./scope.js";
export {
  type Provider,
  type ClassProvider,
  type ValueProvider,
  type FactoryProvider,
  type ExistingProvider,
  type NormalizedProvider,
  normalizeProvider,
} from "./provider.js";
export { Container, setInjectTokens, getInjectTokens } from "./container.js";

// Module system
export {
  module,
  Module,
  defineModule,
  getModuleMetadata,
  type ModuleMetadata,
  type ModuleClass,
} from "./module.js";

// Decorators — lowercase per user preference
export {
  injectable,
  getInjectableOptions,
  type InjectableOptions,
  inject,
  controller,
  getControllerOptions,
  type ControllerOptions,
  get as getDecorator,
  post,
  put,
  del,
  remove,
  patch,
  options,
  head,
  all,
  getRoutes,
  type RouteMeta,
  type RouteMethod,
  useGuards,
  useInterceptors,
  usePipes,
} from "./decorators.js";

// Application
export { Application, type ApplicationOptions } from "./application.js";

// Lifecycle
export {
  type OnInit,
  type OnStart,
  type OnStop,
  type OnDestroy,
  isOnInit,
  isOnStart,
  isOnStop,
  isOnDestroy,
  callOnInit,
  callOnStart,
  callOnStop,
  callOnDestroy,
} from "./lifecycle.js";

// Execution context
export { ExecutionContext, type ExecutionContextArgs } from "./execution-context.js";

// Guards / Pipes / Interceptors
export {
  type Guard,
  type GuardType,
  type PipeTransform,
  type PipeMetadata,
  type Interceptor,
  type CallHandler,
  type InterceptorType,
  runGuards,
  runPipes,
  runInterceptors,
} from "./guards.js";

// Exceptions
export {
  HttpException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
  type ExceptionFilter,
  defaultExceptionFilter,
} from "./exceptions.js";

// Observability
export {
  type Span,
  type Tracer,
  type SpanKind,
  type TraceContext,
  type Instrumentation,
  NoopSpan,
  NoopTracer,
  getTracer,
  setTracer,
  createTraceContext,
  parseTraceparent,
  formatTraceparent,
  resolveTraceContext,
} from "./observability.js";

// Authorization — principal-backed policy guards
export { roleGuard, permissionGuard, tenantGuard, policyGuard } from "./authorization.js";

// Repository + unit-of-work ports
export {
  MemoryRepository,
  MemoryUnitOfWork,
  type Repository,
  type UnitOfWork,
  type Versioned,
} from "./repository.js";

// Testing helpers
export {
  testApp,
  testPrincipal,
  createTestContext,
  fixedClock,
  counterIds,
  fakeFetch,
  type FakeFetchCall,
} from "./testing.js";

// DTO
export {
  createDto,
  getDto,
  listDtos,
  dtoClass,
  type DtoMetadata,
  type DtoKind,
  type InferDto,
} from "./dto.js";

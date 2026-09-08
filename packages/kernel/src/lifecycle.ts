/**
 * Lifecycle contracts — deterministic, explicit.
 * Final names standardized: OnInit, OnStart, OnStop, OnDestroy.
 * Ordering per §23:
 * Bootstrap -> Module Discovery -> Provider Registration -> Graph Resolution -> Container Init -> App Init (OnInit) -> Server Ready (OnStart) -> Request -> Shutdown (OnStop) -> Destroy (OnDestroy)
 */

export interface OnInit {
  onInit(): void | Promise<void>;
}

export interface OnStart {
  onStart(): void | Promise<void>;
}

export interface OnStop {
  onStop(): void | Promise<void>;
}

export interface OnDestroy {
  onDestroy(): void | Promise<void>;
}

export function isOnInit(obj: unknown): obj is OnInit {
  return typeof (obj as OnInit)?.onInit === "function";
}
export function isOnStart(obj: unknown): obj is OnStart {
  return typeof (obj as OnStart)?.onStart === "function";
}
export function isOnStop(obj: unknown): obj is OnStop {
  return typeof (obj as OnStop)?.onStop === "function";
}
export function isOnDestroy(obj: unknown): obj is OnDestroy {
  return typeof (obj as OnDestroy)?.onDestroy === "function";
}

/** Call lifecycle hooks in deterministic order for a list of instances */
export async function callOnInit(instances: unknown[]): Promise<void> {
  for (const inst of instances) if (isOnInit(inst)) await inst.onInit();
}
export async function callOnStart(instances: unknown[]): Promise<void> {
  for (const inst of instances) if (isOnStart(inst)) await inst.onStart();
}
export async function callOnStop(instances: unknown[]): Promise<void> {
  // Reverse order for shutdown
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    if (isOnStop(inst)) await (inst as OnStop).onStop();
  }
}
export async function callOnDestroy(instances: unknown[]): Promise<void> {
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    if (isOnDestroy(inst)) await (inst as OnDestroy).onDestroy();
  }
}
